from models import Flight, Baggage
from conflict_engine import times_overlap


def find_affected_flights(
    db,
    delayed_flight
):

    affected_flights = []

    for flight in db.query(Flight).all():

        if flight.flight_id == delayed_flight.flight_id:
            continue

        gate_conflict = (
            flight.gate_id == delayed_flight.gate_id
            and
            times_overlap(
                flight.arrival_time,
                flight.departure_time,
                delayed_flight.arrival_time,
                delayed_flight.departure_time
            )
        )

        crew_conflict = (
            flight.crew_id == delayed_flight.crew_id
            and
            times_overlap(
                flight.arrival_time,
                flight.departure_time,
                delayed_flight.arrival_time,
                delayed_flight.departure_time
            )
        )

        if gate_conflict or crew_conflict:

            affected_flights.append({
                "flight_id": flight.flight_id,
                "gate": flight.gate_id,
                "crew": flight.crew_id,
                "gate_conflict": gate_conflict,
                "crew_conflict": crew_conflict
            })

    return affected_flights


def find_affected_baggage(
    db,
    flight_id
):

    baggage = db.query(Baggage).filter(
        Baggage.flight_id == flight_id
    ).all()

    return [
        {
            "bag_id": bag.bag_id,
            "status": bag.status,
            "location": bag.current_location
        }
        for bag in baggage
    ]