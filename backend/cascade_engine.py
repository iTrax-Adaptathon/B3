from models import Flight, Baggage
from conflict_engine import windows_conflict, overlap_minutes
from rules import GATE_BUFFER_MIN, CREW_REST_MIN


def find_cascade_impacts(db, delayed_flight):
    """Who would have collided with this flight if nothing was reassigned."""

    affected_flights = []

    for flight in db.query(Flight).filter(Flight.status != "CANCELLED").all():

        if flight.flight_id == delayed_flight.flight_id:
            continue

        gate_risk = False
        crew_risk = False
        overlap = 0

        if flight.gate_id and flight.gate_id == delayed_flight.gate_id:

            if windows_conflict(
                delayed_flight.arrival_time,
                delayed_flight.departure_time,
                flight.arrival_time,
                flight.departure_time,
                GATE_BUFFER_MIN
            ):
                gate_risk = True
                overlap = max(overlap, overlap_minutes(
                    delayed_flight.arrival_time,
                    delayed_flight.departure_time,
                    flight.arrival_time,
                    flight.departure_time,
                    GATE_BUFFER_MIN
                ))

        if flight.crew_id and flight.crew_id == delayed_flight.crew_id:

            if windows_conflict(
                delayed_flight.arrival_time,
                delayed_flight.departure_time,
                flight.arrival_time,
                flight.departure_time,
                CREW_REST_MIN
            ):
                crew_risk = True
                overlap = max(overlap, overlap_minutes(
                    delayed_flight.arrival_time,
                    delayed_flight.departure_time,
                    flight.arrival_time,
                    flight.departure_time,
                    CREW_REST_MIN
                ))

        if gate_risk or crew_risk:

            affected_flights.append({
                "flight_id": flight.flight_id,
                "gate": flight.gate_id,
                "crew": flight.crew_id,
                "gate_risk": gate_risk,
                "crew_risk": crew_risk,
                "overlap_minutes": overlap,
                "impact": "HIGH" if (gate_risk and crew_risk) or overlap >= 30 else "MEDIUM"
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
            "connecting_flight_id": bag.connecting_flight_id,
            "location": bag.current_location,
            "status": bag.status
        }
        for bag in baggage
    ]
