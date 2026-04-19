# Phase 2 - AI & Simulation Pipeline

## Objective
Add frame analysis flow and drone simulator for continuous telemetry + detection testing.

## Planned Items
- [x] Integrate YOLOv8 model loading (real or mock)
- [x] Implement `POST /api/v1/analyze`
- [x] Write detected faults to Firestore `faults` collection
- [x] Trigger SMS via Africa's Talking service
- [x] Build `backend/scripts/drone_sim.py` to send telemetry and frames every 3 seconds

## Gate
Begin only after Phase 1 acceptance is complete.
