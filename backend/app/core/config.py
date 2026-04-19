from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "PowerGuard API"
    api_v1_prefix: str = "/api/v1"
    app_env: str = "development"

    frontend_origin: str = "http://localhost:3000"

    analyze_use_mock: bool = True
    analyze_fault_probability: float = 0.06
    analyze_fault_cooldown_seconds: int = 75
    fault_sms_enabled: bool = False
    africastalking_username: Optional[str] = Field(default=None, description="Africa's Talking username")
    africastalking_api_key: Optional[str] = Field(default=None, description="Africa's Talking API key")
    africastalking_sender_id: Optional[str] = Field(default=None, description="SMS sender id")
    ops_phone_number: Optional[str] = Field(default=None, description="Operator phone number")

    firebase_project_id: Optional[str] = Field(default=None, description="Firebase project id")
    firebase_credentials_path: Optional[str] = Field(
        default=None,
        description="Path to service account JSON",
    )
    firebase_private_key_id: Optional[str] = Field(default=None, description="Service account key id")
    firebase_private_key: Optional[str] = Field(default=None, description="Service account private key")
    firebase_client_email: Optional[str] = Field(default=None, description="Service account email")
    firebase_client_id: Optional[str] = Field(default=None, description="Service account client id")
    firebase_client_x509_cert_url: Optional[str] = Field(
        default=None,
        description="Service account client cert URL",
    )

    auto_sim_enabled: bool = False
    auto_sim_interval_seconds: float = 0.45
    auto_sim_analyze_every: int = 4
    auto_sim_drones: int = 3
    auto_sim_drones_per_location: int = 2
    auto_sim_movement_scale: float = 0.00055
    auto_sim_location_radius_deg: float = 0.02
    auto_sim_fault_rate: float = 0.08
    auto_sim_manual_idle_timeout_seconds: int = 90

    @property
    def has_inline_firebase_credentials(self) -> bool:
        required_values = [
            self.firebase_private_key_id,
            self.firebase_private_key,
            self.firebase_client_email,
            self.firebase_client_id,
            self.firebase_client_x509_cert_url,
        ]
        return all(required_values)

    def credentials_file_exists(self) -> bool:
        if not self.firebase_credentials_path:
            return False
        return Path(self.firebase_credentials_path).expanduser().exists()

    def firebase_ready(self) -> tuple[bool, str]:
        if not self.firebase_project_id:
            return False, "FIREBASE_PROJECT_ID is not configured."
        if self.has_inline_firebase_credentials:
            return True, "ok"
        if not self.firebase_credentials_path:
            return (
                False,
                "Provide FIREBASE_CREDENTIALS_PATH or inline Firebase credentials via environment variables.",
            )
        if not self.credentials_file_exists():
            return False, (
                f"Firebase service account file was not found at: {self.firebase_credentials_path}"
            )
        return True, "ok"

    def sms_ready(self) -> tuple[bool, str]:
        if not self.fault_sms_enabled:
            return False, "FAULT_SMS_ENABLED is false."
        required_values = [
            self.africastalking_username,
            self.africastalking_api_key,
            self.ops_phone_number,
        ]
        if not all(required_values):
            return (
                False,
                "Set AFRICASTALKING_USERNAME, AFRICASTALKING_API_KEY, and OPS_PHONE_NUMBER to enable SMS.",
            )
        return True, "ok"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
