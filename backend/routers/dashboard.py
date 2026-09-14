from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from dashboard import get_dashboard_data


router = APIRouter(
    prefix="/dashboard",
    tags=["Dashboard"]
)


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.get("/")
def dashboard(
    db: Session = Depends(get_db)
):
    return get_dashboard_data(db)