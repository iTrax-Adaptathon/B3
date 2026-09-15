import time
import uuid
from datetime import datetime
from types import SimpleNamespace

from fastapi import HTTPException

from models import Flight, Crew, Baggage, Decision
from rules import (
    GATE_BUFFER_MIN,
    CREW_REST_MIN,
    CREW_TRANSIT_MIN,
    MIN_CONNECTION_MIN,
    MAX_CASCADE_DEPTH
)
from conflict_engine import (
    time_to_minutes,
    add_delay,
    check_gate_conflict,
    check_crew_conflict,
    overlap_minutes
)
from reassignment_engine import find_best_gate, find_best_crew
from cascade_engine import find_cascade_impacts
from integrity import verify_integrity


def new_cascade_id():
    return "csc_" + uuid.uuid4().hex[:6]


def decision_dict(decision):
    return {
        "id": decision.id,
        "cascade_id": decision.cascade_id,
        "depth": decision.depth,
        "timestamp": decision.timestamp,
        "type": decision.type,
        "flight_id": decision.flight_id,
        "resource_type": decision.resource_type,
        "from_value": decision.from_value,
        "to_value": decision.to_value,
        "reason": decision.reason,
        "severity": decision.severity,
        "resolution_ms": decision.resolution_ms
    }


def record(db, ctx, type, flight_id, resource_type, from_value, to_value, reason, severity, depth):

    decision = Decision(
        cascade_id=ctx["cascade_id"],
        depth=depth,
        timestamp=datetime.now().isoformat(timespec="seconds"),
        type=type,
        flight_id=flight_id,
        resource_type=resource_type,
        from_value=from_value,
        to_value=to_value,
        reason=reason,
        severity=severity
    )

    db.add(decision)
    db.flush()

    ctx["actions"].append(decision_dict(decision))

    return decision


def log_decision(db, type, flight_id, resource_type, reason, severity="INFO",
                 from_value=None, to_value=None, cascade_id=None, resolution_ms=None,
                 depth=0):
    """One-off decision outside a resolution plan (reset, chaos, cancel)."""

    decision = Decision(
        cascade_id=cascade_id or new_cascade_id(),
        depth=depth,
        timestamp=datetime.now().isoformat(timespec="seconds"),
        type=type,
        flight_id=flight_id,
        resource_type=resource_type,
        from_value=from_value,
        to_value=to_value,
        reason=reason,
        severity=severity,
        resolution_ms=resolution_ms
    )

    db.add(decision)
    db.flush()

    return decision


def bag_entry(ctx, bag):
    entry = ctx["bags"].get(bag.bag_id)

    if entry is None:
        entry = {
            "bag_id": bag.bag_id,
            "flight_id": bag.flight_id,
            "old_location": bag.current_location,
            "new_location": bag.current_location,
            "status": bag.status,
            "risk": None,
            "rebooked_to": None
        }
        ctx["bags"][bag.bag_id] = entry

    return entry


def add_conflict(ctx, flight, other, resource_type, resource_id, buffer_minutes):
    ctx["conflicts"].append({
        "flight_id": other.flight_id,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "window": {
            "arrival": other.arrival_time,
            "departure": other.departure_time
        },
        "overlap_minutes": overlap_minutes(
            flight.arrival_time,
            flight.departure_time,
            other.arrival_time,
            other.departure_time,
            buffer_minutes
        )
    })


def block(db, ctx, flight, resource_type, reason, depth):
    ctx["blocked"] = True
    record(
        db, ctx, "BLOCKED", flight.flight_id, resource_type,
        None, None, reason, "CRITICAL", depth
    )


