import hashlib
import time
from dataclasses import dataclass

from app.core.config import get_settings
from app.core.schemas import AnalyzeIn, FaultType, Severity


@dataclass
class InferenceResult:
    fault_detected: bool
    fault_type: FaultType
    severity: Severity
    confidence: float


_last_fault_at_by_drone: dict[str, float] = {}


def _severity_for_confidence(confidence: float) -> Severity:
    if confidence >= 0.9:
        return "critical"
    if confidence >= 0.75:
        return "high"
    if confidence >= 0.55:
        return "medium"
    return "low"


def run_mock_inference(payload: AnalyzeIn) -> InferenceResult:
    settings = get_settings()
    rounded_lat = round(payload.lat, 3)
    rounded_lng = round(payload.lng, 3)
    area_bucket = int(time.time() // 300)
    token = f"{payload.drone_id}:{rounded_lat}:{rounded_lng}:{area_bucket}".encode("utf-8")
    digest = hashlib.sha256(token).digest()
    score = digest[0] / 255.0

    if payload.mock_fault:
        score = max(score, 0.84)

    threshold = max(0.0, min(1.0, 1.0 - settings.analyze_fault_probability))
    active_threshold = 0.82 if payload.mock_fault else threshold
    if score < active_threshold:
        return InferenceResult(
            fault_detected=False,
            fault_type="none",
            severity="none",
            confidence=round(min(0.79, score), 3),
        )

    now = time.time()
    cooldown_seconds = max(0, settings.analyze_fault_cooldown_seconds)
    previous_fault_at = _last_fault_at_by_drone.get(payload.drone_id)
    if previous_fault_at and now - previous_fault_at < cooldown_seconds:
        return InferenceResult(
            fault_detected=False,
            fault_type="none",
            severity="none",
            confidence=round(min(0.78, score), 3),
        )

    _last_fault_at_by_drone[payload.drone_id] = now

    fault_labels: list[FaultType] = [
        "damaged_insulator",
        "line_sag",
        "vegetation_encroachment",
    ]
    fault_type = fault_labels[digest[1] % len(fault_labels)]

    return InferenceResult(
        fault_detected=True,
        fault_type=fault_type,
        severity=_severity_for_confidence(score),
        confidence=round(max(0.72, score), 3),
    )
