import logging
import math
import random
import threading
import time
from datetime import UTC, datetime

from firebase_admin import firestore

from app.core.config import Settings, get_settings
from app.core.schemas import AnalyzeIn
from app.services.analyze_service import run_mock_inference
from app.services.firebase_service import get_firestore_client
from app.services.location_service import nearest_location_name
from app.services.notification_service import send_fault_sms

logger = logging.getLogger(__name__)

_sim_thread: threading.Thread | None = None
_stop_event = threading.Event()
_sim_lock = threading.Lock()
_last_error = ""
_runtime_config: dict[str, float | int | str] = {}
_runtime_drones: dict[str, dict[str, object]] = {}

_PRESET_PATHS: list[tuple[str, float, float]] = [
    ("drone_lagos_01", 6.5244, 3.3792),
    ("drone_abuja_02", 9.0765, 7.3986),
    ("drone_portharcourt_03", 4.8156, 7.0498),
    ("drone_kano_04", 12.0022, 8.5920),
]


class DroneControlConflictError(PermissionError):
    pass


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _normalize_operator(operator: str | None) -> str:
    return (operator or "").strip()


def _build_runtime_drones(settings: Settings) -> list[dict[str, object]]:
    drones_per_location = max(1, settings.auto_sim_drones_per_location)
    max_total = max(1, settings.auto_sim_drones)
    runtime: list[dict[str, object]] = []
    for location_id, lat, lng in _PRESET_PATHS:
        for idx in range(drones_per_location):
            if len(runtime) >= max_total:
                break
            runtime.append(
                {
                    "drone_id": f"{location_id}_u{idx + 1:02d}",
                    "lat": lat,
                    "lng": lng,
                    "origin_lat": lat,
                    "origin_lng": lng,
                    "control_mode": "auto",
                    "control_owner": "",
                    "waypoints": [],
                    "heading": random.uniform(0.0, math.tau),
                    "battery": random.uniform(82.0, 98.0),
                    "offset": random.uniform(0.0, math.pi * 2),
                    "tick": 0.0,
                }
            )
        if len(runtime) >= max_total:
            break
    return runtime


def _get_runtime_config(settings: Settings) -> dict[str, float | int | str]:
    return {
        "interval_seconds": settings.auto_sim_interval_seconds,
        "analyze_every": settings.auto_sim_analyze_every,
        "drones": settings.auto_sim_drones,
        "drones_per_location": settings.auto_sim_drones_per_location,
        "movement_scale": settings.auto_sim_movement_scale,
        "location_radius_deg": settings.auto_sim_location_radius_deg,
        "fault_rate": settings.auto_sim_fault_rate,
        "manual_idle_timeout_seconds": settings.auto_sim_manual_idle_timeout_seconds,
        "scenario": "balanced",
    }


def update_runtime_config(**overrides: float | int | str) -> dict[str, object]:
    settings = get_settings()
    with _sim_lock:
        if not _runtime_config:
            _runtime_config.update(_get_runtime_config(settings))

        for key, value in overrides.items():
            if value is None:
                continue
            _runtime_config[key] = value

    return get_auto_simulator_status()


def apply_scenario_preset(name: str) -> dict[str, object]:
    normalized = name.strip().lower().replace(" ", "_")
    presets: dict[str, dict[str, float | int | str]] = {
        "storm_day": {
            "movement_scale": 0.00065,
            "fault_rate": 0.16,
            "analyze_every": 3,
            "location_radius_deg": 0.024,
            "scenario": "storm_day",
        },
        "vegetation_risk": {
            "movement_scale": 0.0005,
            "fault_rate": 0.1,
            "analyze_every": 4,
            "location_radius_deg": 0.02,
            "scenario": "vegetation_risk",
        },
        "high_load_corridor": {
            "movement_scale": 0.0007,
            "fault_rate": 0.12,
            "analyze_every": 3,
            "location_radius_deg": 0.018,
            "scenario": "high_load_corridor",
        },
        "balanced": {
            "movement_scale": 0.00055,
            "fault_rate": 0.08,
            "analyze_every": 4,
            "location_radius_deg": 0.02,
            "scenario": "balanced",
        },
    }

    if normalized not in presets:
        raise ValueError(f"Unknown scenario preset: {name}")

    return update_runtime_config(**presets[normalized])