def try_bump(db, ctx, flight, other, resource_type, depth):
    """Push the lower-priority flight just far enough to clear the buffer and
    resolve its own knock-on conflicts."""

    if other.priority >= flight.priority:
        block(
            db, ctx, flight, resource_type,
            f"No free {resource_type.lower()} in {flight.terminal} for {flight.flight_id} "
            f"({flight.arrival_time}-{flight.departure_time}) and {other.flight_id} cannot be "
            f"pushed: priority {other.priority} is not lower than {flight.flight_id}'s {flight.priority}",
            depth
        )
        return False

    if depth >= MAX_CASCADE_DEPTH:
        block(
            db, ctx, flight, resource_type,
            f"Cascade depth limit {MAX_CASCADE_DEPTH} reached while trying to free a "
            f"{resource_type.lower()} for {flight.flight_id}",
            depth
        )
        return False

    buffer_minutes = GATE_BUFFER_MIN if resource_type == "GATE" else CREW_REST_MIN

    bump_minutes = (
        time_to_minutes(flight.departure_time)
        + buffer_minutes
        - time_to_minutes(other.arrival_time)
    )

    old_window = f"{other.arrival_time}-{other.departure_time}"
    new_window = (
        f"{add_delay(other.arrival_time, bump_minutes)}-"
        f"{add_delay(other.departure_time, bump_minutes)}"
    )

    record(
        db, ctx, "CASCADE_BUMP", other.flight_id, resource_type,
        old_window, new_window,
        f"No free {resource_type.lower()} for {flight.flight_id}; pushing lower-priority "
        f"{other.flight_id} (priority {other.priority} < {flight.priority}) by {bump_minutes} min "
        f"to clear the {buffer_minutes} min buffer on {resource_type.lower()} "
        f"{flight.gate_id if resource_type == 'GATE' else flight.crew_id}",
        "HIGH",
        depth + 1
    )

    resolve_delay(db, ctx, other, bump_minutes, depth + 1, bumped=True)

    return not ctx["blocked"]


def reroute_bags(db, ctx, flight, old_gate, new_gate, depth):

    bags = db.query(Baggage).filter(Baggage.flight_id == flight.flight_id).all()

    for bag in bags:
        entry = bag_entry(ctx, bag)
        old_location = bag.current_location

        bag.current_location = f"{new_gate}-STAGING"
        bag.status = "ROUTING_UPDATED"
        db.flush()

        entry["new_location"] = bag.current_location
        entry["status"] = bag.status

        record(
            db, ctx, "BAGGAGE_REROUTED", flight.flight_id, "BAGGAGE",
            old_location, bag.current_location,
            f"Bag {bag.bag_id} follows {flight.flight_id} from gate {old_gate} "
            f"to staging at gate {new_gate}",
            "LOW",
            depth
        )

    return len(bags)


def resolve_gate(db, ctx, flight, depth):

    conflict = check_gate_conflict(
        db, flight.gate_id, flight.arrival_time, flight.departure_time,
        exclude_flight_id=flight.flight_id, buffer_minutes=GATE_BUFFER_MIN
    )

    if not conflict:
        return

    add_conflict(ctx, flight, conflict, "GATE", flight.gate_id, GATE_BUFFER_MIN)

    old_gate = flight.gate_id
    best_gate = find_best_gate(db, flight, flight.arrival_time, flight.departure_time)

    if best_gate is None:

        if not try_bump(db, ctx, flight, conflict, "GATE", depth):
            return

        still = check_gate_conflict(
            db, flight.gate_id, flight.arrival_time, flight.departure_time,
            exclude_flight_id=flight.flight_id, buffer_minutes=GATE_BUFFER_MIN
        )

        if still is None:
            record(
                db, ctx, "NO_ACTION_NEEDED", flight.flight_id, "GATE",
                old_gate, old_gate,
                f"Gate {old_gate} is clear for {flight.flight_id} "
                f"({flight.arrival_time}-{flight.departure_time}) once {conflict.flight_id} moved",
                "INFO",
                depth
            )
            return

        best_gate = find_best_gate(db, flight, flight.arrival_time, flight.departure_time)

        if best_gate is None:
            block(
                db, ctx, flight, "GATE",
                f"No gate in {flight.terminal} can take {flight.flight_id} "
                f"({flight.arrival_time}-{flight.departure_time}) even after moving {conflict.flight_id}",
                depth
            )
            return

    flight.gate_id = best_gate.gate_id
    db.flush()

    record(
        db, ctx, "GATE_REASSIGNED", flight.flight_id, "GATE",
        old_gate, best_gate.gate_id,
        f"Gate {old_gate} is held by {conflict.flight_id} "
        f"({conflict.arrival_time}-{conflict.departure_time}) inside the {GATE_BUFFER_MIN} min "
        f"turnaround buffer; {flight.flight_id} moved to {best_gate.gate_id}, the least loaded "
        f"free gate in {flight.terminal}",
        "HIGH",
        depth
    )

    reroute_bags(db, ctx, flight, old_gate, best_gate.gate_id, depth)


