import argparse
import json
import math
import random
import time
from datetime import UTC, datetime
from urllib.request import Request, urlopen

LOCATION_PRESETS: dict[str, tuple[float, float]] = {
    "lagos": (6.5244, 3.3792),
    "abuja": (9.0765, 7.3986),
    "port-harcourt": (4.8156, 7.0498),
    "kano": (12.0022, 8.5920),
    "enugu": (6.4584, 7.5464),
}


def _post_json(url: str, payload: dict) -> dict:
    request = Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=20) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


def main() -> None:
    parser = argparse.ArgumentParser(description="PowerGuard drone simulator")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/api/v1", help="API base URL")
    parser.add_argument("--drone-id", default="drone_sim_001", help="Simulated drone id")
    parser.add_argument("--interval", type=int, default=3, help="Seconds between samples")
    parser.add_argument("--iterations", type=int, default=5, help="Number of samples to send (0 for infinite)")
    parser.add_argument("--movement-scale", type=float, default=0.0007, help="Average movement per tick in degrees")
    parser.add_argument("--fault-rate", type=float, default=0.08, help="Probability of a forced mock fault on analyze ticks")
    parser.add_argument("--analyze-every", type=int, default=4, help="Run /analyze every N telemetry ticks")
    parser.add_argument("--fault-cooldown", type=int, default=75, help="Minimum seconds between forced faults")
    parser.add_argument("--location-radius", type=float, default=0.02, help="Max patrol radius around start location in degrees")
    parser.add_argument(
        "--location",
        default="lagos",
        choices=sorted(LOCATION_PRESETS.keys()),
        help="Preset patrol location",
    )
    parser.add_argument("--lat", type=float, default=None, help="Custom start latitude")
    parser.add_argument("--lng", type=float, default=None, help="Custom start longitude")
    args = parser.parse_args()

    if args.lat is not None and args.lng is not None:
        lat, lng = args.lat, args.lng
    else:
        lat, lng = LOCATION_PRESETS[args.location]

    battery = 98.0
    heading = random.uniform(0.0, math.tau)
    phase_offset = random.uniform(0.0, math.tau)
    last_forced_fault_at = 0.0
    origin_lat, origin_lng = lat, lng

    print(
        f"Starting simulator for {args.drone_id} -> {args.base_url} "
        f"at {lat:.4f},{lng:.4f} ({args.location})"
    )
    idx = 0
    while True:
        idx += 1

        heading += random.uniform(-0.15, 0.15)
        step = args.movement_scale * (0.82 + 0.25 * math.sin(idx / 8 + phase_offset))
        lat_step = math.sin(heading) * step
        lng_step = (math.cos(heading) * step) / max(0.25, math.cos(math.radians(lat)))

        lat += lat_step + random.uniform(-args.movement_scale * 0.08, args.movement_scale * 0.08)
        lng += lng_step + random.uniform(-args.movement_scale * 0.08, args.movement_scale * 0.08)

        patrol_radius = max(0.004, args.location_radius)
        lat = max(origin_lat - patrol_radius, min(origin_lat + patrol_radius, lat))
        lng = max(origin_lng - patrol_radius, min(origin_lng + patrol_radius, lng))

        battery = battery - random.uniform(0.06, 0.24)
        if battery < 18.0:
            battery = random.uniform(78.0, 92.0)

        telemetry_payload = {
            "drone_id": args.drone_id,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "battery": round(battery, 1),
            "altitude": round(82 + math.sin(idx / 7 + phase_offset) * 6 + random.uniform(-1.2, 1.2), 1),
            "status": "active",
        }

        frame_tag = f"{args.drone_id}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}-{idx}"
        should_analyze = idx % max(1, args.analyze_every) == 0
        now = time.time()
        force_fault = False
        if should_analyze and now - last_forced_fault_at >= max(0, args.fault_cooldown):
            force_fault = random.random() < max(0.0, min(1.0, args.fault_rate))
            if force_fault:
                last_forced_fault_at = now

        analyze_payload = {
            "drone_id": args.drone_id,
            "lat": telemetry_payload["lat"],
            "lng": telemetry_payload["lng"],
            "frame_tag": frame_tag,
            "image_url": None,
            "mock_fault": force_fault,
        }

        telemetry_response = _post_json(f"{args.base_url}/telemetry", telemetry_payload)
        analyze_response = {
            "success": True,
            "fault_detected": False,
            "fault_id": None,
            "message": "Analyze skipped for this telemetry tick.",
        }
        if should_analyze:
            analyze_response = _post_json(f"{args.base_url}/analyze", analyze_payload)

        print(
            f"[{idx}/{args.iterations}] telemetry={telemetry_response.get('success')} "
            f"analyze={'on' if should_analyze else 'skip'}:{analyze_response.get('success')} "
            f"fault={analyze_response.get('fault_detected')} "
            f"fault_id={analyze_response.get('fault_id')}"
        )
        if args.iterations > 0 and idx >= args.iterations:
            break

        time.sleep(max(1, args.interval))


if __name__ == "__main__":
    main()
