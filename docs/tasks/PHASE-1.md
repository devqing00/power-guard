# Phase 1 - Backend Setup & Firebase Admin

## Objective
Deliver a stable FastAPI service that ingests telemetry and upserts drone state into Firestore.

## Scope
- FastAPI structure and startup
- CORS middleware
- Environment/config validation
- Firebase Admin initialization
- `POST /api/v1/telemetry`

## Out of Scope
- YOLO inference
- Analyze endpoint
- Simulator loop
- Frontend rendering and Mapbox wiring

## Work Items
- [x] Scaffold backend package layout and app entrypoint
- [x] Add settings/config module and `.env` support
- [x] Add Firebase Admin client singleton
- [x] Add telemetry schemas and route handler
- [x] Add error handling and structured logs
- [x] Add requirements and setup docs

## Detailed Execution Checklist
1. Create `backend/app/main.py` with:
- App factory
- CORS for local frontend origin
- Router registration under `/api/v1`
- Health endpoint
2. Create `backend/app/core/config.py` with:
- Pydantic settings model
- Required fields for Firebase credentials/project
- Environment defaults and validation
3. Create `backend/app/services/firebase_service.py` with:
- Lazy singleton initialization
- Validation for service account path and project id
- Firestore client getter
4. Create telemetry API in `backend/app/api/routes.py` with:
- Pydantic request model
- Upsert to `drones/{drone_id}`
- `last_updated` server timestamp
- `status` default fallback
5. Add `backend/requirements.txt` and `backend/.env.example`.
6. Add backend run instructions in a root-level setup section.

## Acceptance Criteria
- [x] FastAPI runs with `uvicorn app.main:app --reload` from `backend`.
- [x] `POST /api/v1/telemetry` validates payload and returns success JSON.
- [x] Firestore document is written/updated under `drones` collection.
- [x] Missing or invalid Firebase config returns clear startup/runtime errors.

## Verification Commands
- `python -m venv .venv`
- `.venv\Scripts\Activate.ps1`
- `pip install -r requirements.txt`
- `uvicorn app.main:app --reload --port 8000`
- `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/v1/telemetry -ContentType 'application/json' -Body '{"drone_id":"drone_001","lat":6.5244,"lng":3.3792,"battery":85}'`
