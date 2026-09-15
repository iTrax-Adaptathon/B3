from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight, Baggage, Decision
from integrity import verify_integrity

router = APIRouter(
    prefix="/alerts",
    tags=["Alerts"]
)

DECISION_ALERTS = {
    "GATE_REASSIGNED": ("GATE_REASSIGNED", "MEDIUM"),
    "CREW_REASSIGNED": ("CREW_REASSIGNED", "MEDIUM"),
    "CASCADE_BUMP": ("CASCADE_BUMP", "HIGH"),
    "BAGGAGE_REROUTED": ("BAGGAGE_REROUTED", "LOW"),
    "BAGGAGE_AT_RISK": ("BAGGAGE_AT_RISK", "HIGH"),
    "BAGGAGE_REBOOKED": ("BAGGAGE_REROUTED", "MEDIUM"),
    "BLOCKED": ("BLOCKED", "CRITICAL"),
}

SEVERITY_RANK = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.get("/")
def get_alerts(db: Session = Depends(get_db)):

    alerts = []
    now = datetime.now().isoformat(timespec="seconds")

    integrity = verify_integrity(db)

    for index, violation in enumerate(integrity["violations"]):
        alerts.append({
            "id": f"alert_integrity_{index}",
            "type": "INTEGRITY",
            "severity": "CRITICAL",
            "flight_id": violation["flight_ids"][0] if violation["flight_ids"] else None,
            "bag_id": None,
            "message": violation["detail"],
            "timestamp": integrity["checked_at"]
        })

    for flight in db.query(Flight).filter(Flight.delay_minutes > 0).all():
        alerts.append({
            "id": f"alert_flight_{flight.flight_id}",
            "type": "FLIGHT_DELAY",
            "severity": "HIGH" if flight.delay_minutes >= 45 else "MEDIUM",
            "flight_id": flight.flight_id,
            "bag_id": None,
            "message": (
                f"{flight.flight_id} is {flight.delay_minutes} min late, now "
                f"{flight.arrival_time}-{flight.departure_time} at gate {flight.gate_id}"
            ),
            "timestamp": now
        })

    for bag in db.query(Baggage).filter(Baggage.status == "AT_RISK").all():
        alerts.append({
            "id": f"alert_bag_{bag.bag_id}",
            "type": "BAGGAGE_AT_RISK",
            "severity": "HIGH",
            "flight_id": bag.flight_id,
            "bag_id": bag.bag_id,
            "message": (
                f"Bag {bag.bag_id} from {bag.flight_id} has no viable connection "
                f"({bag.connecting_flight_id or 'no onward flight'})"
            ),
            "timestamp": now
        })

    recent = db.query(Decision).order_by(Decision.id.desc()).limit(30).all()

    for decision in recent:
        mapped = DECISION_ALERTS.get(decision.type)

        if not mapped:
            continue

        alert_type, severity = mapped

        alerts.append({
            "id": f"alert_dec_{decision.id}",
            "type": alert_type,
            "severity": decision.severity if decision.severity != "INFO" else severity,
            "flight_id": decision.flight_id,
            "bag_id": None,
            "message": decision.reason,
            "timestamp": decision.timestamp
        })

    alerts.sort(key=lambda alert: (
        SEVERITY_RANK.get(alert["severity"], 5),
        alert["timestamp"]
    ))

    return {"total_alerts": len(alerts), "alerts": alerts}
