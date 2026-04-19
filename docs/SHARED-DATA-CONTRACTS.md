# PowerGuard Shared Data Contracts

This document defines the stable contracts between the backend API and frontend dashboard.

## 1) API Versioning

- Base prefix: `/api/v1`
- Contract changes must be backward-compatible within `v1`.
- Breaking changes require a new version prefix.

## 2) Telemetry Contract

Endpoint:

- `POST /api/v1/telemetry`

Request body:

```json
{
  "drone_id": "drone_001",
  "lat": 6.5244,
  "lng": 3.3792,
  "battery": 85,
  "altitude": 120,
  "status": "active"
}
```

Field constraints:

- `drone_id`: string, 3-64 chars
- `lat`: number, -90 to 90
- `lng`: number, -180 to 180
- `battery`: number, 0 to 100
- `altitude`: number, optional, default `0.0`
- `status`: one of `active | returning | offline`

Response body:

```json
{
  "success": true,
  "drone_id": "drone_001",
  "message": "Telemetry upserted successfully."
}
```

Firestore write shape (`drones/{drone_id}`):

- `lat`: number
- `lng`: number
- `altitude`: number
- `battery`: number
- `status`: string
- `last_updated`: server timestamp

## 3) Analyze Contract

Endpoint:

- `POST /api/v1/analyze`

Request body:

```json
{
  "drone_id": "drone_001",
  "lat": 6.5244,
  "lng": 3.3792,
  "frame_tag": "drone_001-20260416-001",
  "image_url": "https://example.com/frame.jpg",
  "mock_fault": false
}
```

Field constraints:

- `drone_id`: string, 3-64 chars
- `lat`: number, -90 to 90
- `lng`: number, -180 to 180
- `frame_tag`: string, 3-128 chars
- `image_url`: nullable string
- `mock_fault`: boolean

Response body:

```json
{
  "success": true,
  "drone_id": "drone_001",
  "frame_tag": "drone_001-20260416-001",
  "fault_detected": true,
  "fault_type": "damaged_insulator",
  "severity": "high",
  "confidence": 0.85,
  "fault_id": "abc123",
  "sms_triggered": false,
  "message": "Frame analyzed successfully."
}
```

Enum constraints:

- `fault_type`: `none | damaged_insulator | line_sag | vegetation_encroachment`
- `severity`: `none | low | medium | high | critical`

Firestore write shape (`faults/{fault_id}` when `fault_detected=true`):

- `drone_id`: string
- `frame_tag`: string
- `lat`: number
- `lng`: number
- `fault_type`: string
- `severity`: string
- `confidence`: number in range 0..1
- `status`: `unresolved | assigned | resolved`
- `assignee`: nullable string
- `detected_at`: server timestamp

## 4) Frontend Fault Workflow Contract

Frontend state model:

- `id`: string
- `droneId`: string
- `lat`: number
- `lng`: number
- `faultType`: string
- `severity`: string
- `confidence`: number
- `status`: `unresolved | assigned | resolved`
- `assignee`: nullable string
- `detectedAt`: nullable ISO timestamp

Status updates from frontend:

- Assigned: set `status=assigned`, set `assignee`, set `assigned_at`
- Resolved: set `status=resolved`, preserve assignee, set `resolved_at`
- Reopen: set `status=unresolved`, set `assignee=null`

## 5) Compatibility Rules

- New response fields may be added but existing fields must not change meaning.
- Enum expansions must be reflected in both backend schemas and frontend handling.
- Unknown backend status values must be safely normalized by frontend to `unresolved`.
