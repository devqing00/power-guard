# PowerGuard Agent Operating Rules

## Mission
Deliver PowerGuard as a phase-gated monorepo:
- `frontend/`: Next.js dashboard
- `backend/`: FastAPI AI + telemetry ingestion

## Hard Constraints
1. Do not jump phases. Implement only the active phase unless explicitly instructed.
2. Prioritize low-latency fault alerting, reliability, and operator clarity.
3. Preserve offline resilience for the dashboard and field operations.
4. Use strict contracts between frontend and backend (`/api/v1/*`).
5. Keep secrets out of source control; use `.env` files and examples.

## Delivery Workflow
1. Update task docs before and after implementation.
2. Keep changes focused and incremental.
3. Add clear run/test instructions for each new subsystem.
4. Prefer deterministic defaults and explicit error messages.

## Current Active Phase
Phase 1: Backend Setup & Firebase Admin (FastAPI, CORS, schemas, telemetry endpoint).
