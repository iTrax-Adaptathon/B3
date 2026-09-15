from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Decision
from resolver import decision_dict

router = APIRouter(tags=["Decisions"])


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.get("/decisions")
def get_decisions(
    limit: int = 50,
    cascade_id: Optional[str] = None,
    flight_id: Optional[str] = None,
    db: Session = Depends(get_db)
):

    query = db.query(Decision)

    if cascade_id:
        query = query.filter(Decision.cascade_id == cascade_id)

    if flight_id:
        query = query.filter(Decision.flight_id == flight_id)

    total = query.count()
    decisions = query.order_by(Decision.id.desc()).limit(limit).all()

    return {
        "total": total,
        "decisions": [decision_dict(decision) for decision in decisions]
    }
