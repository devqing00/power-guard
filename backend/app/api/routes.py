import logging

from fastapi import APIRouter, HTTPException
from firebase_admin import firestore
from pydantic import BaseModel, Field

from app.core.schemas import AnalyzeIn, AnalyzeOut, TelemetryIn, TelemetryOut
from app.services.analyze_service import run_mock_inference
from app.services.auto_sim_service import (
    DroneControlConflictError,
    apply_scenario_preset,
    cancel_drone_waypoints,
    get_auto_simulator_status,
    navigate_drone,
    navigate_drone_to,
    queue_drone_waypoints,
    release_drone_control,
    return_drone_to_origin,
    set_drone_mode,
    start_auto_simulator,
    stop_auto_simulator,
    update_runtime_config,
)
from app.services.demo_data_service import clear_live_demo_data, seed_team_roster
from app.services.firebase_service import get_firestore_client
from app.services.location_service import nearest_location_name
from app.services.notification_service import send_fault_sms

router = APIRouter()
logger = logging.getLogger(__name__)


class WaypointItem(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class WaypointQueueRequest(BaseModel):
    drone_id: str
    operator: str
    replace: bool = False
    waypoints: list[WaypointItem]


@router.post("/telemetry", response_model=TelemetryOut)
def ingest_telemetry(payload: TelemetryIn) -> TelemetryOut:
    try:
        db = get_firestore_client()
        drone_ref = db.collection("drones").document(payload.drone_id)

        drone_ref.set(
            {
                "lat": payload.lat,
                "lng": payload.lng,
                "altitude": payload.altitude,
                "battery": payload.battery,
                "status": payload.status,
                "last_updated": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        return TelemetryOut(
            success=True,
            drone_id=payload.drone_id,
            message="Telemetry upserted successfully.",
        )
    except FileNotFoundError as exc:
        logger.error("Firebase credentials error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.error("Firebase configuration error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to ingest telemetry for drone '%s'.", payload.drone_id)
        raise HTTPException(
            status_code=500,
            detail="Failed to process telemetry payload.",
        ) from exc


@router.post("/analyze", response_model=AnalyzeOut)
def analyze_frame(payload: AnalyzeIn) -> AnalyzeOut:
    try:
        db = get_firestore_client()
        inference = run_mock_inference(payload)

        fault_id = None
        sms_triggered = False
        if inference.fault_detected:
            location_name = nearest_location_name(payload.lat, payload.lng)
            fault_ref = db.collection("faults").document()
            fault_ref.set(
                {
                    "drone_id": payload.drone_id,
                    "frame_tag": payload.frame_tag,
                    "lat": payload.lat,
                    "lng": payload.lng,
                    "fault_type": inference.fault_type,
                    "severity": inference.severity,
                    "confidence": inference.confidence,
                    "location_name": location_name,
                    "status": "unresolved",
                    "detected_at": firestore.SERVER_TIMESTAMP,
                }
            )
            fault_id = fault_ref.id
            sms_triggered = send_fault_sms(
                "PowerGuard fault alert: "
                f"{inference.fault_type} ({inference.severity}) "
                f"near {location_name} from {payload.drone_id}."
            )

        return AnalyzeOut(
            success=True,
            drone_id=payload.drone_id,
            frame_tag=payload.frame_tag,
            fault_detected=inference.fault_detected,
            fault_type=inference.fault_type,
            severity=inference.severity,
            confidence=inference.confidence,
            fault_id=fault_id,
            sms_triggered=sms_triggered,
            message="Frame analyzed successfully.",
        )
    except FileNotFoundError as exc:
        logger.error("Firebase credentials error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.error("Firebase configuration error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to analyze frame for drone '%s'.", payload.drone_id)
        raise HTTPException(
            status_code=500,
            detail="Failed to analyze frame payload.",
        ) from exc


@router.get("/simulator/status")
def simulator_status() -> dict[str, object]:
    return get_auto_simulator_status()


@router.post("/simulator/start")
def simulator_start() -> dict[str, object]:
    started, message = start_auto_simulator()
    return {
        "success": started,
        "message": message,
        "status": get_auto_simulator_status(),
    }


@router.post("/simulator/stop")
def simulator_stop() -> dict[str, object]:
    stopped, message = stop_auto_simulator()
    return {
        "success": stopped,
        "message": message,
        "status": get_auto_simulator_status(),
    }


@router.post("/simulator/scenario")
def simulator_scenario(name: str) -> dict[str, object]:
    try:
        status = apply_scenario_preset(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "success": True,
        "message": f"Scenario '{name}' applied.",
        "status": status,
    }


@router.post("/simulator/navigate")
def simulator_navigate(drone_id: str, direction: str, meters: float = 35.0, operator: str | None = None) -> dict[str, object]:
    try:
        payload = navigate_drone(drone_id=drone_id, direction=direction, meters=meters, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DroneControlConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "success": True,
        "message": "Drone command applied.",
        "result": payload,
    }


@router.post("/simulator/mode")
def simulator_mode(drone_id: str, mode: str, operator: str | None = None) -> dict[str, object]:
    try:
        payload = set_drone_mode(drone_id=drone_id, mode=mode, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DroneControlConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "success": True,
        "message": "Drone mode updated.",
        "result": payload,
    }


@router.post("/simulator/waypoint")
def simulator_waypoint(drone_id: str, lat: float, lng: float, operator: str | None = None) -> dict[str, object]:
    try:
        payload = navigate_drone_to(drone_id=drone_id, lat=lat, lng=lng, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DroneControlConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "success": True,
        "message": "Drone waypoint applied.",
        "result": payload,
    }


@router.post("/simulator/waypoint-queue")
def simulator_waypoint_queue(payload: WaypointQueueRequest) -> dict[str, object]:
    if len(payload.waypoints) == 0:
        raise HTTPException(status_code=400, detail="at least one waypoint is required")

    try:
        result = queue_drone_waypoints(
            drone_id=payload.drone_id,
            waypoints=[(item.lat, item.lng) for item in payload.waypoints],
            operator=payload.operator,
            replace=payload.replace,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DroneControlConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "success": True,
        "message": "Waypoint queue updated.",
        "result": result,
    }


@router.post("/simulator/return-origin")
def simulator_return_origin(drone_id: str, operator: str) -> dict[str, object]:
    try:
        result = return_drone_to_origin(drone_id=drone_id, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DroneControlConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "success": True,
        "message": "Drone return-to-origin queued.",
        "result": result,
    }


@router.post("/simulator/cancel-waypoints")
def simulator_cancel_waypoints(drone_id: str, operator: str) -> dict[str, object]:
    try:
        result = cancel_drone_waypoints(drone_id=drone_id, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DroneControlConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "success": True,
        "message": "Drone waypoint queue cleared.",
        "result": result,
    }


@router.post("/simulator/release-control")
def simulator_release_control(drone_id: str, operator: str) -> dict[str, object]:
    try:
        result = release_drone_control(drone_id=drone_id, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DroneControlConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "success": True,
        "message": "Drone control lock released.",
        "result": result,
    }


@router.post("/simulator/manual-timeout")
def simulator_manual_timeout(seconds: int) -> dict[str, object]:
    if seconds < 10 or seconds > 1800:
        raise HTTPException(status_code=400, detail="seconds must be between 10 and 1800")

    status = update_runtime_config(manual_idle_timeout_seconds=seconds)
    return {
        "success": True,
        "message": "Manual idle timeout updated.",
        "status": status,
    }


@router.post("/demo/reset")
def reset_demo_data(clear_team: bool = False) -> dict[str, object]:
    cleared = clear_live_demo_data(clear_team=clear_team)
    return {
        "success": True,
        "message": "Live demo data cleared.",
        "cleared": cleared,
    }


@router.post("/demo/seed-team")
def seed_demo_team() -> dict[str, object]:
    created = seed_team_roster()
    return {
        "success": True,
        "message": "Sample team roster ready.",
        "created": created,
    }