def resolve_crew(db, ctx, flight, depth):

    crew = db.query(Crew).filter(Crew.crew_id == flight.crew_id).first()

    conflict = None
    problem = None

    if crew is None:
        problem = f"{flight.flight_id} has no crew assigned"
    else:
        shift_start = time_to_minutes(crew.available_from)
        shift_end = time_to_minutes(crew.available_until)

        if (time_to_minutes(flight.arrival_time) < shift_start
                or time_to_minutes(flight.departure_time) > shift_end):
            problem = (
                f"Crew {crew.crew_id} shift {crew.available_from}-{crew.available_until} "
                f"no longer covers {flight.flight_id} "
                f"({flight.arrival_time}-{flight.departure_time})"
            )
        else:
            conflict = check_crew_conflict(
                db, flight.crew_id, flight.arrival_time, flight.departure_time,
                exclude_flight_id=flight.flight_id, buffer_minutes=CREW_REST_MIN
            )

            if conflict:
                problem = (
                    f"Crew {crew.crew_id} is booked on {conflict.flight_id} "
                    f"({conflict.arrival_time}-{conflict.departure_time}) without the "
                    f"{CREW_REST_MIN} min rest gap"
                )

    if problem is None:
        return

    if conflict:
        add_conflict(ctx, flight, conflict, "CREW", flight.crew_id, CREW_REST_MIN)

    old_crew = flight.crew_id
    best_crew, cross_terminal = find_best_crew(
        db, flight, flight.arrival_time, flight.departure_time
    )

    if best_crew is None:

        if conflict is None:
            block(
                db, ctx, flight, "CREW",
                f"{problem} and no other crew is available for "
                f"{flight.arrival_time}-{flight.departure_time}",
                depth
            )
            return

        if not try_bump(db, ctx, flight, conflict, "CREW", depth):
            return

        still = check_crew_conflict(
            db, flight.crew_id, flight.arrival_time, flight.departure_time,
            exclude_flight_id=flight.flight_id, buffer_minutes=CREW_REST_MIN
        )

        if still is None:
            record(
                db, ctx, "NO_ACTION_NEEDED", flight.flight_id, "CREW",
                old_crew, old_crew,
                f"Crew {old_crew} is clear for {flight.flight_id} once {conflict.flight_id} moved",
                "INFO",
                depth
            )
            return

        best_crew, cross_terminal = find_best_crew(
            db, flight, flight.arrival_time, flight.departure_time
        )

        if best_crew is None:
            block(
                db, ctx, flight, "CREW",
                f"{problem} and no crew is available even after moving {conflict.flight_id}",
                depth
            )
            return

    flight.crew_id = best_crew.crew_id
    db.flush()

    transit_note = (
        f"; dispatched from {best_crew.terminal} cross-terminal, {CREW_TRANSIT_MIN} min transit"
        if cross_terminal else ""
    )

    record(
        db, ctx, "CREW_REASSIGNED", flight.flight_id, "CREW",
        old_crew, best_crew.crew_id,
        f"{problem}; {flight.flight_id} handed to crew {best_crew.crew_id} "
        f"(shift {best_crew.available_from}-{best_crew.available_until}){transit_note}",
        "HIGH",
        depth
    )


def find_rebooking(db, flight, connecting):

    arrival = time_to_minutes(flight.arrival_time)

    best = None

    for candidate in db.query(Flight).filter(
        Flight.destination == connecting.destination,
        Flight.flight_id != connecting.flight_id,
        Flight.flight_id != flight.flight_id,
        Flight.status != "CANCELLED"
    ).all():

        if time_to_minutes(candidate.departure_time) - arrival < MIN_CONNECTION_MIN:
            continue

        if best is None or time_to_minutes(candidate.departure_time) < time_to_minutes(best.departure_time):
            best = candidate

    return best


