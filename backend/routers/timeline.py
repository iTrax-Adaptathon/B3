from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight, Gate, Crew
from rules import DAY_START, DAY_END, GATE_BUFFER_MIN

router = APIRouter(tags=["Timeline"])


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.get("/timeline")
def get_timeline(db: Session = Depends(get_db)):

    flights = db.query(Flight).filter(Flight.status != "CANCELLED").all()
    gates = db.query(Gate).order_by(Gate.terminal, Gate.gate_id).all()
    crews = db.query(Crew).order_by(Crew.terminal, Crew.crew_id).all()

    return {
        "window": {"start": DAY_START, "end": DAY_END},

        "gates": [
            {
                "gate_id": gate.gate_id,
                "terminal": gate.terminal,
                "status": gate.status,
                "buffer_minutes": GATE_BUFFER_MIN,
                "blocks": sorted(
                    [
                        {
                            "flight_id": flight.flight_id,
                            "start": flight.arrival_time,
                            "end": flight.departure_time,
                            "status": flight.status,
                            "delay_minutes": flight.delay_minutes,
                            "crew_id": flight.crew_id,
                            "priority": flight.priority
                        }
                        for flight in flights if flight.gate_id == gate.gate_id
                    ],
                    key=lambda block: block["start"]
                )
            }
            for gate in gates
        ],

        "crews": [
            {
                "crew_id": crew.crew_id,
                "terminal": crew.terminal,
                "shift": {"start": crew.available_from, "end": crew.available_until},
                "status": crew.status,
                "blocks": sorted(
                    [
                        {
                            "flight_id": flight.flight_id,
                            "start": flight.arrival_time,
                            "end": flight.departure_time,
                            "gate_id": flight.gate_id,
                            "status": flight.status
                        }
                        for flight in flights if flight.crew_id == crew.crew_id
                    ],
                    key=lambda block: block["start"]
                )
            }
            for crew in crews
        ]
    }
