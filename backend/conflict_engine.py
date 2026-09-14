from datetime import datetime


def time_to_minutes(time_string):
    time = datetime.strptime(time_string, "%H:%M")
    return time.hour * 60 + time.minute


def times_overlap(start1, end1, start2, end2):

    start1 = time_to_minutes(start1)
    end1 = time_to_minutes(end1)

    start2 = time_to_minutes(start2)
    end2 = time_to_minutes(end2)

    return start1 < end2 and start2 < end1


def check_gate_conflict(
    db,
    gate_id,
    arrival_time,
    departure_time
):
    from models import Flight

    flights = db.query(Flight).filter(
        Flight.gate_id == gate_id
    ).all()

    for flight in flights:

        if times_overlap(
            arrival_time,
            departure_time,
            flight.arrival_time,
            flight.departure_time
        ):
            return flight

    return None


def check_crew_conflict(
    db,
    crew_id,
    arrival_time,
    departure_time
):
    from models import Flight

    flights = db.query(Flight).filter(
        Flight.crew_id == crew_id
    ).all()

    for flight in flights:

        if times_overlap(
            arrival_time,
            departure_time,
            flight.arrival_time,
            flight.departure_time
        ):
            return flight

    return None

def add_delay(time_string, delay_minutes):

    total_minutes = time_to_minutes(time_string)

    total_minutes += delay_minutes

    hours = total_minutes // 60
    minutes = total_minutes % 60

    return f"{hours:02d}:{minutes:02d}"