from typing import Literal

from pydantic import BaseModel, Field


class TelemetryIn(BaseModel):
    drone_id: str = Field(..., min_length=3, max_length=64)
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    battery: float = Field(..., ge=0, le=100)
    altitude: float = Field(default=0.0)
    status: Literal["active", "returning", "offline"] = "active"


class TelemetryOut(BaseModel):
    success: bool
    drone_id: str
    message: str


FaultType = Literal[
    "none",
    "damaged_insulator",
    "line_sag",
    "vegetation_encroachment",
]
Severity = Literal["none", "low", "medium", "high", "critical"]


class AnalyzeIn(BaseModel):
    drone_id: str = Field(..., min_length=3, max_length=64)
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    frame_tag: str = Field(..., min_length=3, max_length=128)
    image_url: str | None = None
    mock_fault: bool = False


class AnalyzeOut(BaseModel):
    success: bool
    drone_id: str
    frame_tag: str
    fault_detected: bool
    fault_type: FaultType
    severity: Severity
    confidence: float = Field(..., ge=0, le=1)
    fault_id: str | None = None
    sms_triggered: bool = False
    message: str
