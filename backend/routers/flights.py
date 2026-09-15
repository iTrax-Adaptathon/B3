from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight, Baggage
from schemas import FlightCreate, FlightDelay

from conflict_engine import check_gate_conflict, check_crew_conflict
from cascade_engine import find_cascade_impacts, find_affected_baggage
from resolver import run_resolution, log_decision

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


def get_flight_or_404(db, flight_id):
    flight = db.query(Flight).filter(Flight.flight_id == flight_id).first()

    if not flight:
        raise HTTPException(status_code=404, detail="Flight not found")

    return flight


@router.post("/")
def create_flight(
    flight: FlightCreate,
    db: Session = Depends(get_db)
):

    gate_conflict = check_gate_conflict(
        db,
        flight.gate_id,
        flight.arrival_time,
        flight.departure_time
    )

    if gate_conflict:
        raise HTTPException(
            status_code=409,
            detail=f"Gate {flight.gate_id} is already assigned to flight {gate_conflict.flight_id}"
        )

    crew_conflict = check_crew_conflict(
        db,
        flight.crew_id,
        flight.arrival_time,
        flight.departure_time
    )

    if crew_conflict:
        raise HTTPException(
            status_code=409,
            detail=f"Crew {flight.crew_id} is already assigned to flight {crew_conflict.flight_id}"
        )

    new_flight = Flight(
        flight_id=flight.flight_id,
        airline=flight.airline,
        origin=flight.origin,
        destination=flight.destination,
        aircraft=flight.aircraft,
        terminal=flight.terminal,
        gate_id=flight.gate_id,
        crew_id=flight.crew_id,
        scheduled_arrival=flight.arrival_time,
        scheduled_departure=flight.departure_time,
        arrival_time=flight.arrival_time,
        departure_time=flight.departure_time,
        delay_minutes=flight.delay_minutes,
        status=flight.status,
        priority=flight.priority,
        passengers=flight.passengers
    )

    db.add(new_flight)
    db.commit()
    db.refresh(new_flight)

    return new_flight


@router.get("/")
def get_flights(db: Session = Depends(get_db)):
    return db.query(Flight).order_by(Flight.flight_id).all()


@router.get("/{flight_id}")
def get_flight(
    flight_id: str,
    db: Session = Depends(get_db)
):
    return get_flight_or_404(db, flight_id)


@router.post("/{flight_id}/delay")
def delay_flight(
    flight_id: str,
    delay: FlightDelay,
    db: Session = Depends(get_db)
):
    flight = get_flight_or_404(db, flight_id)

    if flight.status == "CANCELLED":
        raise HTTPException(status_code=409, detail="Flight is cancelled")

    return run_resolution(db, flight, delay.delay_minutes, dry_run=False)


@router.post("/{flight_id}/simulate")
def simulate_flight_delay(
    flight_id: str,
    delay: FlightDelay,
    db: Session = Depends(get_db)
):
    flight = get_flight_or_404(db, flight_id)

    if flight.status == "CANCELLED":
        raise HTTPException(status_code=409, detail="Flight is cancelled")

    return run_resolution(db, flight, delay.delay_minutes, dry_run=True)


@router.post("/{flight_id}/cancel")
def cancel_flight(
    flight_id: str,
    db: Session = Depends(get_db)
):
    flight = get_flight_or_404(db, flight_id)

    freed_gate = flight.gate_id
    freed_crew = flight.crew_id

    flight.status = "CANCELLED"
    flight.gate_id = None
    flight.crew_id = None

    bags = db.query(Baggage).filter(Baggage.flight_id == flight_id).all()

    for bag in bags:
        bag.status = "AT_RISK"

    log_decision(
        db, "FLIGHT_CANCELLED", flight_id, "FLIGHT",
        f"{flight_id} cancelled; gate {freed_gate} and crew {freed_crew} released, "
        f"{len(bags)} bag(s) need re-handling",
        "CRITICAL",
        from_value=f"{freed_gate}/{freed_crew}",
        to_value=None
    )

    db.commit()

    return {
        "flight_id": flight_id,
        "status": "CANCELLED",
        "freed": {"gate": freed_gate, "crew": freed_crew},
        "bags_affected": len(bags)
    }


@router.get("/{flight_id}/impact")
def get_flight_impact(
    flight_id: str,
    db: Session = Depends(get_db)
):
    flight = get_flight_or_404(db, flight_id)

    affected_flights = find_cascade_impacts(db, flight)
    affected_baggage = find_affected_baggage(db, flight_id)

    return {
        "flight_id": flight.flight_id,
        "status": flight.status,
        "delay_minutes": flight.delay_minutes,
        "affected_flights": affected_flights,
        "affected_baggage": affected_baggage,
        "total_affected_flights": len(affected_flights),
        "total_affected_bags": len(affected_baggage)
    }


@router.get("/{flight_id}/cascade")
def get_cascade_impact(
    flight_id: str,
    db: Session = Depends(get_db)
):
    flight = get_flight_or_404(db, flight_id)

    affected_flights = find_cascade_impacts(db, flight)
    affected_baggage = find_affected_baggage(db, flight_id)

    return {
        "root_flight": flight.flight_id,
        "delay_minutes": flight.delay_minutes,
        "status": flight.status,
        "current_gate": flight.gate_id,
        "current_crew": flight.crew_id,
        "affected_flights": affected_flights,
        "affected_baggage": affected_baggage,
        "total_affected_flights": len(affected_flights),
        "total_affected_bags": len(affected_baggage)
    }
