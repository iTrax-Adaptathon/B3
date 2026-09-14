from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight, Baggage

router = APIRouter(
    prefix="/alerts",
    tags=["Alerts"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/")
def get_alerts(db: Session = Depends(get_db)):

    alerts = []

    flights = db.query(Flight).all()

    for flight in flights:

        if flight.delay_minutes > 0:
            alerts.append({
                "type": "FLIGHT_DELAY",
                "severity": "HIGH",
                "flight_id": flight.flight_id,
                "message": f"Flight {flight.flight_id} is delayed by {flight.delay_minutes} minutes"
            })

    baggage = db.query(Baggage).all()

    for bag in baggage:

        if bag.status == "ROUTING_UPDATED":
            alerts.append({
                "type": "BAGGAGE_UPDATE",
                "severity": "MEDIUM",
                "bag_id": bag.bag_id,
                "flight_id": bag.flight_id,
                "message": f"Baggage {bag.bag_id} requires updated routing"
            })

    return {
        "total_alerts": len(alerts),
        "alerts": alerts
    }