# AeroMind — Autonomous Airport Operations Control

> One delay. Every ripple. Resolved in seconds.

Hackathon Q3 build. This document is the **single source of truth** for the product concept, data model, engine rules, API contract, seed scenario, and UI. Backend and frontend are built in parallel against this contract — do not deviate from field names or endpoint shapes without updating this file.

Stack stays what it is: FastAPI + SQLAlchemy + SQLite backend (`backend/`), single-file vanilla HTML/CSS/JS frontend (`frontend/index.html`, **no build step, no CDN** — the demo may run on flaky wifi).

---

## 1. Product concept

**Problem (Q3):** A flight is late by 40 minutes. Its gate is now occupied. The next aircraft has nowhere to go. A crew is waiting at the wrong terminal. Baggage is moving toward a flight that hasn't arrived. Every decision fixes one problem while creating another.

**What AeroMind does:** when a delay hits, it (1) detects every resource conflict the new schedule creates, (2) resolves them autonomously — reassigning gates, crews and baggage routing, and when no resource is free, *pushing the lower-priority flight* and resolving *its* conflicts recursively, (3) records every decision with a plain-English reason, and (4) proves after every change that the hard invariant still holds: **no two flights share a gate or a crew at overlapping times.**

Judging requirements → features:

| Requirement | Feature |
|---|---|
| Reassign gates, crews, baggage dynamically | Resolver engine + baggage rerouting + misconnection rebooking |
| Guarantee no double-booked gate/crew | `verify_integrity()` runs after every commit; endpoint `/integrity`; UI badge "0 violations" |
| Propagate effects through dependent resources | Multi-hop cascade solver (bump lower-priority flight, resolve its conflicts, depth ≤ 3) + decision log grouped by `cascade_id` |
| Surface knock-on impact *before* it compounds | Dry-run `POST /flights/{id}/simulate` returns the full plan without committing; UI shows a preview/diff before "Apply" |

---

## 2. Domain rules & constants (`backend/rules.py`)

```
GATE_BUFFER_MIN     = 15   # min gap between consecutive flights on the same gate
CREW_REST_MIN       = 20   # min gap between consecutive assignments for a crew
CREW_TRANSIT_MIN    = 30   # extra lead time if crew's home terminal != flight terminal
MIN_CONNECTION_MIN  = 30   # bag must have >= this between arrival and connecting departure
MAX_CASCADE_DEPTH   = 3    # hops of "bump the lower-priority flight" allowed
DAY_START, DAY_END  = "06:00", "22:00"   # timeline window
```

Time is `"HH:MM"` same-day strings (existing helpers `time_to_minutes`, `add_delay`; clamp at `23:59`).

**Conflict definitions**
- Gate conflict: two flights on the same gate whose windows overlap when each window is extended by `GATE_BUFFER_MIN` after departure.
- Crew conflict: same crew, windows overlap when extended by `CREW_REST_MIN`; also a conflict if the window falls outside `available_from..available_until`; if crew terminal ≠ flight terminal the flight's arrival must be ≥ previous assignment end + `CREW_REST_MIN + CREW_TRANSIT_MIN`.
- Bag at risk: `connecting_flight.departure - flight.arrival < MIN_CONNECTION_MIN`.

