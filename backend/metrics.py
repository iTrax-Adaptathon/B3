from models import Flight, Gate, Crew, Baggage, Decision
from conflict_engine import time_to_minutes
from integrity import verify_integrity
from rules import GATE_BUFFER_MIN, DAY_START, DAY_END


def compute_metrics(db):

    flights = db.query(Flight).all()
    gates = db.query(Gate).all()
    crews = db.query(Crew).all()
    bags = db.query(Baggage).all()

    live = [f for f in flights if f.status != "CANCELLED"]

    on_time = len([f for f in flights if f.status == "ON_TIME"])
    delayed = [f for f in flights if f.status == "DELAYED"]
    cancelled = len([f for f in flights if f.status == "CANCELLED"])

    decisions = db.query(Decision).all()
    counts = {}
    for decision in decisions:
        counts[decision.type] = counts.get(decision.type, 0) + 1

    reassignments = counts.get("GATE_REASSIGNED", 0) + counts.get("CREW_REASSIGNED", 0)
    cascade_bumps = counts.get("CASCADE_BUMP", 0)

    day_minutes = time_to_minutes(DAY_END) - time_to_minutes(DAY_START)

    gate_minutes = 0
    for flight in live:
        if flight.gate_id:
            gate_minutes += (
                time_to_minutes(flight.departure_time)
                - time_to_minutes(flight.arrival_time)
                + GATE_BUFFER_MIN
            )

    gate_capacity = max(1, len(gates) * day_minutes)

    crew_minutes = 0
    for flight in live:
        if flight.crew_id:
            crew_minutes += (
                time_to_minutes(flight.departure_time)
                - time_to_minutes(flight.arrival_time)
            )

    crew_capacity = 0
    for crew in crews:
        crew_capacity += (
            time_to_minutes(crew.available_until)
            - time_to_minutes(crew.available_from)
        )
    crew_capacity = max(1, crew_capacity)

    integrity = verify_integrity(db)

    last_decision = db.query(Decision).order_by(Decision.id.desc()).first()

    protected_ids = {
        decision.flight_id for decision in decisions
        if decision.type in ("GATE_REASSIGNED", "CREW_REASSIGNED", "CASCADE_BUMP")
        and decision.flight_id
    }
    passengers_protected = sum(
        flight.passengers or 0 for flight in live if flight.flight_id in protected_ids
    )

    disruptions = {
        decision.cascade_id for decision in decisions
        if decision.type == "DELAY_APPLIED"
    }

    # One timing per cascade, taken from its latest decision row.
    timings = {}
    for decision in decisions:
        if decision.resolution_ms is None:
            continue
        current = timings.get(decision.cascade_id)
        if current is None or decision.id > current[0]:
            timings[decision.cascade_id] = (decision.id, decision.resolution_ms)

    measured = sorted(timings.values())

    return {
        "total_flights": len(flights),
        "on_time": on_time,
        "delayed": len(delayed),
        "cancelled": cancelled,
        "on_time_pct": round(100 * on_time / len(flights), 1) if flights else 0.0,
        "avg_delay_minutes": (
            round(sum(f.delay_minutes for f in delayed) / len(delayed), 1)
            if delayed else 0.0
        ),
        "conflicts_resolved": reassignments + cascade_bumps,
        "reassignments": reassignments,
        "cascade_bumps": cascade_bumps,
        "bags_total": len(bags),
        "bags_at_risk": len([b for b in bags if b.status == "AT_RISK"]),
        "gate_utilization_pct": round(100 * gate_minutes / gate_capacity, 1),
        "crew_utilization_pct": round(100 * crew_minutes / crew_capacity, 1),
        "integrity_violations": len(integrity["violations"]),
        "last_decision_at": last_decision.timestamp if last_decision else None,
        "passengers_protected": passengers_protected,
        "bags_rebooked": counts.get("BAGGAGE_REBOOKED", 0),
        "delay_minutes_absorbed": sum(f.delay_minutes or 0 for f in delayed),
        "decisions_total": len(decisions),
        "disruptions_today": len(disruptions),
        "avg_resolution_ms": (
            round(sum(ms for _, ms in measured) / len(measured), 1) if measured else 0.0
        ),
        "last_resolution_ms": measured[-1][1] if measured else None
    }