def _move_drone(drone: dict[str, object], movement_scale: float, location_radius_deg: float) -> None:
    lat = float(drone["lat"])
    lng = float(drone["lng"])
    heading = float(drone["heading"])
    tick = float(drone["tick"]) + 1.0

    heading += random.uniform(-0.14, 0.14)
    speed = movement_scale * (0.85 + 0.3 * math.sin(tick / 7.5 + float(drone["offset"])))
    lat_step = math.sin(heading) * speed
    lng_step = (math.cos(heading) * speed) / max(0.25, math.cos(math.radians(lat)))

    next_lat = lat + lat_step + random.uniform(-movement_scale * 0.07, movement_scale * 0.07)
    next_lng = lng + lng_step + random.uniform(-movement_scale * 0.07, movement_scale * 0.07)

    origin_lat = float(drone["origin_lat"])
    origin_lng = float(drone["origin_lng"])
    radius = max(0.004, location_radius_deg)
    next_lat = _clamp(next_lat, origin_lat - radius, origin_lat + radius)
    next_lng = _clamp(next_lng, origin_lng - radius, origin_lng + radius)

    battery = float(drone["battery"])
    battery = battery - random.uniform(0.05, 0.22)
    if battery < 18:
        battery = random.uniform(78.0, 90.0)

    drone["lat"] = next_lat
    drone["lng"] = next_lng
    drone["heading"] = heading
    drone["battery"] = battery
    drone["tick"] = tick


def _step_toward_waypoint(drone: dict[str, object], target_lat: float, target_lng: float, step_size: float) -> bool:
    lat = float(drone["lat"])
    lng = float(drone["lng"])
    delta_lat = target_lat - lat
    delta_lng = target_lng - lng
    distance = math.hypot(delta_lat, delta_lng)
    if distance <= max(0.00002, step_size):
        drone["lat"] = target_lat
        drone["lng"] = target_lng
        return True

    ratio = step_size / distance
    drone["lat"] = lat + delta_lat * ratio
    drone["lng"] = lng + delta_lng * ratio
    return False


def _serialize_waypoints(waypoints: list[tuple[float, float]]) -> list[dict[str, float]]:
    return [{"lat": round(item[0], 6), "lng": round(item[1], 6)} for item in waypoints]


def _run_loop(settings: Settings) -> None:
    global _last_error, _runtime_drones
    try:
        db = get_firestore_client()
        with _sim_lock:
            if not _runtime_config:
                _runtime_config.update(_get_runtime_config(settings))
            runtime = dict(_runtime_config)

        drones = _build_runtime_drones(settings)
        with _sim_lock:
            _runtime_drones = {str(item["drone_id"]): item for item in drones}
        cycle = 0

        logger.info(
            "Auto patrol simulator started with %s drone(s), interval=%ss, analyze_every=%s.",
            len(drones),
            settings.auto_sim_interval_seconds,
            settings.auto_sim_analyze_every,
        )

        while not _stop_event.is_set():
            cycle += 1
            now = datetime.now(UTC)

            for drone in drones:
                with _sim_lock:
                    runtime = dict(_runtime_config)

                interval_seconds = max(0.25, float(runtime["interval_seconds"]))
                movement_per_tick = max(0.00008, float(runtime["movement_scale"]) * (interval_seconds / 2.0))

                mode = str(drone.get("control_mode", "auto")).lower()
                if mode == "manual":
                    timeout_seconds = max(10.0, float(runtime.get("manual_idle_timeout_seconds", 90)))
                    last_manual_at = float(drone.get("last_manual_command_at", 0.0))
                    if last_manual_at > 0 and (time.time() - last_manual_at) >= timeout_seconds:
                        mode = "auto"
                        drone["control_mode"] = "auto"
                        drone["control_owner"] = ""
                        drone["waypoints"] = []

                if mode == "manual":
                    queue = list(drone.get("waypoints") or [])
                    if queue:
                        target_lat, target_lng = queue[0]
                        reached = _step_toward_waypoint(drone, float(target_lat), float(target_lng), movement_per_tick)
                        if reached:
                            queue.pop(0)
                        drone["waypoints"] = queue
                    else:
                        drone["tick"] = float(drone["tick"]) + 1.0
                else:
                    _move_drone(drone, movement_per_tick, float(runtime["location_radius_deg"]))

                altitude = 84 + math.sin(float(drone["tick"]) / 8 + float(drone["offset"])) * 6
                queue_points = list(drone.get("waypoints") or [])

                db.collection("drones").document(str(drone["drone_id"])).set(
                    {
                        "lat": round(float(drone["lat"]), 6),
                        "lng": round(float(drone["lng"]), 6),
                        "altitude": round(altitude, 1),
                        "battery": round(float(drone["battery"]), 1),
                        "status": "active",
                        "control_mode": str(drone.get("control_mode", "auto")),
                        "control_owner": str(drone.get("control_owner", "")),
                        "waypoint_queue_count": len(queue_points),
                        "waypoint_queue": _serialize_waypoints(queue_points),
                        "last_updated": firestore.SERVER_TIMESTAMP,
                    },
                    merge=True,
                )

                if cycle % max(1, int(runtime["analyze_every"])) != 0:
                    continue

                frame_tag = f"auto-{drone['drone_id']}-{now.strftime('%Y%m%d%H%M%S')}-{cycle}"
                payload = AnalyzeIn(
                    drone_id=str(drone["drone_id"]),
                    lat=round(float(drone["lat"]), 6),
                    lng=round(float(drone["lng"]), 6),
                    frame_tag=frame_tag,
                    image_url=None,
                    mock_fault=random.random() < max(0.0, min(1.0, float(runtime["fault_rate"]))),
                )
                inference = run_mock_inference(payload)

                if not inference.fault_detected:
                    continue

                fault_ref = db.collection("faults").document()
                location_name = nearest_location_name(payload.lat, payload.lng)
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

                send_fault_sms(
                    "PowerGuard fault alert: "
                    f"{inference.fault_type} ({inference.severity}) near "
                    f"{location_name} from {payload.drone_id}."
                )

            base_wait = max(0.25, float(runtime["interval_seconds"]))
            wait_jitter = base_wait * 0.35
            next_wait = random.uniform(max(0.25, base_wait - wait_jitter), base_wait + wait_jitter)
            _stop_event.wait(next_wait)
    except Exception as exc:
        _last_error = str(exc)
        logger.exception("Auto patrol simulator failed: %s", exc)
    finally:
        logger.info("Auto patrol simulator stopped.")