def resolve_baggage(db, ctx, flight, depth):

    bags = db.query(Baggage).filter(Baggage.flight_id == flight.flight_id).all()

    for bag in bags:

        if not bag.connecting_flight_id:
            continue

        connecting = db.query(Flight).filter(
            Flight.flight_id == bag.connecting_flight_id
        ).first()

        if not connecting:
            continue

        connection = (
            time_to_minutes(connecting.departure_time)
            - time_to_minutes(flight.arrival_time)
        )

        if connection >= MIN_CONNECTION_MIN:
            continue

        entry = bag_entry(ctx, bag)
        entry["risk"] = "MISSED_CONNECTION"

        record(
            db, ctx, "BAGGAGE_AT_RISK", flight.flight_id, "BAGGAGE",
            bag.connecting_flight_id, None,
            f"Bag {bag.bag_id} has {connection} min to make {connecting.flight_id} "
            f"(departs {connecting.departure_time}) after {flight.flight_id} lands at "
            f"{flight.arrival_time}; {MIN_CONNECTION_MIN} min needed",
            "HIGH",
            depth
        )

        alternative = find_rebooking(db, flight, connecting)

        if alternative:
            bag.connecting_flight_id = alternative.flight_id
            bag.status = "REROUTED"
            db.flush()

            entry["status"] = bag.status
            entry["rebooked_to"] = alternative.flight_id

            record(
                db, ctx, "BAGGAGE_REBOOKED", flight.flight_id, "BAGGAGE",
                connecting.flight_id, alternative.flight_id,
                f"Bag {bag.bag_id} rebooked onto {alternative.flight_id} to "
                f"{alternative.destination} (departs {alternative.departure_time}, "
                f"{time_to_minutes(alternative.departure_time) - time_to_minutes(flight.arrival_time)} min connection)",
                "MEDIUM",
                depth
            )
        else:
            bag.status = "AT_RISK"
            db.flush()
            entry["status"] = bag.status


def resolve_delay(db, ctx, flight, minutes, depth, bumped=False):

    old_arrival = flight.arrival_time
    old_departure = flight.departure_time

    new_arrival = add_delay(old_arrival, minutes)
    new_departure = add_delay(old_departure, minutes)

    flight.arrival_time = new_arrival
    flight.departure_time = new_departure
    flight.delay_minutes = (flight.delay_minutes or 0) + minutes
    flight.status = "DELAYED"
    db.flush()

    if flight.flight_id not in ctx["flights_touched"]:
        ctx["flights_touched"].append(flight.flight_id)

    ctx["max_depth"] = max(ctx["max_depth"], depth)

    if not bumped:
        record(
            db, ctx, "DELAY_APPLIED", flight.flight_id, "FLIGHT",
            f"{old_arrival}-{old_departure}", f"{new_arrival}-{new_departure}",
            f"{flight.flight_id} delayed by {minutes} min: "
            f"{old_arrival}-{old_departure} becomes {new_arrival}-{new_departure}",
            "MEDIUM",
            depth
        )

    resolve_gate(db, ctx, flight, depth)

    if ctx["blocked"]:
        return

    resolve_crew(db, ctx, flight, depth)

    if ctx["blocked"]:
        return

    resolve_baggage(db, ctx, flight, depth)


def build_summary(plan):

    parts = [f"Delayed {plan['root_flight']} by {plan['delay_minutes']} min"]

    if plan["status"] == "BLOCKED":
        parts.append("BLOCKED - no resource available, nothing committed")
    else:
        if plan["gate_reassigned"]:
            parts.append(f"gate {plan['old_gate']}->{plan['new_gate']}")
        if plan["crew_reassigned"]:
            parts.append(f"crew {plan['old_crew']}->{plan['new_crew']}")

        bumps = [a for a in plan["actions"] if a["type"] == "CASCADE_BUMP"]
        if bumps:
            parts.append(
                f"{len(bumps)} flight(s) pushed: " + ", ".join(a["flight_id"] for a in bumps)
            )

        rerouted = len([b for b in plan["baggage"] if b["new_location"] != b["old_location"]])
        if rerouted:
            parts.append(f"{rerouted} bags rerouted")

        rebooked = [b for b in plan["baggage"] if b["rebooked_to"]]
        if rebooked:
            parts.append(f"{len(rebooked)} bags rebooked to " + ", ".join(
                sorted({b["rebooked_to"] for b in rebooked})
            ))

        at_risk = [b for b in plan["baggage"] if b["status"] == "AT_RISK"]
        if at_risk:
            parts.append(f"{len(at_risk)} bags at risk")

        if not plan["gate_reassigned"] and not plan["crew_reassigned"] and not bumps:
            parts.append("no resource conflict")

    if plan["cascade_preview"]:
        parts.append(f"{len(plan['cascade_preview'])} flights would have collided")

    return " * ".join(parts)


