# PowerGuard Deployment and Environment Runbook

This runbook defines the minimum environment setup, validation checks, and deployment sequence for the PowerGuard demo stack.

## 1) Required Environment Variables

### Backend (`backend/.env`)

Core app:

- `APP_NAME`
- `APP_ENV`
- `API_V1_PREFIX`
- `FRONTEND_ORIGIN`

Firebase (choose one method):

1. Credentials file method

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CREDENTIALS_PATH`

1. Inline credentials method (recommended for hosted deployments)

- `FIREBASE_PROJECT_ID`
- `FIREBASE_PRIVATE_KEY_ID`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_CLIENT_ID`
- `FIREBASE_CLIENT_X509_CERT_URL`

Analysis and notifications:

- `ANALYZE_USE_MOCK`
- `FAULT_SMS_ENABLED`
- `AFRICASTALKING_USERNAME` (required only when `FAULT_SMS_ENABLED=true`)
- `AFRICASTALKING_API_KEY` (required only when `FAULT_SMS_ENABLED=true`)
- `AFRICASTALKING_SENDER_ID` (optional, provider/account dependent)
- `OPS_PHONE_NUMBER` (required only when `FAULT_SMS_ENABLED=true`)

### Frontend (`frontend/.env.local`)

- `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

## 2) Pre-Deployment Validation

Run from repository root:

1. Backend startup smoke

```powershell
Push-Location backend
python -m uvicorn app.main:app --reload --port 8000
```

Then verify:

```powershell
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8000/healthz"
```

1. API smoke

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/v1/telemetry" -ContentType "application/json" -Body '{"drone_id":"drone_smoke_001","lat":6.5,"lng":3.3,"battery":90}'
```

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/v1/analyze" -ContentType "application/json" -Body '{"drone_id":"drone_smoke_001","image_url":"https://example.com/frame.jpg","lat":6.5,"lng":3.3,"mock_fault":true}'
```

1. Frontend quality gates

```powershell
Push-Location frontend
npm ci
npm run lint
npm run type-check
npm run build
```

## 3) CI Enforcement

GitHub Actions workflow: `.github/workflows/ci.yml`

Checks performed on every push to `main` and all pull requests:

- Backend startup smoke test (`/healthz`)
- Frontend lint
- Frontend type-check
- Frontend production build

## 4) Deployment Sequence

1. Deploy backend first.
2. Verify backend `/healthz` and one `/api/v1/telemetry` write.
3. Deploy frontend with `NEXT_PUBLIC_*` variables.
4. Verify dashboard loads, map initializes, and Firestore listeners receive data.
5. Trigger one mock fault via `/api/v1/analyze` and confirm command-center workflow state updates.

## 5) Rollback Plan

If a release fails:

1. Roll back backend to last known good build.
2. Roll back frontend to last known good build.
3. Keep Firestore data unchanged (no destructive rollback).
4. Re-run smoke checks before re-opening operator access.

## 6) Security Guardrails

- Never commit live service-account JSON keys.
- Keep `.env.example` and `frontend/.env.example` as placeholders only.
- Rotate any key that has ever been exposed in source control or chat logs.
