"""Live check of every SPEC scenario against a running server on :8000.

    python verify_scenarios.py
"""

import json
import sys
import urllib.request

API = "http://127.0.0.1:8000"

failures = []
checks = 0


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"}
    )

    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode())


def check(label, condition, detail=""):
    global checks
    checks += 1

    if condition:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label} {detail}")
        failures.append(label)


def reset():
    call("POST", "/scenario/reset")


def snapshot():
    flights = call("GET", "/flights/")
    bags = call("GET", "/baggage/")

    return (
        sorted(
            (f["flight_id"], f["arrival_time"], f["departure_time"], f["gate_id"],
             f["crew_id"], f["status"], f["delay_minutes"])
            for f in flights
        ),
        sorted(
            (b["bag_id"], b["current_location"], b["status"], b["connecting_flight_id"])
            for b in bags
        )
    )


print("Preset 1 - double-conflict")
reset()
plan = call("POST", "/scenario/presets/double-conflict/run")
check("status RESOLVED", plan["status"] == "RESOLVED", plan["status"])
check("gate A1 -> A4", (plan["old_gate"], plan["new_gate"]) == ("A1", "A4"), str((plan["old_gate"], plan["new_gate"])))
check("crew C1 -> C3", (plan["old_crew"], plan["new_crew"]) == ("C1", "C3"), str((plan["old_crew"], plan["new_crew"])))
check("new window 09:30-10:10", plan["new_window"] == {"arrival": "09:30", "departure": "10:10"}, str(plan["new_window"]))
rerouted = [b for b in plan["baggage"] if b["new_location"] == "A4-STAGING"]
check("2 bags rerouted to A4-STAGING", len(rerouted) == 2, str(plan["baggage"]))
preview = {c["flight_id"]: c for c in plan["cascade_preview"]}
check("cascade_preview F102 gate risk", "F102" in preview and preview["F102"]["gate_risk"], str(plan["cascade_preview"]))
check("cascade_preview F103 crew risk", "F103" in preview and preview["F103"]["crew_risk"], str(plan["cascade_preview"]))
check("depth 0", plan["max_depth"] == 0, str(plan["max_depth"]))
check("integrity ok", call("GET", "/integrity")["ok"])

print("Preset 2 - cascade-bump")
reset()
plan = call("POST", "/scenario/presets/cascade-bump/run")
check("status RESOLVED", plan["status"] == "RESOLVED", plan["status"])
check("max_depth >= 1", plan["max_depth"] >= 1, str(plan["max_depth"]))
check("flights_touched has F201 and F202",
      set(["F201", "F202"]).issubset(set(plan["flights_touched"])), str(plan["flights_touched"]))
bumps = [a for a in plan["actions"] if a["type"] == "CASCADE_BUMP"]
check("CASCADE_BUMP on F202", len(bumps) == 1 and bumps[0]["flight_id"] == "F202", str(bumps))
f202 = call("GET", "/flights/F202")
check("F202 DELAYED", f202["status"] == "DELAYED", f202["status"])
check("F202 pushed to 11:10-11:50",
      (f202["arrival_time"], f202["departure_time"]) == ("11:10", "11:50"),
      str((f202["arrival_time"], f202["departure_time"])))
check("F202 got cross-terminal crew C3", f202["crew_id"] == "C3", str(f202["crew_id"]))
check("integrity ok", call("GET", "/integrity")["ok"])

print("Preset 3 - missed-connection")
reset()
plan = call("POST", "/scenario/presets/missed-connection/run")
check("status RESOLVED", plan["status"] == "RESOLVED", plan["status"])
rebooked = {b["bag_id"]: b["rebooked_to"] for b in plan["baggage"]}
check("B1041 rebooked to F107", rebooked.get("B1041") == "F107", str(rebooked))
check("B1042 rebooked to F107", rebooked.get("B1042") == "F107", str(rebooked))
bag = call("GET", "/baggage/B1041")
check("B1041 persisted on F107", bag["connecting_flight_id"] == "F107" and bag["status"] == "REROUTED", str(bag))
check("integrity ok", call("GET", "/integrity")["ok"])

print("Preset 4 - blocked")
reset()
before = snapshot()
plan = call("POST", "/scenario/presets/blocked/run")
check("status BLOCKED", plan["status"] == "BLOCKED", plan["status"])
blocked_actions = [a for a in plan["actions"] if a["type"] == "BLOCKED"]
check("BLOCKED decision is CRITICAL",
      len(blocked_actions) == 1 and blocked_actions[0]["severity"] == "CRITICAL", str(blocked_actions))
check("nothing committed", snapshot() == before)
check("blocked plan reports clean integrity", plan["integrity"]["ok"], json.dumps(plan["integrity"]["violations"]))
check("BLOCKED decision kept for the alert feed",
      any(d["type"] == "BLOCKED" for d in call("GET", "/decisions?flight_id=F203")["decisions"]))
check("integrity ok", call("GET", "/integrity")["ok"])

