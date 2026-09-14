from models import Gate, Crew
from conflict_engine import times_overlap


def find_best_gate(
    db,
    flight,
    new_arrival,
    new_departure
):

    gates = db.query(Gate).filter(
        Gate.terminal == flight.terminal,
        Gate.status == "AVAILABLE"
    ).all()

    best_gate = None
    best_score = None

    for gate in gates:

        conflict_count = 0

        for other_flight in flight.__class__.query if False else []:
            pass

        from models import Flight

        flights = db.query(Flight).filter(
            Flight.flight_id != flight.flight_id,
            Flight.gate_id == gate.gate_id
        ).all()

        for other_flight in flights:

            if times_overlap(
                new_arrival,
                new_departure,
                other_flight.arrival_time,
                other_flight.departure_time
            ):
                conflict_count += 1

        if conflict_count == 0:

            score = 0

            if best_score is None or score < best_score:
                best_score = score
                best_gate = gate

    return best_gate


def find_best_crew(
    db,
    flight,
    new_arrival,
    new_departure
):

    crews = db.query(Crew).filter(
        Crew.terminal == flight.terminal,
        Crew.status == "AVAILABLE"
    ).all()

    best_crew = None

    for crew in crews:

        from models import Flight

        flights = db.query(Flight).filter(
            Flight.flight_id != flight.flight_id,
            Flight.crew_id == crew.crew_id
        ).all()

        conflict = False

        for other_flight in flights:

            if times_overlap(
                new_arrival,
                new_departure,
                other_flight.arrival_time,
                other_flight.departure_time
            ):
                conflict = True
                break

        if not conflict:
            best_crew = crew
            break

    return best_crew