**Resolver algorithm — `resolve_delay(db, flight, minutes, dry_run, cascade_id, depth=0)`**
1. Compute new window. Record `DELAY_APPLIED`.
2. Gate: if conflict on current gate → pick best free gate in the same terminal (must be `AVAILABLE`, conflict-free with buffer). Score = number of flights already on gate (lower better), tie-break smallest gap slack. Record `GATE_REASSIGNED` with reason naming the conflicting flight + window. Reroute this flight's bags to `"{gate}-STAGING"` → `BAGGAGE_REROUTED`.
3. Crew: if conflict → pick best crew: same terminal first (score = shift slack after new departure, higher better), else cross-terminal crew (allowed with transit rule; reason says "cross-terminal, 30 min transit"). Record `CREW_REASSIGNED`.
4. If **no gate** (or no crew) is free: find the conflicting flight; if its `priority < this.priority` and `depth < MAX_CASCADE_DEPTH` → **bump** it: push it later by the minimum minutes that clears the buffer, record `CASCADE_BUMP` (depth+1), then recursively `resolve_delay` on it. If it cannot be bumped → record `BLOCKED` (severity CRITICAL), plan `status = "BLOCKED"`, nothing is committed.
5. Bags: for each bag on this flight with `connecting_flight_id`, if connection < `MIN_CONNECTION_MIN` → `BAGGAGE_AT_RISK`; if a later flight exists with the same `destination` as the connecting flight and enough connection time → rebook (`connecting_flight_id` updated, status `REROUTED`, `BAGGAGE_REBOOKED`), else status `AT_RISK`.
6. Write everything, then `verify_integrity()`; if any violation → rollback + HTTP 500 `{"detail": "Integrity violation", "violations": [...]}` (this must never happen; it's the safety net). If `dry_run` → rollback always, return the plan with `dry_run: true`.
7. Every plan gets a `cascade_id` (`"csc_" + 6 hex`) shared by all its decisions.

---

## 3. Data model (SQLAlchemy, SQLite). Dropping and recreating `airport.db` is fine.

**Flight** — keep existing column names, add new ones
```
flight_id (unique), airline, origin, destination, aircraft, terminal,
gate_id, crew_id,
scheduled_arrival, scheduled_departure,        # original, never changes
arrival_time, departure_time,                  # current (existing names)
delay_minutes int=0, status str="ON_TIME",     # ON_TIME | DELAYED | CANCELLED
priority int=2 (1 low … 5 high), passengers int
```
**Gate**: `gate_id, terminal, status ("AVAILABLE" | "OCCUPIED" | "MAINTENANCE")`
**Crew**: `crew_id, terminal, available_from, available_until, status ("AVAILABLE" | "OFF_DUTY")`
**Baggage**: `bag_id, flight_id, connecting_flight_id (nullable), current_location, status ("IN_TRANSIT" | "LOADED" | "ROUTING_UPDATED" | "AT_RISK" | "REROUTED")`
**Decision** (new): `id, cascade_id, depth int, timestamp (ISO string), type, flight_id, resource_type ("GATE"|"CREW"|"BAGGAGE"|"FLIGHT"|"SYSTEM"), from_value, to_value, reason, severity ("INFO"|"LOW"|"MEDIUM"|"HIGH"|"CRITICAL")`

Decision `type` ∈ `DELAY_APPLIED | GATE_REASSIGNED | CREW_REASSIGNED | BAGGAGE_REROUTED | BAGGAGE_AT_RISK | BAGGAGE_REBOOKED | CASCADE_BUMP | NO_ACTION_NEEDED | BLOCKED | SCENARIO_RESET | CHAOS_TRIGGERED | FLIGHT_CANCELLED`

---

## 4. API contract (all JSON; CORS open; server `http://127.0.0.1:8000`)

Existing endpoints keep working. Shapes below are exact.

```
GET  /health                    → {"status":"healthy"}
GET  /flights/                  → [Flight]
GET  /flights/{id}              → Flight | 404
POST /flights/                  → Flight (409 on gate/crew conflict)      [existing]
POST /flights/{id}/delay        body {"delay_minutes": int}  → ResolutionPlan (committed)
POST /flights/{id}/simulate     body {"delay_minutes": int}  → ResolutionPlan (dry_run=true, nothing persisted)
POST /flights/{id}/cancel       → {"flight_id","status":"CANCELLED","freed":{"gate":..,"crew":..},"bags_affected":n}
GET  /flights/{id}/cascade      → existing shape (root_flight, delay_minutes, status, current_gate, current_crew, affected_flights[], affected_baggage[], total_affected_flights, total_affected_bags)
GET  /gates/  /gates/{id}  POST /gates/          [existing]
GET  /crew/   /crew/{id}   POST /crew/           [existing]
GET  /baggage/  /baggage/{id}  /baggage/flight/{flight_id}  POST /baggage/   [existing]
GET  /dashboard/                → {"flights":[Flight-lite…],"gates":[…],"crew":[…],"baggage":[…],"metrics":Metrics}
GET  /alerts/                   → {"total_alerts":n,"alerts":[Alert]}
GET  /metrics                   → Metrics
GET  /integrity                 → {"ok":bool,"violations":[Violation],"checked_at":iso}
GET  /timeline                  → Timeline
GET  /decisions?limit=50&cascade_id=&flight_id=  → {"total":n,"decisions":[Decision]}  newest first
GET  /scenario/presets          → [Preset]
GET  /scenario/story            → [StoryBeat]   ordered script for the "Play the day" auto-demo
GET  /report                    → DayReport     everything a printable day report needs
POST /scenario/presets/{id}/run → ResolutionPlan (committed)
POST /scenario/reset            → {"message":"Scenario reset","counts":{"flights":n,"gates":n,"crew":n,"baggage":n}}
POST /scenario/chaos            body {"count":3,"max_delay":60} → {"cascades":[ResolutionPlan],"summary":str}
```

```
Flight = {flight_id, airline, origin, destination, aircraft, terminal, gate_id, crew_id,
          scheduled_arrival, scheduled_departure, arrival_time, departure_time,
          delay_minutes, status, priority, passengers}

Decision = {id, cascade_id, depth, timestamp, type, flight_id, resource_type,
            from_value, to_value, reason, severity,
            resolution_ms: float|null}      # wall time of the whole cascade, stamped on every row

ResolutionPlan = {
  cascade_id, dry_run: bool, root_flight, delay_minutes,
  old_window: {arrival, departure}, new_window: {arrival, departure},
  status: "RESOLVED" | "BLOCKED",
  summary: "Delayed F101 by 30 min * gate A1->A4 * crew C1->C3 * 2 bags rerouted * 2 flights would have collided",
  actions: [Decision],                       # ordered, all hops
  conflicts_detected: [{flight_id, resource_type, resource_id, window:{arrival,departure}, overlap_minutes}],
  cascade_preview: [{flight_id, gate, crew, gate_risk, crew_risk, impact}],   # who would have collided if nothing was done
  baggage: [{bag_id, old_location, new_location, status, risk: null | "MISSED_CONNECTION", rebooked_to: null | flight_id}],
  max_depth, flights_touched: [flight_id],
  integrity: {ok, violations: []},
  resolution_ms: float,                      # wall time of this resolution, 1 decimal
  # convenience (root flight only, keeps old frontend working):
  old_gate, new_gate, old_crew, new_crew, gate_reassigned, crew_reassigned,
  new_arrival_time, new_departure_time, reasoning: [str],
  flight_status: "DELAYED" | "ON_TIME",           # root flight status after the plan
  total_flights_at_risk: n,                       # == cascade_preview.length
  baggage_rerouted: [{bag_id, old_location, new_location}],
  preset: str                                     # only on /scenario/presets/{id}/run
}
On BLOCKED nothing is committed, so new_window / new_gate / new_crew mirror the old values and
`actions` still carries the DELAY_APPLIED + BLOCKED trace of what was attempted.

Alert = {id, type, severity, flight_id|null, bag_id|null, message, timestamp}
   type ∈ FLIGHT_DELAY | GATE_REASSIGNED | CREW_REASSIGNED | CASCADE_BUMP | BAGGAGE_AT_RISK | BAGGAGE_REROUTED | BLOCKED | INTEGRITY
   (derived from the latest decisions + current state; delayed flights always produce FLIGHT_DELAY)

Metrics = {total_flights, on_time, delayed, cancelled, on_time_pct, avg_delay_minutes,
           conflicts_resolved, reassignments, cascade_bumps, bags_total, bags_at_risk,
           gate_utilization_pct, crew_utilization_pct, integrity_violations, last_decision_at,
           # hero numbers for the demo
           passengers_protected,       # pax on distinct live flights that were reassigned or bumped
           bags_rebooked,              # BAGGAGE_REBOOKED decisions
           delay_minutes_absorbed,     # sum of delay_minutes over DELAYED flights
           decisions_total, disruptions_today,   # cascades that carry a DELAY_APPLIED
           avg_resolution_ms, last_resolution_ms}

StoryBeat = {at: "HH:MM", preset: preset id, title: str, narration: str}   # fire in list order

DayReport = {
  generated_at, airport: {terminals, gates, crews}, metrics: Metrics,
  disruptions: [{cascade_id, root_flight, airline, route, delay_minutes,
                 status: "Resolved"|"Blocked", summary, resolution_ms|null,
                 actions: [{type, flight_id, from_value, to_value, reason}]}],   # newest first
  flights: [{flight_id, airline, route, scheduled, now, gate_id, crew_id, status,
             delay_minutes, priority, passengers}],
  baggage_exceptions: [{bag_id, flight_id, connecting_flight_id, status}],       # REROUTED | AT_RISK
  guarantee: {ok, violations}
}
A blocked plan commits nothing to the schedule but does keep its `DELAY_APPLIED` (reason prefixed
"Attempted - ") and `BLOCKED` rows, so refusals appear in the feed, the report and the metrics.

Violation = {type: "GATE_OVERLAP"|"CREW_OVERLAP"|"CREW_OUTSIDE_SHIFT", resource_id, flight_ids:[..], detail}

Timeline = {
  window: {start:"06:00", end:"22:00"},
  gates: [{gate_id, terminal, status, buffer_minutes,
           blocks: [{flight_id, start, end, status, delay_minutes, crew_id, priority}]}],
  crews: [{crew_id, terminal, shift:{start,end}, status,
           blocks: [{flight_id, start, end, gate_id, status}]}]
}

Preset = {id, name, description, flight_id, delay_minutes, expected: str}
```

---

## 5. Seed scenario (`backend/seed.py`, also used by `/scenario/reset`)

Baseline must have **zero integrity violations** (respect buffers!). Backend agent: verify every preset below with a script; if a time needs a small tweak to produce the stated outcome, tweak the seed, keep this table updated, and put the verified outcome in `Preset.expected`.

Counts: **25 flights, 7 gates, 8 crews, 45 bags** (returned by `POST /scenario/reset`).

Terminal T1 — gates A1, A2, A3, A4 (all AVAILABLE) · crews C1 06:00–14:00, C2 06:00–20:00, C3 08:00–20:00, C4 12:00–22:00, **C5 14:00–22:00**
Terminal T2 — gates B1, B2 (AVAILABLE), B3 (MAINTENANCE — must stay that way for preset 4) · crews D1 06:00–18:00, D2 10:00–22:00, **D3 14:00–22:00**

| flight | airline | origin→dest | arr–dep | term | gate | crew | prio | pax |
|---|---|---|---|---|---|---|---|---|
| F101 | SkyWays | DEL→BLR | 09:00–09:40 | T1 | A1 | C1 | 3 | 180 |
| F102 | AirNova | HYD→BLR | 10:00–10:40 | T1 | A1 | C2 | 2 | 150 |
| F103 | SkyWays | MAA→BLR | 10:05–10:45 | T1 | A2 | C1 | 2 | 120 |
| F104 | IndiGlow | CCU→BLR | 11:20–12:00 | T1 | A2 | C2 | 4 | 210 |
| F105 | AirNova | BLR→BOM | 12:30–13:10 | T1 | A3 | C3 | 1 | 90 |
| F106 | SkyWays | BLR→GOI | 13:30–14:10 | T1 | A1 | C4 | 2 | 140 |
| F107 | IndiGlow | BLR→BOM | 14:30–15:10 | T1 | A4 | C3 | 3 | 170 |
| F108 | AirNova | PNQ→BLR | 08:00–08:40 | T1 | A3 | C3 | 2 | 110 |
| F201 | GulfStar | DXB→BLR | 09:30–10:10 | T2 | B1 | D1 | 3 | 160 |
| F202 | GulfStar | DOH→BLR | 10:30–11:10 | T2 | B1 | D1 | 2 | 130 |
| F203 | EastWind | SIN→BLR | 10:45–11:25 | T2 | B2 | D2 | 3 | 150 |
| F204 | EastWind | BLR→SIN | 12:30–13:10 | T2 | B2 | D2 | **5** | 80 |
| F205 | GulfStar | BLR→DXB | 12:30–13:10 | T2 | B1 | D1 | 2 | 140 |
| F109 | IndiGlow | BLR→DEL | 06:30–07:10 | T1 | A3 | C1 | 2 | 165 |
| F110 | SkyWays | BLR→HYD | 07:00–07:40 | T1 | A2 | C2 | 2 | 140 |
| F111 | AirNova | BLR→CCU | 15:40–16:20 | T1 | A1 | C3 | 3 | 185 |
| F112 | SkyLine | MAA→BLR | 17:00–17:40 | T1 | A2 | C5 | 2 | 175 |
| F115 | SkyWays | BLR→PNQ | 18:20–19:00 | T1 | A4 | C5 | 2 | 130 |
| F113 | AirNova | BLR→GOI | 19:00–19:40 | T1 | A3 | C4 | 1 | 95 |
| F114 | IndiGlow | BLR→AMD | 20:30–21:10 | T1 | A1 | C5 | 2 | 150 |
| F206 | SkyLine | BLR→AUH | 07:30–08:10 | T2 | B1 | D1 | 2 | 195 |
| F207 | Aeronet | DXB→BLR | 14:00–14:40 | T2 | B2 | D2 | 3 | 225 |
| F208 | GulfStar | BLR→LHR | 16:00–16:40 | T2 | B1 | D3 | 4 | 260 |
| F209 | EastWind | SIN→BLR | 17:30–18:10 | T2 | B1 | D2 | 3 | 210 |
| F210 | SkyLine | BLR→DXB | 20:40–21:20 | T2 | B2 | D3 | 2 | 165 |

Verified changes vs. the original draft (backend agent, all presets re-verified):
- **F204 priority is 5, not 1** — this is what makes preset 4 (`blocked`) deterministic: F203 cannot push a higher-priority flight off B2.
- **F205 added** — it fills B1 in the afternoon so preset 4 has no free T2 gate to fall back to. It does not disturb preset 2 (the bumped F202 ends 11:50 + 15 min buffer = 12:05, clear of F205 at 12:30).
- **F109–F115 / F206–F210 added** (early bank + evening bank) so the timeline is busy across 06:30–21:20. Invariants they must keep, if the seed is edited again: nothing new on the 09:00–13:10 windows of A1–A4/B1–B3 or crews C1–C4/D1–D2; **gate A4 keeps fewer flights than A3** (preset 1 picks the least loaded free gate); new crews start at 14:00 so they cannot win preset 1's or preset 2's crew search; **no new flight may be bound for BOM**, which would steal preset 3's rebooking target from F107.

Baggage (45 bags, 2–3 per flight) at `"{terminal}-CLAIM"`, status `IN_TRANSIT`, ids `B10<flight><n>` / `B20<flight><n>` (e.g. `B1011`, `B1012` on F101). Connecting bags: `B1041, B1042` on **F104** → **F105** (BOM) and `B2011` on **F201** → **F203** (both tight enough to break under preset 3 / comfortable at baseline), plus three comfortable transfers that stay green at baseline: `B1121` on **F112** → **F113** (160 min), `B2071, B2072` on **F207** → **F208** (160 min), `B2091` on **F209** → **F210** (230 min).

**Presets (`/scenario/presets`)** — each one runs from the freshly reset baseline; all five outcomes below are verified live by `backend/verify_scenarios.py`.

1. `double-conflict` — F101 +30 → 09:30–10:10. Gate A1 conflicts with F102, crew C1 conflicts with F103 → **verified**: gate A1→A4 (least loaded free gate), crew C1→C3, bags B1011/B1012 rerouted to `A4-STAGING`, cascade_preview = [F102 gate, F103 crew], status RESOLVED, max_depth 0.
2. `cascade-bump` — F201 +45 → 10:15–10:55; B1 conflicts with F202; B2 blocked by F203 (buffer); B3 maintenance → no free gate → **bump F202** (prio 2 < 3) by 40 min to 11:10–11:50 (depth 1) → F202 crew D1 now conflicts (rest) → no free T2 crew → cross-terminal crew C3 dispatched. **Verified**: status RESOLVED, max_depth 1, flights_touched [F201, F202], F201 keeps B1/D1.
3. `missed-connection` — F104 +90 → arrival 12:50; bags B1041/B1042 connect to F105 (dep 13:10) → 20 min < 30 → `BAGGAGE_AT_RISK` → **verified** rebooked to F107 (BOM, dep 15:10, 140 min connection) → `BAGGAGE_REBOOKED`, bag status `REROUTED`. No gate/crew change.
4. `blocked` — F203 +60 → 11:45–12:25. B2 is held by F204 (12:30–13:10), B1 by F205 (12:30–13:10), B3 is under maintenance → no free T2 gate, and F204's priority 5 ≥ F203's 3 so it cannot be pushed → **verified**: status BLOCKED, `BLOCKED` decision with severity CRITICAL, nothing committed (only the BLOCKED decision row is kept, so the CRITICAL alert survives).
5. `evening-rush` — F208 +40 → 16:40–17:20. Its stand B1 is needed by F209 at 17:30 (inside the buffer) → **verified**: single hop, gate B1→B2, crew D3 unchanged, bags B2081/B2082 to `B2-STAGING`, status RESOLVED, max_depth 0.
**Story mode (`GET /scenario/story`)** — the scripted day for the auto-demo. Verified live end to end from a single reset, running the five presets in this order **without resetting in between**; every documented outcome still holds with state accumulating (after `cascade-bump`, F202 sits on B1 until 11:50, which only makes `blocked` more certain):

| at | preset | title | outcome when run in sequence |
|---|---|---|---|
| 08:45 | `double-conflict` | Gate and crew collide | RESOLVED, A1→A4, C1→C3, 2 bags to A4-STAGING |
| 09:15 | `cascade-bump` | One delay, two flights | RESOLVED, depth 1, F202 → 11:10–11:50 on crew C3 |
| 10:30 | `blocked` | Nothing left to give | BLOCKED, F203 untouched, CRITICAL decision kept |
| 11:05 | `missed-connection` | Bags that would have missed | RESOLVED, B1041/B1042 → F107 |
| 15:45 | `evening-rush` | Evening bank squeeze | RESOLVED, depth 0, B1→B2 |

After the full run: 5 disruptions in `/report`, 245 delay minutes absorbed, 2 bags rebooked, `/integrity` ok.

6. `chaos` — `POST /scenario/chaos {count:3,max_delay:60}` random; not part of `GET /scenario/presets` (it does not return a single ResolutionPlan). Fuzzed over 250+ plans: 0 integrity violations.

---

## 6. Frontend (`frontend/index.html`) — theme & views

**Brand:** AeroMind. Tagline in the top bar: "Autonomous Airport Operations Control".

**Theme — dark mission-control.** CSS variables:
```
--bg:#0b1220  --bg-2:#0f172a  --panel:#111a2e  --panel-2:#16213a  --border:#1f2b47
--text:#e6edf7 --muted:#8b9bb8  --accent:#22d3ee (cyan)  --accent-2:#818cf8
--ok:#22c55e  --warn:#f59e0b  --danger:#ef4444  --info:#38bdf8
font: system-ui for UI; ui-monospace/Consolas for IDs, times, numbers
```
No emoji in UI chrome — use inline SVG icons. Subtle borders, 12px radius, soft glow on accent elements, smooth 200ms transitions. Must work at 1366×768 and be usable at phone width.

**Layout:** left sidebar (nav, wired), top bar (brand, live clock, "SYSTEM ONLINE" pulse, integrity badge `✓ 0 violations` green / red if any), content area with sections toggled by nav (single page, no routing lib; `#hash` optional).

**Views**
1. **Overview** — KPI tiles from `/metrics` (flights, on-time %, delayed, conflicts resolved, cascade bumps, bags at risk, integrity). **Gate Timeline** (Gantt built with divs/CSS grid: rows = gates grouped by terminal, x-axis 06:00–22:00 hourly ticks, blocks colored by status, buffer shown as hatched tail, delayed blocks pulse once when they change, hover tooltip with flight details, "now" line optional). **Live Decision Feed** (from `/decisions`, newest first, each row: type chip, flight, from→to, reason, hop-depth indicator "↳ hop 1", timestamp; new rows slide in). **Alerts** list with severity color.
2. **Simulate** — flight select (from `/flights/`), minutes input, buttons **Preview impact** (`/simulate`) and **Apply** (`/delay`). Preview renders the ResolutionPlan as a diff card: new window, conflicts detected (red), proposed actions grouped by hop, baggage impact, status RESOLVED/BLOCKED, "would have collided with" list. Apply commits and shows the same card with a green "Applied" stamp + toast; then refresh everything. **Preset scenario buttons** (from `/scenario/presets`, run via `/scenario/presets/{id}/run`), **Chaos mode** and **Reset scenario** buttons (confirm dialog for reset).
3. **Flights** — table: flight, airline, route, sched vs current times, gate, crew, priority, pax, status chip, delay; search box; row click opens a side drawer with `/flights/{id}/cascade` + that flight's decisions; drawer has "Delay +15/+30/+60" quick buttons and "Cancel flight".
4. **Gates** — cards per gate: status, terminal, utilization bar, next/current flight, mini-timeline.
5. **Crew** — cards: shift bar (06–22), assignments list, terminal, slack.
6. **Baggage** — table: bag, flight, connecting flight, location, status chip; at-risk highlighted with reason.
7. **Decision Log** — full table with filters (type, flight, cascade id); clicking a cascade id filters to that cascade.

**Behavior:** poll `/dashboard/`, `/alerts/`, `/decisions?limit=30`, `/timeline`, `/integrity` every 5 s; instant refresh after any action; toast for each new decision since last poll; graceful empty/error states ("backend offline" banner if fetch fails); `const API = "http://127.0.0.1:8000"`.

---

## 7. Deliverables checklist

- [ ] `backend/rules.py`, `backend/resolver.py` (engine), `backend/integrity.py`, `backend/models.py` (+Decision), `backend/schemas.py`, routers: `flights.py` (delay/simulate/cancel/cascade), `decisions.py`, `metrics.py` (+`/integrity`), `timeline.py`, `scenario.py`; `dashboard.py` returns metrics; `alerts.py` derived from decisions; `seed.py` per §5; `requirements.txt`
- [ ] `frontend/index.html` per §6
- [ ] `README.md`: pitch, architecture diagram (mermaid), how to run, demo script (presets in order), API summary
- [ ] Everything verified live: presets 1–3 produce the expected outcomes; `/integrity` ok after each; UI screenshots
