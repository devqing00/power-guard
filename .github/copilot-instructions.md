# Copilot Instructions - PowerGuard

## Project Intent
PowerGuard is an AI-powered autonomous drone monitoring system for power-line inspection in Nigeria.

The implementation must optimize for:
- Alert speed (fault-to-operator latency)
- Offline resilience (technicians in low-connectivity regions)
- Clear geospatial visibility (coordinates and fault location clarity)

## Build Rules
1. Follow implementation phases exactly.
2. Keep API contracts stable and versioned under `/api/v1`.
3. Use strongly typed schemas at boundaries (Pydantic/TypeScript).
4. Default to production-safe behavior: explicit validation, guarded failures, actionable logs.
5. Do not commit secrets or service account JSON keys.

## Phase Guardrails
- Phase 1: FastAPI baseline + Firebase Admin + `POST /api/v1/telemetry` only.
- Phase 2: YOLO mock/inference + `POST /api/v1/analyze` + drone simulator.
- Phase 3: Frontend Mapbox + Firebase real-time listeners.
- Phase 4: Dashboard widgets + offline persistence + toast alerting.

## UX Priorities for Frontend Phases
1. Dark command-center aesthetics with clear severity signaling.
2. Map-first layout with overlaid floating glass panels.
3. Monospace formatting for telemetry values.
4. Fault status and assignment lifecycle must remain visible at a glance.

## Backend Priorities for Current Phase
1. Stable startup behavior with clear environment validation.
2. Reliable Firestore upsert for drone telemetry.
3. Timestamping and status normalization.
4. CORS enabled for local frontend development.
