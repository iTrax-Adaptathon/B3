"""Seed the AeroMind demo scenario (SPEC section 5).

Baseline has zero integrity violations: every gate and crew respects the
turnaround buffer and rest gap. The presets in routers/scenario.py each break
it in a different way.
"""

from database import engine, Base, SessionLocal
from models import Flight, Gate, Crew, Baggage, Decision


GATES = [
    ("A1", "T1", "AVAILABLE"),
    ("A2", "T1", "AVAILABLE"),
    ("A3", "T1", "AVAILABLE"),
    ("A4", "T1", "AVAILABLE"),
    ("B1", "T2", "AVAILABLE"),
    ("B2", "T2", "AVAILABLE"),
    ("B3", "T2", "MAINTENANCE"),
]

CREWS = [
    ("C1", "T1", "06:00", "14:00"),
    ("C2", "T1", "06:00", "20:00"),
    ("C3", "T1", "08:00", "20:00"),
    ("C4", "T1", "12:00", "22:00"),
    ("D1", "T2", "06:00", "18:00"),
    ("D2", "T2", "10:00", "22:00"),
    ("C5", "T1", "14:00", "22:00"),
    ("D3", "T2", "14:00", "22:00"),
]

# flight, airline, origin, dest, aircraft, arrival, departure, terminal, gate, crew, priority, passengers
FLIGHTS = [
    ("F101", "SkyWays", "DEL", "BLR", "A320", "09:00", "09:40", "T1", "A1", "C1", 3, 180),
    ("F102", "AirNova", "HYD", "BLR", "A320", "10:00", "10:40", "T1", "A1", "C2", 2, 150),
    ("F103", "SkyWays", "MAA", "BLR", "B737", "10:05", "10:45", "T1", "A2", "C1", 2, 120),
    ("F104", "IndiGlow", "CCU", "BLR", "A321", "11:20", "12:00", "T1", "A2", "C2", 4, 210),
    ("F105", "AirNova", "BLR", "BOM", "A320", "12:30", "13:10", "T1", "A3", "C3", 1, 90),
    ("F106", "SkyWays", "BLR", "GOI", "B737", "13:30", "14:10", "T1", "A1", "C4", 2, 140),
    ("F107", "IndiGlow", "BLR", "BOM", "A321", "14:30", "15:10", "T1", "A4", "C3", 3, 170),
    ("F108", "AirNova", "PNQ", "BLR", "A320", "08:00", "08:40", "T1", "A3", "C3", 2, 110),
    ("F201", "GulfStar", "DXB", "BLR", "B788", "09:30", "10:10", "T2", "B1", "D1", 3, 160),
    ("F202", "GulfStar", "DOH", "BLR", "A333", "10:30", "11:10", "T2", "B1", "D1", 2, 130),
    ("F203", "EastWind", "SIN", "BLR", "B788", "10:45", "11:25", "T2", "B2", "D2", 3, 150),
    ("F204", "EastWind", "BLR", "SIN", "B788", "12:30", "13:10", "T2", "B2", "D2", 5, 80),
    ("F205", "GulfStar", "BLR", "DXB", "A333", "12:30", "13:10", "T2", "B1", "D1", 2, 140),
    # Early bank and evening bank. These never touch the 09:00-13:10 windows of the
    # gates and crews the presets depend on, and no new flight is bound for BOM, so
    # the F104 rebooking target stays F107.
    ("F109", "IndiGlow", "BLR", "DEL", "A320", "06:30", "07:10", "T1", "A3", "C1", 2, 165),
    ("F110", "SkyWays", "BLR", "HYD", "B737", "07:00", "07:40", "T1", "A2", "C2", 2, 140),
    ("F111", "AirNova", "BLR", "CCU", "A320", "15:40", "16:20", "T1", "A1", "C3", 3, 185),
    ("F112", "SkyLine", "MAA", "BLR", "A321", "17:00", "17:40", "T1", "A2", "C5", 2, 175),
    ("F115", "SkyWays", "BLR", "PNQ", "A320", "18:20", "19:00", "T1", "A4", "C5", 2, 130),
    ("F113", "AirNova", "BLR", "GOI", "B737", "19:00", "19:40", "T1", "A3", "C4", 1, 95),
    ("F114", "IndiGlow", "BLR", "AMD", "A320", "20:30", "21:10", "T1", "A1", "C5", 2, 150),
    ("F206", "SkyLine", "BLR", "AUH", "A333", "07:30", "08:10", "T2", "B1", "D1", 2, 195),
    ("F207", "Aeronet", "DXB", "BLR", "B788", "14:00", "14:40", "T2", "B2", "D2", 3, 225),
    ("F208", "GulfStar", "BLR", "LHR", "B788", "16:00", "16:40", "T2", "B1", "D3", 4, 260),
    ("F209", "EastWind", "SIN", "BLR", "A333", "17:30", "18:10", "T2", "B1", "D2", 3, 210),
    ("F210", "SkyLine", "BLR", "DXB", "A333", "20:40", "21:20", "T2", "B2", "D3", 2, 165),
]

