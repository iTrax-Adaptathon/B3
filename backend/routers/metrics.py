from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from metrics import compute_metrics
from integrity import verify_integrity

router = APIRouter(tags=["Metrics"])


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.get("/metrics")
def get_metrics(db: Session = Depends(get_db)):
    return compute_metrics(db)


@router.get("/integrity")
def get_integrity(db: Session = Depends(get_db)):
    return verify_integrity(db)
