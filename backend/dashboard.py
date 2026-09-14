from sqlalchemy.orm import Session

from models import Flight, Gate, Crew, Baggage


def get_dashboard_data(db: Session):

    flights = db.query(Flight).all()
    gates = db.query(Gate).all()
    crew = db.query(Crew).all()
    baggage = db.query(Baggage).all()

    return {
        "flights": [
            {
                "flight_id": flight.flight_id,
                "arrival_time": flight.arrival_time,
                "departure_time": flight.departure_time,
                "terminal": flight.terminal,
                "gate": flight.gate_id,
                "crew": flight.crew_id,
                "delay_minutes": flight.delay_minutes,
                "status": flight.status
            }
            for flight in flights
        ],

        "gates": [
            {
                "gate_id": gate.gate_id,
                "terminal": gate.terminal,
                "status": gate.status
            }
            for gate in gates
        ],

        "crew": [
            {
                "crew_id": member.crew_id,
                "terminal": member.terminal,
                "available_from": member.available_from,
                "available_until": member.available_until,
                "status": member.status
            }
            for member in crew
        ],

        "baggage": [
            {
                "bag_id": bag.bag_id,
                "flight_id": bag.flight_id,
                "location": bag.current_location,
                "status": bag.status
            }
            for bag in baggage
        ]
    }