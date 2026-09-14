from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Crew
from schemas import CrewCreate


router = APIRouter(
    prefix="/crew",
    tags=["Crew"]
)


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.post("/")
def create_crew(
    crew: CrewCreate,
    db: Session = Depends(get_db)
):
    new_crew = Crew(
        crew_id=crew.crew_id,
        terminal=crew.terminal,
        available_from=crew.available_from,
        available_until=crew.available_until,
        status=crew.status
    )

    db.add(new_crew)
    db.commit()
    db.refresh(new_crew)

    return new_crew


@router.get("/")
def get_crew(db: Session = Depends(get_db)):
    return db.query(Crew).all()


@router.get("/{crew_id}")
def get_crew_member(
    crew_id: str,
    db: Session = Depends(get_db)
):
    return db.query(Crew).filter(
        Crew.crew_id == crew_id
    ).first()