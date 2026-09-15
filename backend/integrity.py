from datetime import datetime

from models import Flight, Crew
from conflict_engine import time_to_minutes, windows_conflict, overlap_minutes
from rules import GATE_BUFFER_MIN, CREW_REST_MIN


def verify_integrity(db):
    """The hard invariant: no two live flights may share a gate or a crew at
    overlapping times (buffers included), and no crew may work outside its
    shift."""

    violations = []

    flights = db.query(Flight).filter(Flight.status != "CANCELLED").all()

    by_gate = {}
    by_crew = {}

    for flight in flights:
        if flight.gate_id:
            by_gate.setdefault(flight.gate_id, []).append(flight)
        if flight.crew_id:
            by_crew.setdefault(flight.crew_id, []).append(flight)

    for gate_id, gate_flights in by_gate.items():
        for i in range(len(gate_flights)):
            for j in range(i + 1, len(gate_flights)):
                a = gate_flights[i]
                b = gate_flights[j]

                if windows_conflict(
                    a.arrival_time, a.departure_time,
                    b.arrival_time, b.departure_time,
                    GATE_BUFFER_MIN
                ):
                    violations.append({
                        "type": "GATE_OVERLAP",
                        "resource_id": gate_id,
                        "flight_ids": [a.flight_id, b.flight_id],
                        "detail": (
                            f"{a.flight_id} ({a.arrival_time}-{a.departure_time}) and "
                            f"{b.flight_id} ({b.arrival_time}-{b.departure_time}) share gate "
                            f"{gate_id} within the {GATE_BUFFER_MIN} min turnaround buffer "
                            f"({overlap_minutes(a.arrival_time, a.departure_time, b.arrival_time, b.departure_time, GATE_BUFFER_MIN)} min overlap)"
                        )
                    })

    for crew_id, crew_flights in by_crew.items():
        for i in range(len(crew_flights)):
            for j in range(i + 1, len(crew_flights)):
                a = crew_flights[i]
                b = crew_flights[j]

                if windows_conflict(
                    a.arrival_time, a.departure_time,
                    b.arrival_time, b.departure_time,
                    CREW_REST_MIN
                ):
                    violations.append({
                        "type": "CREW_OVERLAP",
                        "resource_id": crew_id,
                        "flight_ids": [a.flight_id, b.flight_id],
                        "detail": (
                            f"Crew {crew_id} is booked on {a.flight_id} "
                            f"({a.arrival_time}-{a.departure_time}) and {b.flight_id} "
                            f"({b.arrival_time}-{b.departure_time}) without the "
                            f"{CREW_REST_MIN} min rest gap"
                        )
                    })

    crews = {c.crew_id: c for c in db.query(Crew).all()}

    for crew_id, crew_flights in by_crew.items():
        crew = crews.get(crew_id)

        if not crew:
            continue

        shift_start = time_to_minutes(crew.available_from)
        shift_end = time_to_minutes(crew.available_until)

        for flight in crew_flights:
            if (time_to_minutes(flight.arrival_time) < shift_start
                    or time_to_minutes(flight.departure_time) > shift_end):
                violations.append({
                    "type": "CREW_OUTSIDE_SHIFT",
                    "resource_id": crew_id,
                    "flight_ids": [flight.flight_id],
                    "detail": (
                        f"Crew {crew_id} shift {crew.available_from}-{crew.available_until} "
                        f"does not cover {flight.flight_id} "
                        f"({flight.arrival_time}-{flight.departure_time})"
                    )
                })

    return {
        "ok": len(violations) == 0,
        "violations": violations,
        "checked_at": datetime.now().isoformat(timespec="seconds")
    }
