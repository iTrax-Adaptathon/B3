from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight
from schemas import FlightCreate

router = APIRouter(
    prefix="/flights",
    tags=["Flights"]
)


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.post("/")
def create_flight(
    flight: FlightCreate,
    db: Session = Depends(get_db)
):
    new_flight = Flight(
        flight_id=flight.flight_id,
        arrival_time=flight.arrival_time,
        departure_time=flight.departure_time,
        terminal=flight.terminal,
        gate_id=flight.gate_id,
        crew_id=flight.crew_id,
        delay_minutes=flight.delay_minutes,
        status=flight.status
    )

    db.add(new_flight)
    db.commit()
    db.refresh(new_flight)

    return new_flight


@router.get("/")
def get_flights(db: Session = Depends(get_db)):
    return db.query(Flight).all()


@router.get("/{flight_id}")
def get_flight(
    flight_id: str,
    db: Session = Depends(get_db)
):
    return db.query(Flight).filter(
        Flight.flight_id == flight_id
    ).first()