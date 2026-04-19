import math

_KNOWN_LOCATIONS: list[tuple[str, float, float]] = [
    ("Lagos", 6.5244, 3.3792),
    ("Abuja", 9.0765, 7.3986),
    ("Port Harcourt", 4.8156, 7.0498),
    ("Kano", 12.0022, 8.5920),
    ("Enugu", 6.4584, 7.5464),
]


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius_km = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius_km * c


def nearest_location_name(lat: float, lng: float) -> str:
    nearest_name = "Unknown Area"
    nearest_distance = float("inf")

    for name, known_lat, known_lng in _KNOWN_LOCATIONS:
        distance = _haversine_km(lat, lng, known_lat, known_lng)
        if distance < nearest_distance:
            nearest_distance = distance
            nearest_name = name

    return nearest_name