from sqlalchemy import Column, Integer, String, Float
from database import Base


class Flight(Base):
    __tablename__ = "flights"

    id = Column(Integer, primary_key=True, index=True)
    flight_id = Column(String, unique=True, index=True)
    airline = Column(String, default="")
    origin = Column(String, default="")
    destination = Column(String, default="")
    aircraft = Column(String, default="")
    terminal = Column(String)
    gate_id = Column(String)
    crew_id = Column(String)
    scheduled_arrival = Column(String)
    scheduled_departure = Column(String)
    arrival_time = Column(String)
    departure_time = Column(String)
    delay_minutes = Column(Integer, default=0)
    status = Column(String, default="ON_TIME")
    priority = Column(Integer, default=2)
    passengers = Column(Integer, default=0)


class Gate(Base):
    __tablename__ = "gates"

    id = Column(Integer, primary_key=True, index=True)
    gate_id = Column(String, unique=True, index=True)
    terminal = Column(String)
    status = Column(String, default="AVAILABLE")


class Crew(Base):
    __tablename__ = "crew"

    id = Column(Integer, primary_key=True, index=True)
    crew_id = Column(String, unique=True, index=True)
    terminal = Column(String)
    available_from = Column(String)
    available_until = Column(String)
    status = Column(String, default="AVAILABLE")


class Baggage(Base):
    __tablename__ = "baggage"

    id = Column(Integer, primary_key=True, index=True)
    bag_id = Column(String, unique=True, index=True)
    flight_id = Column(String)
    connecting_flight_id = Column(String, nullable=True)
    current_location = Column(String)
    status = Column(String, default="IN_TRANSIT")


class Decision(Base):
    __tablename__ = "decisions"

    id = Column(Integer, primary_key=True, index=True)
    cascade_id = Column(String, index=True)
    depth = Column(Integer, default=0)
    timestamp = Column(String)
    type = Column(String)
    flight_id = Column(String, index=True)
    resource_type = Column(String)
    from_value = Column(String, nullable=True)
    to_value = Column(String, nullable=True)
    reason = Column(String)
    severity = Column(String, default="INFO")
    resolution_ms = Column(Float, nullable=True)
