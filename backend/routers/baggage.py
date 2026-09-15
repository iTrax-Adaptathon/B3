from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Baggage
from schemas import BaggageCreate


router = APIRouter(
    prefix="/baggage",
    tags=["Baggage"]
)


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.post("/")
def create_baggage(
    baggage: BaggageCreate,
    db: Session = Depends(get_db)
):
    new_baggage = Baggage(
        bag_id=baggage.bag_id,
        flight_id=baggage.flight_id,
        connecting_flight_id=baggage.connecting_flight_id,
        current_location=baggage.current_location,
        status=baggage.status
    )

    db.add(new_baggage)
    db.commit()
    db.refresh(new_baggage)

    return new_baggage


@router.get("/")
def get_baggage(db: Session = Depends(get_db)):
    return db.query(Baggage).all()


@router.get("/{bag_id}")
def get_one_baggage(
    bag_id: str,
    db: Session = Depends(get_db)
):
    return db.query(Baggage).filter(
        Baggage.bag_id == bag_id
    ).first()


@router.get("/flight/{flight_id}")
def get_flight_baggage(
    flight_id: str,
    db: Session = Depends(get_db)
):
    return db.query(Baggage).filter(
        Baggage.flight_id == flight_id
    ).all()