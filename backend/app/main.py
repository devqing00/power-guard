import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app.core.config import get_settings
from app.services.auto_sim_service import stop_auto_simulator, start_auto_simulator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

settings = get_settings()

app = FastAPI(title=settings.app_name, version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_checks() -> None:
    firebase_ok, firebase_message = settings.firebase_ready()
    if firebase_ok:
        logger.info("Firebase configuration validated successfully.")
    else:
        logger.warning(
            "Firebase configuration is incomplete. Firestore-backed routes will fail until fixed. Reason: %s",
            firebase_message,
        )

    if settings.auto_sim_enabled:
        started, message = start_auto_simulator()
        if started:
            logger.info("Auto patrol simulator started on application startup.")
        else:
            logger.info("Auto patrol simulator startup skipped: %s", message)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": settings.app_name}


@app.on_event("shutdown")
def shutdown_checks() -> None:
    stop_auto_simulator()


app.include_router(api_router, prefix=settings.api_v1_prefix)