print("Preset 5 - evening-rush")
reset()
plan = call("POST", "/scenario/presets/evening-rush/run")
check("status RESOLVED", plan["status"] == "RESOLVED", plan["status"])
check("single hop", plan["max_depth"] == 0 and plan["flights_touched"] == ["F208"], str(plan["flights_touched"]))
check("gate B1 -> B2", (plan["old_gate"], plan["new_gate"]) == ("B1", "B2"), str((plan["old_gate"], plan["new_gate"])))
check("crew unchanged", plan["crew_reassigned"] is False and plan["new_crew"] == "D3", str(plan["new_crew"]))
check("new window 16:40-17:20", plan["new_window"] == {"arrival": "16:40", "departure": "17:20"}, str(plan["new_window"]))
check("conflict is F209 on B1",
      [(c["flight_id"], c["resource_id"]) for c in plan["conflicts_detected"]] == [("F209", "B1")],
      str(plan["conflicts_detected"]))
check("2 bags to B2-STAGING",
      len([b for b in plan["baggage"] if b["new_location"] == "B2-STAGING"]) == 2, str(plan["baggage"]))
check("no bag left at risk", not any(b["risk"] for b in plan["baggage"]), str(plan["baggage"]))
check("integrity ok", call("GET", "/integrity")["ok"])

print("Baseline connections are comfortable")
reset()
at_risk = [b for b in call("GET", "/baggage/") if b["status"] == "AT_RISK"]
check("no bag at risk at baseline", at_risk == [], str(at_risk))

print("Dry run - simulate does not persist, delay does")
reset()
before = snapshot()
plan = call("POST", "/flights/F101/simulate", {"delay_minutes": 30})
check("dry_run true", plan["dry_run"] is True)
check("simulated gate A1 -> A4", (plan["old_gate"], plan["new_gate"]) == ("A1", "A4"), str((plan["old_gate"], plan["new_gate"])))
check("simulate changed nothing", snapshot() == before)
check("simulate logged no decisions", call("GET", "/decisions?flight_id=F101")["total"] == 0)
applied = call("POST", "/flights/F101/delay", {"delay_minutes": 30})
check("apply commits the same plan",
      (applied["old_gate"], applied["new_gate"], applied["old_crew"], applied["new_crew"])
      == (plan["old_gate"], plan["new_gate"], plan["old_crew"], plan["new_crew"]))
check("apply changed the db", snapshot() != before)
check("decisions recorded", call("GET", "/decisions?flight_id=F101")["total"] > 0)
check("integrity ok", call("GET", "/integrity")["ok"])

print("Cancel")
cancelled = call("POST", "/flights/F106/cancel")
check("cancel frees gate and crew",
      cancelled["status"] == "CANCELLED" and cancelled["freed"]["gate"] == "A1", str(cancelled))
check("integrity ok", call("GET", "/integrity")["ok"])

print("Chaos")
reset()
result = call("POST", "/scenario/chaos", {"count": 3, "max_delay": 60})
check("chaos returned cascades", len(result["cascades"]) >= 1, result["summary"])
check("integrity ok after chaos", call("GET", "/integrity")["ok"],
      json.dumps(call("GET", "/integrity")["violations"]))
for plan in result["cascades"]:
    check(f"chaos plan {plan['root_flight']} integrity ok", plan["integrity"]["ok"])

print("Story mode - the five presets in order, no reset in between")
reset()
story = call("GET", "/scenario/story")
check("story has 5 beats in clock order",
      [beat["at"] for beat in story] == ["08:45", "09:15", "10:30", "11:05", "15:45"],
      str([beat["at"] for beat in story]))
check("story beats carry title and narration",
      all(beat["title"] and beat["narration"] and beat["preset"] for beat in story))

story_plans = {}
for beat in story:
    story_plans[beat["preset"]] = call("POST", f"/scenario/presets/{beat['preset']}/run")
    check(f"story {beat['at']} {beat['preset']} integrity ok", call("GET", "/integrity")["ok"])

plan = story_plans["double-conflict"]
check("story: F101 gate A1->A4 crew C1->C3",
      (plan["status"], plan["new_gate"], plan["new_crew"]) == ("RESOLVED", "A4", "C3"), str(plan["summary"]))
plan = story_plans["cascade-bump"]
check("story: F201 bumps F202 at depth 1",
      plan["status"] == "RESOLVED" and plan["max_depth"] == 1
      and set(plan["flights_touched"]) == {"F201", "F202"}, str(plan["summary"]))
check("story: F202 on 11:10-11:50 with crew C3",
      (call("GET", "/flights/F202")["arrival_time"], call("GET", "/flights/F202")["crew_id"]) == ("11:10", "C3"))
plan = story_plans["blocked"]
check("story: F203 still BLOCKED mid-day", plan["status"] == "BLOCKED", str(plan["summary"]))
check("story: F203 untouched", call("GET", "/flights/F203")["status"] == "ON_TIME")
plan = story_plans["missed-connection"]
check("story: bags still rebooked to F107",
      [b["rebooked_to"] for b in plan["baggage"]] == ["F107", "F107"], str(plan["baggage"]))
