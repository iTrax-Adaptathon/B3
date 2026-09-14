from models import Flight, Baggage
from conflict_engine import times_overlap


def find_cascade_impacts(db, delayed_flight):

    affected_flights = []


    for flight in db.query(Flight).all():

        if flight.flight_id == delayed_flight.flight_id:
            continue

        gate_risk = False
        crew_risk = False

        # Check same gate
        if flight.gate_id == delayed_flight.gate_id:

            if times_overlap(
                delayed_flight.arrival_time,
                delayed_flight.departure_time,
                flight.arrival_time,
                flight.departure_time
            ):
                gate_risk = True

        # Check same crew
        if flight.crew_id == delayed_flight.crew_id:

            if times_overlap(
                delayed_flight.arrival_time,
                delayed_flight.departure_time,
                flight.arrival_time,
                flight.departure_time
            ):
                crew_risk = True

        if gate_risk or crew_risk:

            affected_flights.append({
                "flight_id": flight.flight_id,
                "gate": flight.gate_id,
                "crew": flight.crew_id,
                "gate_risk": gate_risk,
                "crew_risk": crew_risk,
                "impact": "HIGH"
            })

    return affected_flights


def find_affected_baggage(db, flight_id):

    baggage = db.query(Baggage).filter(
        Baggage.flight_id == flight_id
    ).all()

    return [
        {
            "bag_id": bag.bag_id,
            "flight_id": bag.flight_id,
            "location": bag.current_location,
            "status": bag.status
        }
        for bag in baggage
    ]