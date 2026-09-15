from typing import Optional

from pydantic import BaseModel


class FlightCreate(BaseModel):
    flight_id: str
    arrival_time: str
    departure_time: str
    terminal: str
    gate_id: str
    crew_id: str
    airline: str = ""
    origin: str = ""
    destination: str = ""
    aircraft: str = ""
    delay_minutes: int = 0
    status: str = "ON_TIME"
    priority: int = 2
    passengers: int = 0


class GateCreate(BaseModel):
    gate_id: str
    terminal: str
    status: str = "AVAILABLE"


class CrewCreate(BaseModel):
    crew_id: str
    terminal: str
    available_from: str
    available_until: str
    status: str = "AVAILABLE"


class BaggageCreate(BaseModel):
    bag_id: str
    flight_id: str
    current_location: str
    connecting_flight_id: Optional[str] = None
    status: str = "IN_TRANSIT"


class FlightDelay(BaseModel):
    delay_minutes: int


class ChaosRequest(BaseModel):
    count: int = 3
    max_delay: int = 60
