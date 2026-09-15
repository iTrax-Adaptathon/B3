from sqlalchemy.orm import Session

from models import Flight, Gate, Crew, Baggage
from metrics import compute_metrics


def flight_dict(flight):
    return {
        "flight_id": flight.flight_id,
        "airline": flight.airline,
        "origin": flight.origin,
        "destination": flight.destination,
        "aircraft": flight.aircraft,
        "terminal": flight.terminal,
        "gate_id": flight.gate_id,
        "crew_id": flight.crew_id,
        "gate": flight.gate_id,
        "crew": flight.crew_id,
        "scheduled_arrival": flight.scheduled_arrival,
        "scheduled_departure": flight.scheduled_departure,
        "arrival_time": flight.arrival_time,
        "departure_time": flight.departure_time,
        "delay_minutes": flight.delay_minutes,
        "status": flight.status,
        "priority": flight.priority,
        "passengers": flight.passengers
    }


def get_dashboard_data(db: Session):

    flights = db.query(Flight).order_by(Flight.arrival_time).all()
    gates = db.query(Gate).order_by(Gate.gate_id).all()
    crew = db.query(Crew).order_by(Crew.crew_id).all()
    baggage = db.query(Baggage).order_by(Baggage.bag_id).all()

    return {
        "flights": [flight_dict(flight) for flight in flights],

        "gates": [
            {
                "gate_id": gate.gate_id,
                "terminal": gate.terminal,
                "status": gate.status,
                "flights": [
                    f.flight_id for f in flights
                    if f.gate_id == gate.gate_id and f.status != "CANCELLED"
                ]
            }
            for gate in gates
        ],

        "crew": [
            {
                "crew_id": member.crew_id,
                "terminal": member.terminal,
                "available_from": member.available_from,
                "available_until": member.available_until,
                "status": member.status,
                "flights": [
                    f.flight_id for f in flights
                    if f.crew_id == member.crew_id and f.status != "CANCELLED"
                ]
            }
            for member in crew
        ],

        "baggage": [
            {
                "bag_id": bag.bag_id,
                "flight_id": bag.flight_id,
                "connecting_flight_id": bag.connecting_flight_id,
                "location": bag.current_location,
                "current_location": bag.current_location,
                "status": bag.status
            }
            for bag in baggage
        ],

        "metrics": compute_metrics(db)
    }