def run_resolution(db, flight, minutes, dry_run=False):

    started = time.perf_counter()

    ctx = {
        "cascade_id": new_cascade_id(),
        "actions": [],
        "conflicts": [],
        "bags": {},
        "flights_touched": [],
        "max_depth": 0,
        "blocked": False
    }

    old_arrival = flight.arrival_time
    old_departure = flight.departure_time
    old_gate = flight.gate_id
    old_crew = flight.crew_id
    root_flight = flight.flight_id

    probe = SimpleNamespace(
        flight_id=flight.flight_id,
        gate_id=old_gate,
        crew_id=old_crew,
        arrival_time=add_delay(old_arrival, minutes),
        departure_time=add_delay(old_departure, minutes)
    )
    cascade_preview = find_cascade_impacts(db, probe)

    resolve_delay(db, ctx, flight, minutes, 0)

    plan = {
        "cascade_id": ctx["cascade_id"],
        "dry_run": dry_run,
        "root_flight": root_flight,
        "delay_minutes": minutes,
        "old_window": {"arrival": old_arrival, "departure": old_departure},
        "new_window": {
            "arrival": flight.arrival_time,
            "departure": flight.departure_time
        },
        "status": "BLOCKED" if ctx["blocked"] else "RESOLVED",
        "actions": ctx["actions"],
        "conflicts_detected": ctx["conflicts"],
        "cascade_preview": cascade_preview,
        "baggage": list(ctx["bags"].values()),
        "max_depth": ctx["max_depth"],
        "flights_touched": ctx["flights_touched"],
        "integrity": {"ok": True, "violations": []},
        "old_gate": old_gate,
        "new_gate": flight.gate_id,
        "old_crew": old_crew,
        "new_crew": flight.crew_id,
        "gate_reassigned": flight.gate_id != old_gate,
        "crew_reassigned": flight.crew_id != old_crew,
        "new_arrival_time": flight.arrival_time,
        "new_departure_time": flight.departure_time,
        "flight_status": flight.status,
        "reasoning": [action["reason"] for action in ctx["actions"]],
        "total_flights_at_risk": len(cascade_preview),
        "baggage_rerouted": [
            {
                "bag_id": bag["bag_id"],
                "old_location": bag["old_location"],
                "new_location": bag["new_location"]
            }
            for bag in ctx["bags"].values()
            if bag["new_location"] != bag["old_location"]
        ]
    }

    if ctx["blocked"]:
        plan["new_window"] = {"arrival": old_arrival, "departure": old_departure}
        plan["new_gate"] = old_gate
        plan["new_crew"] = old_crew
        plan["gate_reassigned"] = False
        plan["crew_reassigned"] = False
        plan["new_arrival_time"] = old_arrival
        plan["new_departure_time"] = old_departure
        plan["flight_status"] = "ON_TIME"

    plan["summary"] = build_summary(plan)
    plan["resolution_ms"] = round((time.perf_counter() - started) * 1000, 1)

    for action in ctx["actions"]:
        action["resolution_ms"] = plan["resolution_ms"]

    if ctx["blocked"]:
        db.rollback()

        # The attempt and the refusal are worth keeping; the schedule change is not.
        # A preview must leave no trace at all, though.
        if not dry_run:
            for action in ctx["actions"]:
                if action["type"] not in ("DELAY_APPLIED", "BLOCKED"):
                    continue

                reason = action["reason"]
                if action["type"] == "DELAY_APPLIED":
                    reason = "Attempted - " + reason

                log_decision(
                    db, action["type"], action["flight_id"], action["resource_type"],
                    reason, action["severity"], from_value=action["from_value"],
                    to_value=action["to_value"], cascade_id=ctx["cascade_id"],
                    resolution_ms=plan["resolution_ms"], depth=action["depth"]
                )
            db.commit()

        integrity = verify_integrity(db)
        plan["integrity"] = {"ok": integrity["ok"], "violations": integrity["violations"]}

        return plan

    integrity = verify_integrity(db)
    plan["integrity"] = {"ok": integrity["ok"], "violations": integrity["violations"]}

    if dry_run:
        db.rollback()
        return plan

    if not integrity["ok"]:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={
                "detail": "Integrity violation",
                "violations": integrity["violations"]
            }
        )

    db.query(Decision).filter(
        Decision.cascade_id == ctx["cascade_id"]
    ).update({"resolution_ms": plan["resolution_ms"]})

    db.commit()

    return plan
