import random

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Flight
from schemas import ChaosRequest
from seed import seed
from resolver import run_resolution, log_decision, new_cascade_id

router = APIRouter(
    prefix="/scenario",
    tags=["Scenario"]
)


PRESETS = [
    {
        "id": "double-conflict",
        "name": "Double conflict",
        "description": "F101 lands 30 min late: its gate is taken by F102 and its crew is due on F103.",
        "flight_id": "F101",
        "delay_minutes": 30,
        "expected": "RESOLVED - gate A1->A4, crew C1->C3, 2 bags rerouted to A4-STAGING, "
                    "F102 (gate) and F103 (crew) would have collided."
    },
    {
        "id": "cascade-bump",
        "name": "Cascade bump",
        "description": "F201 lands 45 min late in T2 where B3 is under maintenance and B2 is busy, "
                       "so the lower-priority F202 has to be pushed.",
        "flight_id": "F201",
        "delay_minutes": 45,
        "expected": "RESOLVED at depth 1 - no free T2 gate, so F202 (priority 2) is pushed 40 min "
                    "to 11:10-11:50 and loses crew D1 to rest rules, picking up cross-terminal crew C3."
    },
    {
        "id": "missed-connection",
        "name": "Missed connection",
        "description": "F104 lands 90 min late and its two transfer bags no longer make F105 to BOM.",
        "flight_id": "F104",
        "delay_minutes": 90,
        "expected": "RESOLVED - bags B1041 and B1042 have 20 min to F105 (30 needed) and are "
                    "rebooked onto F107 to BOM."
    },
    {
        "id": "blocked",
        "name": "Nothing left to give",
        "description": "F203 lands 60 min late into the T2 afternoon peak: B1 and B2 are both taken "
                       "and B3 is under maintenance.",
        "flight_id": "F203",
        "delay_minutes": 60,
        "expected": "BLOCKED - F204 (priority 5) outranks F203 so it cannot be pushed and no gate "
                    "is free; nothing is committed."
    },
    {
        "id": "evening-rush",
        "name": "Evening rush",
        "description": "F208 to London pushes back 40 min and runs into F209 arriving onto the "
                       "same stand during the T2 evening bank.",
        "flight_id": "F208",
        "delay_minutes": 40,
        "expected": "RESOLVED in one hop - new window 16:40-17:20 clashes with F209 (17:30) on B1, "
                    "so F208 moves to B2 and its 2 bags follow to B2-STAGING; crew D3 keeps the turn."
    }
]


# Verified end to end in this order, from one reset, with state accumulating.
STORY = [
    {
        "at": "08:45",
        "preset": "double-conflict",
        "title": "Gate and crew collide",
        "narration": "SkyWays 101 is running thirty minutes late out of Delhi, and the stand it "
                     "was heading for is already promised to another aircraft, so AeroMind walks "
                     "it over to A4 and hands the turn to a rested crew."
    },
    {
        "at": "09:15",
        "preset": "cascade-bump",
        "title": "One delay, two flights",
        "narration": "GulfStar 201 slips forty-five minutes and with B3 closed for maintenance "
                     "there is no free stand, so AeroMind pushes the lower-priority GulfStar 202 "
                     "back forty minutes and flies a crew across from Terminal 1."
    },
    {
        "at": "10:30",
        "preset": "blocked",
        "title": "Nothing left to give",
        "narration": "EastWind 203 loses an hour and this time every stand is spoken for, so "
                     "AeroMind refuses to shove a higher-priority departure aside and escalates "
                     "to a human instead of breaking the guarantee."
    },
    {
        "at": "11:05",
        "preset": "missed-connection",
        "title": "Bags that would have missed",
        "narration": "IndiGlow 104 lands ninety minutes late and two transfer bags can no longer "
                     "make their Mumbai connection, so AeroMind rebooks them onto F107 before "
                     "they are ever loaded."
    },
    {
        "at": "15:45",
        "preset": "evening-rush",
        "title": "Evening bank squeeze",
        "narration": "The evening bank begins: GulfStar 208 to London pushes back forty minutes "
                     "into the stand EastWind 209 is about to need, and AeroMind clears it with "
                     "a single move to B2."
    }
]


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.get("/presets")
def get_presets():
    return PRESETS


@router.get("/story")
def get_story():
    return STORY


@router.post("/presets/{preset_id}/run")
def run_preset(
    preset_id: str,
    db: Session = Depends(get_db)
):

    preset = next((p for p in PRESETS if p["id"] == preset_id), None)

    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    flight = db.query(Flight).filter(
        Flight.flight_id == preset["flight_id"]
    ).first()

    if not flight:
        raise HTTPException(status_code=404, detail="Preset flight not found")

    plan = run_resolution(db, flight, preset["delay_minutes"], dry_run=False)
    plan["preset"] = preset["id"]

    return plan


@router.post("/reset")
def reset_scenario(db: Session = Depends(get_db)):

    counts = seed(db)

    log_decision(
        db, "SCENARIO_RESET", None, "SYSTEM",
        f"Scenario reset to baseline: {counts['flights']} flights, {counts['gates']} gates, "
        f"{counts['crew']} crews, {counts['baggage']} bags",
        "INFO"
    )
    db.commit()

    return {"message": "Scenario reset", "counts": counts}


@router.post("/chaos")
def chaos(
    request: ChaosRequest,
    db: Session = Depends(get_db)
):

    candidates = [
        flight.flight_id for flight in db.query(Flight).filter(
            Flight.status == "ON_TIME"
        ).all()
    ]

    picked = random.sample(candidates, min(request.count, len(candidates)))

    cascade_id = new_cascade_id()
    plans = []
    blocked = 0

    for flight_id in picked:
        flight = db.query(Flight).filter(Flight.flight_id == flight_id).first()

        if not flight or flight.status == "CANCELLED":
            continue

        minutes = 5 * random.randint(3, max(3, request.max_delay // 5))

        try:
            plan = run_resolution(db, flight, minutes, dry_run=False)
        except HTTPException:
            db.rollback()
            continue

        if plan["status"] == "BLOCKED":
            blocked += 1

        plans.append(plan)

    reassignments = sum(
        len([a for a in plan["actions"] if a["type"] in ("GATE_REASSIGNED", "CREW_REASSIGNED")])
        for plan in plans
    )
    bumps = sum(
        len([a for a in plan["actions"] if a["type"] == "CASCADE_BUMP"])
        for plan in plans
    )

    summary = (
        f"Chaos hit {len(plans)} flight(s): {len(plans) - blocked} resolved, {blocked} blocked, "
        f"{reassignments} reassignment(s), {bumps} cascade bump(s)"
    )

    log_decision(
        db, "CHAOS_TRIGGERED", None, "SYSTEM", summary, "HIGH", cascade_id=cascade_id
    )
    db.commit()

    return {"cascades": plans, "summary": summary}
