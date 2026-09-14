from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Gate
from schemas import GateCreate


router = APIRouter(
    prefix="/gates",
    tags=["Gates"]
)


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.post("/")
def create_gate(
    gate: GateCreate,
    db: Session = Depends(get_db)
):
    new_gate = Gate(
        gate_id=gate.gate_id,
        terminal=gate.terminal,
        status=gate.status
    )

    db.add(new_gate)
    db.commit()
    db.refresh(new_gate)

    return new_gate


@router.get("/")
def get_gates(db: Session = Depends(get_db)):
    return db.query(Gate).all()


@router.get("/{gate_id}")
def get_gate(
    gate_id: str,
    db: Session = Depends(get_db)
):
    return db.query(Gate).filter(
        Gate.gate_id == gate_id
    ).first()