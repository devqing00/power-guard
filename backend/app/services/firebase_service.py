import logging
from pathlib import Path
from typing import Optional

import firebase_admin
from firebase_admin import credentials, firestore

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)
_firestore_client: Optional[firestore.Client] = None


def _init_firebase(settings: Settings) -> None:
    if firebase_admin._apps:
        return

    firebase_ok, firebase_message = settings.firebase_ready()
    if not firebase_ok:
        raise RuntimeError(firebase_message)

    if settings.has_inline_firebase_credentials:
        private_key = settings.firebase_private_key
        if private_key and "\\n" in private_key:
            private_key = private_key.replace("\\n", "\n")

        cert_info = {
            "type": "service_account",
            "project_id": settings.firebase_project_id,
            "private_key_id": settings.firebase_private_key_id,
            "private_key": private_key,
            "client_email": settings.firebase_client_email,
            "client_id": settings.firebase_client_id,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_x509_cert_url": settings.firebase_client_x509_cert_url,
        }
        cred = credentials.Certificate(cert_info)
    else:
        credentials_path = Path(settings.firebase_credentials_path).expanduser()
        if not credentials_path.exists():
            raise FileNotFoundError(
                f"Firebase service account file was not found at: {credentials_path}"
            )
        cred = credentials.Certificate(str(credentials_path))

    firebase_admin.initialize_app(cred, {"projectId": settings.firebase_project_id})
    logger.info("Firebase Admin initialized for project '%s'.", settings.firebase_project_id)


def get_firestore_client() -> firestore.Client:
    global _firestore_client

    if _firestore_client is not None:
        return _firestore_client

    settings = get_settings()
    _init_firebase(settings)

    _firestore_client = firestore.client()
    return _firestore_client
