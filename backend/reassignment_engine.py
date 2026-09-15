from models import Gate, Crew, Flight
from conflict_engine import (
    time_to_minutes,
    check_gate_conflict,
    check_crew_conflict
)
from rules import GATE_BUFFER_MIN, CREW_REST_MIN, CREW_TRANSIT_MIN


def gate_load(db, gate_id, exclude_flight_id):
    return db.query(Flight).filter(
        Flight.gate_id == gate_id,
        Flight.flight_id != exclude_flight_id,
        Flight.status != "CANCELLED"
    ).all()


def find_best_gate(db, flight, new_arrival, new_departure):
    """Free gate in the same terminal with the lightest schedule load, so a
    reassignment doesn't just grab the first gate but the one least likely to
    cause the next conflict. Ties go to the tightest fit."""

    gates = db.query(Gate).filter(
        Gate.terminal == flight.terminal,
        Gate.status == "AVAILABLE"
    ).all()

    arrival = time_to_minutes(new_arrival)
    departure = time_to_minutes(new_departure)

    best_gate = None
    best_score = None

    for gate in gates:

        if check_gate_conflict(
            db,
            gate.gate_id,
            new_arrival,
            new_departure,
            exclude_flight_id=flight.flight_id,
            buffer_minutes=GATE_BUFFER_MIN
        ):
            continue

        others = gate_load(db, gate.gate_id, flight.flight_id)

        slack = None
        for other in others:
            gap = abs(time_to_minutes(other.arrival_time) - departure)
            gap = min(gap, abs(arrival - time_to_minutes(other.departure_time)))
            if slack is None or gap < slack:
                slack = gap

        score = (len(others), slack if slack is not None else 10000)

        if best_score is None or score < best_score:
            best_score = score
            best_gate = gate

    return best_gate


def crew_is_free(db, crew, flight, new_arrival, new_departure, cross_terminal):

    shift_start = time_to_minutes(crew.available_from)
    shift_end = time_to_minutes(crew.available_until)

    if time_to_minutes(new_arrival) < shift_start:
        return False

    if time_to_minutes(new_departure) > shift_end:
        return False

    if check_crew_conflict(
        db,
        crew.crew_id,
        new_arrival,
        new_departure,
        exclude_flight_id=flight.flight_id,
        buffer_minutes=CREW_REST_MIN
    ):
        return False

    if cross_terminal:
        # Crew has to physically cross terminals before boarding starts.
        previous_end = None

        for other in db.query(Flight).filter(
            Flight.crew_id == crew.crew_id,
            Flight.flight_id != flight.flight_id,
            Flight.status != "CANCELLED"
        ).all():
            end = time_to_minutes(other.departure_time)
            if end <= time_to_minutes(new_arrival):
                if previous_end is None or end > previous_end:
                    previous_end = end

        if previous_end is not None:
            if time_to_minutes(new_arrival) < previous_end + CREW_REST_MIN + CREW_TRANSIT_MIN:
                return False

    return True


def find_best_crew(db, flight, new_arrival, new_departure):
    """Same-terminal crew first (most shift slack left after the new
    departure), then cross-terminal crew with the transit allowance.
    Returns (crew, cross_terminal)."""

    departure = time_to_minutes(new_departure)

    for cross_terminal in (False, True):

        query = db.query(Crew).filter(Crew.status == "AVAILABLE")

        if cross_terminal:
            query = query.filter(Crew.terminal != flight.terminal)
        else:
            query = query.filter(Crew.terminal == flight.terminal)

        best_crew = None
        best_slack = None

        for crew in query.all():

            if not crew_is_free(db, crew, flight, new_arrival, new_departure, cross_terminal):
                continue

            slack = time_to_minutes(crew.available_until) - departure

            if best_slack is None or slack > best_slack:
                best_slack = slack
                best_crew = crew

        if best_crew:
            return best_crew, cross_terminal

    return None, False
