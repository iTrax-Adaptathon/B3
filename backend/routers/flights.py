from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight,Gate,Crew,Baggage
from schemas import FlightCreate,FlightDelay

from conflict_engine import (
    check_gate_conflict,
    check_crew_conflict,
    add_delay
)

from cascade_engine import (
    find_cascade_impacts,
    find_affected_baggage
)

from reassignment_engine import (
    find_best_gate,
    find_best_crew
)

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

@router.post("/{flight_id}/delay")
def delay_flight(
    flight_id: str,
    delay: FlightDelay,
    db: Session = Depends(get_db)
):

    flight = db.query(Flight).filter(
        Flight.flight_id == flight_id
    ).first()

    if not flight:
        raise HTTPException(
            status_code=404,
            detail="Flight not found"
        )

    new_arrival = add_delay(
        flight.arrival_time,
        delay.delay_minutes
    )

    new_departure = add_delay(
        flight.departure_time,
        delay.delay_minutes
    )

    gate_conflict = check_gate_conflict(
        db,
        flight.gate_id,
        new_arrival,
        new_departure
    )

    crew_conflict = check_crew_conflict(
        db,
        flight.crew_id,
        new_arrival,
        new_departure
    )

    old_gate = flight.gate_id
    old_crew = flight.crew_id

    new_gate = old_gate
    new_crew = old_crew

    if gate_conflict:

      best_gate = find_best_gate(
        db,
        flight,
        new_arrival,
        new_departure
    )

    if not best_gate:
        raise HTTPException(
            status_code=409,
            detail="No available gate for delayed flight"
        )

    new_gate = best_gate.gate_id

    if crew_conflict:

       best_crew = find_best_crew(
        db,
        flight,
        new_arrival,
        new_departure
    )

    if not best_crew:
        raise HTTPException(
            status_code=409,
            detail="No available crew for delayed flight"
        )

    new_crew = best_crew.crew_id

    flight.arrival_time = new_arrival
    flight.departure_time = new_departure
    flight.delay_minutes += delay.delay_minutes
    flight.gate_id = new_gate
    flight.crew_id = new_crew
    flight.status = "DELAYED"

    baggage = db.query(Baggage).filter(
        Baggage.flight_id == flight_id
    ).all()

    for bag in baggage:
        bag.status = "ROUTING_UPDATED"

    db.commit()
    db.refresh(flight)

    return {
        "message": "Flight delay processed successfully",
        "flight_id": flight.flight_id,
        "old_gate": old_gate,
        "new_gate": new_gate,
        "old_crew": old_crew,
        "new_crew": new_crew,
        "new_arrival_time": new_arrival,
        "new_departure_time": new_departure,
        "delay_minutes": flight.delay_minutes,
        "status": flight.status
    }

@router.get("/{flight_id}/impact")
def get_flight_impact(
    flight_id: str,
    db: Session = Depends(get_db)
):

    flight = db.query(Flight).filter(
        Flight.flight_id == flight_id
    ).first()

    if not flight:
        raise HTTPException(
            status_code=404,
            detail="Flight not found"
        )

    affected_flights = find_cascade_impacts(
        db,
        flight
    )

    affected_baggage = find_affected_baggage(
        db,
        flight_id
    )

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

    flight = db.query(Flight).filter(
        Flight.flight_id == flight_id
    ).first()

    if not flight:
        raise HTTPException(
            status_code=404,
            detail="Flight not found"
        )

    affected_flights = find_cascade_impacts(
        db,
        flight
    )

    affected_baggage = find_affected_baggage(
        db,
        flight_id
    )

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