def start_auto_simulator() -> tuple[bool, str]:
    global _sim_thread, _last_error
    with _sim_lock:
        if _sim_thread and _sim_thread.is_alive():
            return False, "already_running"

        _last_error = ""
        _stop_event.clear()
        settings = get_settings()
        _runtime_config.clear()
        _runtime_config.update(_get_runtime_config(settings))
        _sim_thread = threading.Thread(target=_run_loop, args=(settings,), daemon=True)
        _sim_thread.start()
        return True, "started"


def stop_auto_simulator() -> tuple[bool, str]:
    global _sim_thread, _runtime_drones
    with _sim_lock:
        if not _sim_thread or not _sim_thread.is_alive():
            return False, "not_running"

        _stop_event.set()
        _sim_thread.join(timeout=4)
        _sim_thread = None
        _runtime_drones = {}
        return True, "stopped"


def _resolve_drone_context(
    drone_id: str,
) -> tuple[dict[str, object] | None, float, float, float, float, float, str]:
    db = get_firestore_client()

    with _sim_lock:
        runtime_drone = _runtime_drones.get(drone_id)

    if runtime_drone:
        current_lat = float(runtime_drone["lat"])
        current_lng = float(runtime_drone["lng"])
        origin_lat = float(runtime_drone["origin_lat"])
        origin_lng = float(runtime_drone["origin_lng"])
        patrol_radius = float(_runtime_config.get("location_radius_deg", 0.02)) if _runtime_config else 0.02
        owner = str(runtime_drone.get("control_owner", ""))
        return runtime_drone, current_lat, current_lng, origin_lat, origin_lng, patrol_radius, owner

    snapshot = db.collection("drones").document(drone_id).get()
    if not snapshot.exists:
        raise ValueError(f"Unknown drone id: {drone_id}")

    payload = snapshot.to_dict() or {}
    current_lat = float(payload.get("lat", 0.0))
    current_lng = float(payload.get("lng", 0.0))
    origin_lat = current_lat
    origin_lng = current_lng
    patrol_radius = 0.02
    owner = str(payload.get("control_owner", ""))
    return None, current_lat, current_lng, origin_lat, origin_lng, patrol_radius, owner


def _ensure_control_owner(drone_id: str, runtime_drone: dict[str, object] | None, operator: str | None, existing_owner: str) -> str:
    normalized_operator = _normalize_operator(operator)
    if not normalized_operator:
        raise ValueError("operator is required for manual control commands")

    if existing_owner and existing_owner.lower() != normalized_operator.lower():
        raise DroneControlConflictError(f"Drone {drone_id} is currently locked by {existing_owner}")

    if runtime_drone is not None:
        with _sim_lock:
            runtime_drone["control_owner"] = normalized_operator
            runtime_drone["last_manual_command_at"] = time.time()

    return normalized_operator


