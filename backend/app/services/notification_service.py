import logging
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.core.config import get_settings

logger = logging.getLogger(__name__)


def send_fault_sms(message: str) -> bool:
    settings = get_settings()
    sms_ok, sms_message = settings.sms_ready()
    if not sms_ok:
        logger.info("SMS skipped: %s", sms_message)
        return False

    payload = {
        "username": settings.africastalking_username,
        "to": settings.ops_phone_number,
        "message": message,
    }
    if settings.africastalking_sender_id:
        payload["from"] = settings.africastalking_sender_id

    encoded = urlencode(payload).encode("utf-8")
    request = Request(
        url="https://api.africastalking.com/version1/messaging",
        data=encoded,
        headers={
            "apiKey": settings.africastalking_api_key or "",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=15) as response:
            code = response.getcode()
            if 200 <= code < 300:
                logger.info("Fault SMS sent to '%s'.", settings.ops_phone_number)
                return True
            logger.error("Africa's Talking returned non-success status code %s.", code)
            return False
    except Exception as exc:
        logger.error("Failed to send SMS notification: %s", exc)
        return False
