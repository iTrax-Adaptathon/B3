from sqlalchemy import Column, Integer, String
from database import Base


class Flight(Base):
    __tablename__ = "flights"

    id = Column(Integer, primary_key=True, index=True)
    flight_id = Column(String, unique=True, index=True)
    arrival_time = Column(String)
    departure_time = Column(String)
    terminal = Column(String)
    gate_id = Column(String)
    crew_id = Column(String)
    delay_minutes = Column(Integer, default=0)
    status = Column(String, default="ON_TIME")


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
    current_location = Column(String)
    status = Column(String, default="IN_TRANSIT")