plan = story_plans["evening-rush"]
check("story: F208 gate B1->B2 single hop",
      (plan["status"], plan["old_gate"], plan["new_gate"], plan["max_depth"]) == ("RESOLVED", "B1", "B2", 0),
      str(plan["summary"]))
check("story: every plan timed", all(p["resolution_ms"] >= 0 for p in story_plans.values()))
check("story: guarantee held", call("GET", "/integrity")["ok"])

report = call("GET", "/report")
check("report keys",
      set(report.keys()) == {"generated_at", "airport", "metrics", "disruptions", "flights",
                             "baggage_exceptions", "guarantee"}, str(list(report.keys())))
check("report airport", report["airport"] == {"terminals": 2, "gates": 7, "crews": 8}, str(report["airport"]))
check("report has 5 disruptions newest first",
      len(report["disruptions"]) == 5
      and report["disruptions"][0]["root_flight"] == "F208", str([d["root_flight"] for d in report["disruptions"]]))
check("report marks the blocked one",
      [d["status"] for d in report["disruptions"] if d["root_flight"] == "F203"] == ["Blocked"])
check("report disruption fields",
      set(report["disruptions"][0].keys()) == {"cascade_id", "root_flight", "airline", "route",
                                               "delay_minutes", "status", "summary", "resolution_ms", "actions"},
      str(list(report["disruptions"][0].keys())))
check("report flight rows", len(report["flights"]) == 25 and "scheduled" in report["flights"][0])
check("report baggage exceptions",
      {b["bag_id"] for b in report["baggage_exceptions"]} >= {"B1041", "B1042"},
      str(report["baggage_exceptions"]))
check("report guarantee ok", report["guarantee"]["ok"])

hero = report["metrics"]
check("metrics.passengers_protected", hero["passengers_protected"] > 0, str(hero["passengers_protected"]))
check("metrics.bags_rebooked == 2", hero["bags_rebooked"] == 2, str(hero["bags_rebooked"]))
check("metrics.delay_minutes_absorbed", hero["delay_minutes_absorbed"] == 30 + 45 + 40 + 90 + 40,
      str(hero["delay_minutes_absorbed"]))
check("metrics.disruptions_today == 5", hero["disruptions_today"] == 5, str(hero["disruptions_today"]))
check("metrics.decisions_total", hero["decisions_total"] > 10, str(hero["decisions_total"]))
check("metrics.avg_resolution_ms", hero["avg_resolution_ms"] > 0, str(hero["avg_resolution_ms"]))
check("metrics.last_resolution_ms", hero["last_resolution_ms"] is not None)

print("Endpoint shapes")
reset()
call("POST", "/scenario/presets/double-conflict/run")
metrics = call("GET", "/metrics")
for key in ["total_flights", "on_time", "delayed", "cancelled", "on_time_pct", "avg_delay_minutes",
            "conflicts_resolved", "reassignments", "cascade_bumps", "bags_total", "bags_at_risk",
            "gate_utilization_pct", "crew_utilization_pct", "integrity_violations", "last_decision_at"]:
    check(f"metrics.{key}", key in metrics)
check("metrics counts the reassignments", metrics["reassignments"] == 2, str(metrics["reassignments"]))

timeline = call("GET", "/timeline")
check("timeline window", timeline["window"] == {"start": "06:00", "end": "22:00"})
check("timeline gates", len(timeline["gates"]) == 7 and "blocks" in timeline["gates"][0])
check("timeline crews", len(timeline["crews"]) == 8 and "shift" in timeline["crews"][0])
evening = [b for g in timeline["gates"] for b in g["blocks"] if b["start"] >= "15:00"]
check("evening bank is populated", len(evening) >= 8, str(len(evening)))

dashboard = call("GET", "/dashboard/")
check("dashboard keys", set(dashboard.keys()) == {"flights", "gates", "crew", "baggage", "metrics"}, str(list(dashboard.keys())))

alerts = call("GET", "/alerts/")
check("alerts shape", "total_alerts" in alerts and alerts["total_alerts"] == len(alerts["alerts"]))
check("alerts include FLIGHT_DELAY", any(a["type"] == "FLIGHT_DELAY" for a in alerts["alerts"]))

decisions = call("GET", "/decisions?limit=5")
check("decisions newest first",
      decisions["decisions"][0]["id"] > decisions["decisions"][-1]["id"], str([d["id"] for d in decisions["decisions"]]))

cascade = call("GET", "/flights/F101/cascade")
check("cascade shape",
      set(["root_flight", "delay_minutes", "status", "current_gate", "current_crew", "affected_flights",
           "affected_baggage", "total_affected_flights", "total_affected_bags"]).issubset(cascade.keys()))

presets = call("GET", "/scenario/presets")
check("5 presets", len(presets) == 5 and all(
    set(["id", "name", "description", "flight_id", "delay_minutes", "expected"]).issubset(p.keys())
    for p in presets))

reset()

print()
print(f"{checks - len(failures)}/{checks} checks passed")

if failures:
    print("FAILED:", ", ".join(failures))
    sys.exit(1)

print("ALL SCENARIOS VERIFIED")