def _apply_manual_state(
    drone_id: str,
    runtime_drone: dict[str, object] | None,
    next_lat: float,
    next_lng: float,
    owner: str,
    waypoints: list[tuple[float, float]] | None = None,
) -> None:
    db = get_firestore_client()
    now_ts = time.time()

    queue = list(waypoints or [])
    if runtime_drone:
        with _sim_lock:
            runtime_drone["lat"] = next_lat
            runtime_drone["lng"] = next_lng
            runtime_drone["control_mode"] = "manual"
            runtime_drone["control_owner"] = owner
            runtime_drone["last_manual_command_at"] = now_ts
            if waypoints is not None:
                runtime_drone["waypoints"] = queue

    db.collection("drones").document(drone_id).set(
        {
            "lat": round(next_lat, 6),
            "lng": round(next_lng, 6),
            "status": "active",
            "control_mode": "manual",
            "control_owner": owner,
            "waypoint_queue_count": len(queue),
            "waypoint_queue": _serialize_waypoints(queue),
            "last_updated": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


def navigate_drone(drone_id: str, direction: str, meters: float = 35.0, operator: str | None = None) -> dict[str, object]:
    normalized = direction.strip().upper()
    if normalized not in {"N", "S", "E", "W", "NE", "NW", "SE", "SW", "HOLD"}:
        raise ValueError("direction must be one of N,S,E,W,NE,NW,SE,SW,HOLD")

    runtime_drone, current_lat, current_lng, origin_lat, origin_lng, patrol_radius, owner = _resolve_drone_context(drone_id)
    effective_owner = _ensure_control_owner(drone_id, runtime_drone, operator, owner)

    if normalized == "HOLD":
        _apply_manual_state(drone_id, runtime_drone, current_lat, current_lng, effective_owner)
        return {
            "drone_id": drone_id,
            "message": "hold",
            "lat": round(current_lat, 6),
            "lng": round(current_lng, 6),
        }

    distance_m = max(8.0, min(120.0, meters))
    lat_step = distance_m / 111320.0
    lng_step = distance_m / max(38000.0, 111320.0 * math.cos(math.radians(current_lat)))

    lat_factor = 0.0
    lng_factor = 0.0
    if "N" in normalized:
        lat_factor += 1.0
    if "S" in normalized:
        lat_factor -= 1.0
    if "E" in normalized:
        lng_factor += 1.0
    if "W" in normalized:
        lng_factor -= 1.0

    next_lat = current_lat + lat_step * lat_factor
    next_lng = current_lng + lng_step * lng_factor
    next_lat = _clamp(next_lat, origin_lat - patrol_radius, origin_lat + patrol_radius)
    next_lng = _clamp(next_lng, origin_lng - patrol_radius, origin_lng + patrol_radius)

    _apply_manual_state(drone_id, runtime_drone, next_lat, next_lng, effective_owner)

    return {
        "drone_id": drone_id,
        "message": "moved",
        "lat": round(next_lat, 6),
        "lng": round(next_lng, 6),
    }


def queue_drone_waypoints(
    drone_id: str,
    waypoints: list[tuple[float, float]],
    operator: str,
    replace: bool = False,
) -> dict[str, object]:
    runtime_drone, current_lat, current_lng, origin_lat, origin_lng, patrol_radius, owner = _resolve_drone_context(drone_id)
    effective_owner = _ensure_control_owner(drone_id, runtime_drone, operator, owner)

    normalized_points: list[tuple[float, float]] = []
    for lat, lng in waypoints:
        next_lat = _clamp(float(lat), origin_lat - patrol_radius, origin_lat + patrol_radius)
        next_lng = _clamp(float(lng), origin_lng - patrol_radius, origin_lng + patrol_radius)
        normalized_points.append((next_lat, next_lng))

    existing_points = list(runtime_drone.get("waypoints") or []) if runtime_drone else []
    queue = normalized_points if replace else [*existing_points, *normalized_points]

    _apply_manual_state(drone_id, runtime_drone, current_lat, current_lng, effective_owner, queue)

    return {
        "drone_id": drone_id,
        "message": "waypoints_queued",
        "waypoint_count": len(queue),
    }


def navigate_drone_to(drone_id: str, lat: float, lng: float, operator: str | None = None) -> dict[str, object]:
    response = queue_drone_waypoints(drone_id, [(lat, lng)], operator or "", replace=False)
    return {
        "drone_id": drone_id,
        "message": "waypoint_set",
        "waypoint_count": response["waypoint_count"],
    }


def return_drone_to_origin(drone_id: str, operator: str) -> dict[str, object]:
    runtime_drone, current_lat, current_lng, origin_lat, origin_lng, _, owner = _resolve_drone_context(drone_id)
    effective_owner = _ensure_control_owner(drone_id, runtime_drone, operator, owner)
    _apply_manual_state(drone_id, runtime_drone, current_lat, current_lng, effective_owner, [(origin_lat, origin_lng)])
    return {
        "drone_id": drone_id,
        "message": "returning_to_origin",
        "origin_lat": round(origin_lat, 6),
        "origin_lng": round(origin_lng, 6),
    }


def cancel_drone_waypoints(drone_id: str, operator: str) -> dict[str, object]:
    runtime_drone, current_lat, current_lng, _, _, _, owner = _resolve_drone_context(drone_id)
    effective_owner = _ensure_control_owner(drone_id, runtime_drone, operator, owner)
    _apply_manual_state(drone_id, runtime_drone, current_lat, current_lng, effective_owner, [])
    return {
        "drone_id": drone_id,
        "message": "waypoints_cleared",
    }


def set_drone_mode(drone_id: str, mode: str, operator: str | None = None) -> dict[str, object]:
    normalized_mode = mode.strip().lower()
    if normalized_mode not in {"auto", "manual"}:
        raise ValueError("mode must be one of auto or manual")

    db = get_firestore_client()
    runtime_drone, current_lat, current_lng, _, _, _, owner = _resolve_drone_context(drone_id)

    if normalized_mode == "manual":
        effective_owner = _ensure_control_owner(drone_id, runtime_drone, operator, owner)
        _apply_manual_state(drone_id, runtime_drone, current_lat, current_lng, effective_owner)
        return {
            "drone_id": drone_id,
            "mode": "manual",
            "control_owner": effective_owner,
        }

    operator_name = _normalize_operator(operator)
    if owner and operator_name and owner.lower() != operator_name.lower():
        raise DroneControlConflictError(f"Drone {drone_id} is currently locked by {owner}")

    with _sim_lock:
        if runtime_drone is not None:
            runtime_drone["control_mode"] = "auto"
            runtime_drone["control_owner"] = ""
            runtime_drone["waypoints"] = []

    db.collection("drones").document(drone_id).set(
        {
            "control_mode": "auto",
            "control_owner": "",
            "waypoint_queue_count": 0,
            "waypoint_queue": [],
            "last_updated": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    return {
        "drone_id": drone_id,
        "mode": "auto",
        "control_owner": "",
    }


def release_drone_control(drone_id: str, operator: str) -> dict[str, object]:
    normalized_operator = _normalize_operator(operator)
    if not normalized_operator:
        raise ValueError("operator is required")

    db = get_firestore_client()
    runtime_drone, _, _, _, _, _, owner = _resolve_drone_context(drone_id)

    if owner and owner.lower() != normalized_operator.lower():
        raise DroneControlConflictError(f"Drone {drone_id} is currently locked by {owner}")

    with _sim_lock:
        if runtime_drone is not None:
            runtime_drone["control_owner"] = ""

    db.collection("drones").document(drone_id).set(
        {
            "control_owner": "",
            "last_updated": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    return {
        "drone_id": drone_id,
        "control_owner": "",
    }


def get_auto_simulator_status() -> dict[str, object]:
    settings = get_settings()
    running = bool(_sim_thread and _sim_thread.is_alive())
    with _sim_lock:
        config = dict(_runtime_config) if _runtime_config else _get_runtime_config(settings)
    return {
        "running": running,
        "interval_seconds": round(float(config["interval_seconds"]), 3),
        "analyze_every": int(config["analyze_every"]),
        "drones": int(config["drones"]),
        "drones_per_location": int(config["drones_per_location"]),
        "movement_scale": float(config["movement_scale"]),
        "location_radius_deg": float(config["location_radius_deg"]),
        "fault_rate": float(config["fault_rate"]),
        "manual_idle_timeout_seconds": int(config.get("manual_idle_timeout_seconds", 90)),
        "scenario": str(config["scenario"]),
        "last_error": _last_error or None,
    }
