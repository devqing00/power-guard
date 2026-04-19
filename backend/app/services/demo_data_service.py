from app.services.firebase_service import get_firestore_client


def _delete_collection(collection_name: str) -> int:
    db = get_firestore_client()
    docs = list(db.collection(collection_name).stream())
    if not docs:
        return 0

    batch = db.batch()
    count = 0
    for doc in docs:
        batch.delete(doc.reference)
        count += 1
    batch.commit()
    return count


def clear_live_demo_data(clear_team: bool = False) -> dict[str, int]:
    result = {
        "drones": _delete_collection("drones"),
        "faults": _delete_collection("faults"),
        "operators": 0,
    }
    if clear_team:
        result["operators"] = _delete_collection("operators")
    return result


def seed_team_roster() -> int:
    db = get_firestore_client()
    samples = [
        {"id": "ops_desk_1", "name": "Ops Desk 1", "availability": "online", "shift": "Day"},
        {"id": "ops_desk_2", "name": "Ops Desk 2", "availability": "busy", "shift": "Day"},
        {"id": "field_crew_delta", "name": "Field Crew Delta", "availability": "online", "shift": "Night"},
        {"id": "transmission_team_a", "name": "Transmission Team A", "availability": "off", "shift": "Night"},
    ]

    for sample in samples:
        doc_id = sample.pop("id")
        db.collection("operators").document(doc_id).set(sample, merge=True)

    return len(samples)