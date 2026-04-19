# PowerGuard

PowerGuard is an AI-powered autonomous drone monitoring system for power-line inspection in Nigeria.

## Workspace Structure

- `frontend/` - Next.js dashboard (App Router, TypeScript)
- `backend/` - FastAPI API service for telemetry and AI processing
- `docs/tasks/` - Master board and per-phase execution tracking
- `.github/copilot-instructions.md` - Project guardrails and phase constraints

## Current Phase

Phases 1 through 4 are complete (backend, AI simulation, map dashboard, offline/assignment UX).

## Quality and Operations

- CI workflow: `.github/workflows/ci.yml`
- Deployment and environment runbook: `docs/DEPLOYMENT-ENV-RUNBOOK.md`
- Shared API/data contracts: `docs/SHARED-DATA-CONTRACTS.md`

## Backend Quick Start (Phase 1)

1. Open terminal in `backend/`.
2. Create virtual environment: `python -m venv .venv`.
3. Activate venv (PowerShell): `.venv\Scripts\Activate.ps1`.
4. Install dependencies: `pip install -r requirements.txt`.
5. Create `.env` from `.env.example` and set valid Firebase values.
6. Run API: `uvicorn app.main:app --reload --port 8000`.

## Telemetry Endpoint

`POST /api/v1/telemetry`

Example payload:

```json
{
  "drone_id": "drone_001",
  "lat": 6.5244,
  "lng": 3.3792,
  "battery": 85
}
```

## Notes

- Do not commit service account keys or secrets.
- Keep API under `/api/v1` for stable contract versioning.
- Follow phase gates in `docs/tasks/`.
