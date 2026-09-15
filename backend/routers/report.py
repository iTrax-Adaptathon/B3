from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight, Gate, Crew, Baggage, Decision
from conflict_engine import time_to_minutes
from integrity import verify_integrity
from metrics import compute_metrics

router = APIRouter(tags=["Report"])


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


def window_delay(decision):
    if not decision.from_value or not decision.to_value:
        return 0

    return (
        time_to_minutes(decision.to_value.split("-")[0])
        - time_to_minutes(decision.from_value.split("-")[0])
    )


def cascade_summary(root_flight, delay_minutes, decisions):

    parts = [f"Delayed {root_flight} by {delay_minutes} min"]

    if any(d.type == "BLOCKED" for d in decisions):
        parts.append("BLOCKED - no resource available, nothing committed")
        return " * ".join(parts)

    for decision in decisions:
        if decision.type == "GATE_REASSIGNED" and decision.flight_id == root_flight:
            parts.append(f"gate {decision.from_value}->{decision.to_value}")
        if decision.type == "CREW_REASSIGNED" and decision.flight_id == root_flight:
            parts.append(f"crew {decision.from_value}->{decision.to_value}")

    bumped = [d.flight_id for d in decisions if d.type == "CASCADE_BUMP"]
    if bumped:
        parts.append(f"{len(bumped)} flight(s) pushed: " + ", ".join(bumped))

    rerouted = len([d for d in decisions if d.type == "BAGGAGE_REROUTED"])
    if rerouted:
        parts.append(f"{rerouted} bags rerouted")

    rebooked = [d for d in decisions if d.type == "BAGGAGE_REBOOKED"]
    if rebooked:
        parts.append(f"{len(rebooked)} bags rebooked to " + ", ".join(
            sorted({d.to_value for d in rebooked})
        ))

    return " * ".join(parts)


@router.get("/report")
def get_report(db: Session = Depends(get_db)):

    flights = db.query(Flight).order_by(Flight.arrival_time).all()
    by_id = {flight.flight_id: flight for flight in flights}

    decisions = db.query(Decision).order_by(Decision.id).all()

    grouped = {}
    for decision in decisions:
        grouped.setdefault(decision.cascade_id, []).append(decision)

    disruptions = []

    for cascade_id, cascade in grouped.items():

        root = next((d for d in cascade if d.type == "DELAY_APPLIED"), None)

        if root is None:
            continue

        flight = by_id.get(root.flight_id)
        delay_minutes = window_delay(root)
        blocked = any(d.type == "BLOCKED" for d in cascade)
        timings = [d.resolution_ms for d in cascade if d.resolution_ms is not None]

        disruptions.append({
            "cascade_id": cascade_id,
            "root_flight": root.flight_id,
            "airline": flight.airline if flight else None,
            "route": f"{flight.origin}->{flight.destination}" if flight else None,
            "delay_minutes": delay_minutes,
            "status": "Blocked" if blocked else "Resolved",
            "summary": cascade_summary(root.flight_id, delay_minutes, cascade),
            "resolution_ms": timings[-1] if timings else None,
            "actions": [
                {
                    "type": d.type,
                    "flight_id": d.flight_id,
                    "from_value": d.from_value,
                    "to_value": d.to_value,
                    "reason": d.reason
                }
                for d in cascade
            ],
            "_order": cascade[-1].id
        })

    disruptions.sort(key=lambda item: item["_order"], reverse=True)
    for disruption in disruptions:
        disruption.pop("_order")

    integrity = verify_integrity(db)

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "airport": {
            "terminals": len({gate.terminal for gate in db.query(Gate).all()}),
            "gates": db.query(Gate).count(),
            "crews": db.query(Crew).count()
        },
        "metrics": compute_metrics(db),
        "disruptions": disruptions,
        "flights": [
            {
                "flight_id": flight.flight_id,
                "airline": flight.airline,
                "route": f"{flight.origin}->{flight.destination}",
                "scheduled": f"{flight.scheduled_arrival}-{flight.scheduled_departure}",
                "now": f"{flight.arrival_time}-{flight.departure_time}",
                "gate_id": flight.gate_id,
                "crew_id": flight.crew_id,
                "status": flight.status,
                "delay_minutes": flight.delay_minutes,
                "priority": flight.priority,
                "passengers": flight.passengers
            }
            for flight in flights
        ],
        "baggage_exceptions": [
            {
                "bag_id": bag.bag_id,
                "flight_id": bag.flight_id,
                "connecting_flight_id": bag.connecting_flight_id,
                "status": bag.status
            }
            for bag in db.query(Baggage).filter(
                Baggage.status.in_(["REROUTED", "AT_RISK"])
            ).order_by(Baggage.bag_id).all()
        ],
        "guarantee": {"ok": integrity["ok"], "violations": integrity["violations"]}
    }