# bag, flight, connecting flight
BAGS = [
    ("B1011", "F101", None),
    ("B1012", "F101", None),
    ("B1021", "F102", None),
    ("B1022", "F102", None),
    ("B1031", "F103", None),
    ("B1041", "F104", "F105"),
    ("B1042", "F104", "F105"),
    ("B1051", "F105", None),
    ("B1061", "F106", None),
    ("B1062", "F106", None),
    ("B1071", "F107", None),
    ("B1081", "F108", None),
    ("B2011", "F201", "F203"),
    ("B2012", "F201", None),
    ("B2021", "F202", None),
    ("B2022", "F202", None),
    ("B2031", "F203", None),
    ("B2041", "F204", None),
    ("B2051", "F205", None),
    ("B2052", "F205", None),
    ("B1091", "F109", None),
    ("B1092", "F109", None),
    ("B1101", "F110", None),
    ("B1102", "F110", None),
    ("B1111", "F111", None),
    ("B1112", "F111", None),
    ("B1121", "F112", "F113"),
    ("B1122", "F112", None),
    ("B1131", "F113", None),
    ("B1132", "F113", None),
    ("B1141", "F114", None),
    ("B1142", "F114", None),
    ("B1151", "F115", None),
    ("B1152", "F115", None),
    ("B2061", "F206", None),
    ("B2062", "F206", None),
    ("B2071", "F207", "F208"),
    ("B2072", "F207", "F208"),
    ("B2073", "F207", None),
    ("B2081", "F208", None),
    ("B2082", "F208", None),
    ("B2091", "F209", "F210"),
    ("B2092", "F209", None),
    ("B2101", "F210", None),
    ("B2102", "F210", None),
]


def seed(db, clear_decisions=True):

    db.query(Baggage).delete()
    db.query(Flight).delete()
    db.query(Crew).delete()
    db.query(Gate).delete()

    if clear_decisions:
        db.query(Decision).delete()

    for gate_id, terminal, status in GATES:
        db.add(Gate(gate_id=gate_id, terminal=terminal, status=status))

    for crew_id, terminal, start, end in CREWS:
        db.add(Crew(
            crew_id=crew_id,
            terminal=terminal,
            available_from=start,
            available_until=end,
            status="AVAILABLE"
        ))

    terminals = {}

    for (flight_id, airline, origin, destination, aircraft, arrival,
         departure, terminal, gate_id, crew_id, priority, passengers) in FLIGHTS:

        terminals[flight_id] = terminal

        db.add(Flight(
            flight_id=flight_id,
            airline=airline,
            origin=origin,
            destination=destination,
            aircraft=aircraft,
            terminal=terminal,
            gate_id=gate_id,
            crew_id=crew_id,
            scheduled_arrival=arrival,
            scheduled_departure=departure,
            arrival_time=arrival,
            departure_time=departure,
            delay_minutes=0,
            status="ON_TIME",
            priority=priority,
            passengers=passengers
        ))

    for bag_id, flight_id, connecting in BAGS:
        db.add(Baggage(
            bag_id=bag_id,
            flight_id=flight_id,
            connecting_flight_id=connecting,
            current_location=f"{terminals[flight_id]}-CLAIM",
            status="IN_TRANSIT"
        ))

    db.commit()

    return {
        "flights": len(FLIGHTS),
        "gates": len(GATES),
        "crew": len(CREWS),
        "baggage": len(BAGS)
    }


if __name__ == "__main__":
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    counts = seed(db)

    from integrity import verify_integrity
    result = verify_integrity(db)

    db.close()

    print("Seed complete:", counts)
    print("Baseline integrity ok:", result["ok"], "violations:", len(result["violations"]))
    for violation in result["violations"]:
        print(" -", violation["detail"])
