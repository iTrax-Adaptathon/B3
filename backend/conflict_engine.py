from rules import GATE_BUFFER_MIN, CREW_REST_MIN


def time_to_minutes(time_string):
    hours, minutes = time_string.split(":")
    return int(hours) * 60 + int(minutes)


def minutes_to_time(total_minutes):
    if total_minutes > 23 * 60 + 59:
        total_minutes = 23 * 60 + 59
    if total_minutes < 0:
        total_minutes = 0

    return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"


def windows_conflict(arrival1, departure1, arrival2, departure2, buffer_minutes=0):
    """Windows conflict when each one, extended by the buffer after departure,
    overlaps the other."""

    start1 = time_to_minutes(arrival1)
    end1 = time_to_minutes(departure1) + buffer_minutes

    start2 = time_to_minutes(arrival2)
    end2 = time_to_minutes(departure2) + buffer_minutes

    return start1 < end2 and start2 < end1


def overlap_minutes(arrival1, departure1, arrival2, departure2, buffer_minutes=0):

    start1 = time_to_minutes(arrival1)
    end1 = time_to_minutes(departure1) + buffer_minutes

    start2 = time_to_minutes(arrival2)
    end2 = time_to_minutes(departure2) + buffer_minutes

    return max(0, min(end1, end2) - max(start1, start2))


def check_gate_conflict(
    db,
    gate_id,
    arrival_time,
    departure_time,
    exclude_flight_id=None,
    buffer_minutes=GATE_BUFFER_MIN
):
    from models import Flight

    if not gate_id:
        return None

    query = db.query(Flight).filter(
        Flight.gate_id == gate_id,
        Flight.status != "CANCELLED"
    )

    if exclude_flight_id is not None:
        query = query.filter(Flight.flight_id != exclude_flight_id)

    for flight in query.all():

        if windows_conflict(
            arrival_time,
            departure_time,
            flight.arrival_time,
            flight.departure_time,
            buffer_minutes
        ):
            return flight

    return None


def check_crew_conflict(
    db,
    crew_id,
    arrival_time,
    departure_time,
    exclude_flight_id=None,
    buffer_minutes=CREW_REST_MIN
):
    from models import Flight

    if not crew_id:
        return None

    query = db.query(Flight).filter(
        Flight.crew_id == crew_id,
        Flight.status != "CANCELLED"
    )

    if exclude_flight_id is not None:
        query = query.filter(Flight.flight_id != exclude_flight_id)

    for flight in query.all():

        if windows_conflict(
            arrival_time,
            departure_time,
            flight.arrival_time,
            flight.departure_time,
            buffer_minutes
        ):
            return flight

    return None


def add_delay(time_string, delay_minutes):
    return minutes_to_time(time_to_minutes(time_string) + delay_minutes)
