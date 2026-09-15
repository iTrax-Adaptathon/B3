const API = "http://127.0.0.1:8000";
const DAY_START = 360, DAY_END = 1320, SPAN = DAY_END - DAY_START, BUFFER = 15;

const state = {
  view: "home", online: true, booted: false,
  metrics: null, integrity: null, timeline: null, alerts: null,
  flights: [], gates: [], crews: [], bags: [], decisions: [],
  presets: null, presetsLive: false,
  plan: null, planMode: null, planBusy: false,
  seenDecisions: new Set(), reassigned: new Set(),
  blockSig: new Map(), ganttScrolled: false, drawer: null, drawerData: null,
  f: { search: "", status: "ALL", bagSearch: "", bagFilter: "ALL", dType: "", dFlight: "" },
  sig: {}
};

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = v => String(v == null ? "" : v)
  .replace(/\s\*\s/g, " \u00b7 ")
  .replace(/\s*->\s*/g, " \u2192 ")
  .replace(/\bat depth (\d+)\b/gi, (m, n) => "with " + n + " knock-on change" + (n === "1" ? "" : "s"))
  .replace(/\bin one hop\b/gi, "with one knock-on change")
  .replace(/\bin (\d+) hops?\b/gi, (m, n) => "with " + n + " knock-on change" + (n === "1" ? "" : "s"))
  .replace(/\bnothing is committed\b/gi, "nothing is changed")
  .replace(/\bnot committed\b/gi, "not changed")
  .replace(/\brebooked\b/gi, "re-booked")
  .replace(/\bdry[- ]run\b/gi, "preview")
  .replace(/\bcascade\b/gi, "knock-on")
  .replace(/\bintegrity\b/gi, "guarantee");
const txt = v => esc(pretty(v));
const dash = v => (v === null || v === undefined || v === "") ? '<span class="muted">&mdash;</span>' : esc(v);
const t2m = t => { if (typeof t !== "string") return null; const p = t.split(":"); const h = +p[0], m = +p[1]; return (isFinite(h) && isFinite(m)) ? h * 60 + m : null; };
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
const num = v => (v === null || v === undefined || (typeof v === "number" && !isFinite(v))) ? "\u2014" : v;
const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));
const mono = v => `<span class="mono">${esc(v)}</span>`;

const STATUS_WORD = {
  ON_TIME: "On time", DELAYED: "Delayed", CANCELLED: "Cancelled",
  AVAILABLE: "Available", OCCUPIED: "Busy", MAINTENANCE: "Maintenance", OFF_DUTY: "Off duty",
  IN_TRANSIT: "In transit", LOADED: "Loaded", ROUTING_UPDATED: "Re-routed",
  AT_RISK: "At risk", REROUTED: "Re-booked"
};
const STATUS_CLASS = {
  ON_TIME: "c-ok", DELAYED: "c-warn", CANCELLED: "c-mute",
  AVAILABLE: "c-ok", OCCUPIED: "c-info", MAINTENANCE: "c-warn", OFF_DUTY: "c-mute",
  IN_TRANSIT: "c-info", LOADED: "c-ok", ROUTING_UPDATED: "c-alt", AT_RISK: "c-danger", REROUTED: "c-ok"
};
const KIND = {
  DELAY_APPLIED: ["Delay", "c-warn"], GATE_REASSIGNED: ["Gate", "c-accent"], CREW_REASSIGNED: ["Crew", "c-alt"],
  BAGGAGE_REROUTED: ["Baggage", "c-info"], BAGGAGE_AT_RISK: ["Baggage", "c-danger"], BAGGAGE_REBOOKED: ["Baggage", "c-ok"],
  CASCADE_BUMP: ["Knock-on", "c-warn"], NO_ACTION_NEEDED: ["No change", "c-mute"], BLOCKED: ["Blocked", "c-danger"],
  SCENARIO_RESET: ["Reset", "c-mute"], CHAOS_TRIGGERED: ["Disruption", "c-warn"], FLIGHT_CANCELLED: ["Cancelled", "c-danger"],
  FLIGHT_DELAY: ["Delay", "c-warn"], BAGGAGE_UPDATE: ["Baggage", "c-info"], INTEGRITY: ["Check", "c-ok"]
};
const PRESET_TITLE = {
  "double-conflict": "One delay, two problems",
  "cascade-bump": "A knock-on delay",
  "missed-connection": "Bags that would miss their flight",
  "blocked": "When nothing can be moved",
  "evening-rush": "The evening rush"
};
const PRESET_STORY = {
  "double-conflict": "A morning arrival slips by half an hour. The gate it was heading for is already promised to another aircraft, and its crew is due on a different flight.",
  "cascade-bump": "An international arrival is 45 minutes late and no gate in its terminal is free. Something else has to move first.",
  "missed-connection": "A long delay means two transfer bags can no longer make their onward flight.",
  "blocked": "Everything is taken and the only other flight outranks this one. The honest answer is no.",
  "evening-rush": "Several evening departures stack up at once and the airport has to absorb all of them."
};

function chip(text, cls) { return `<span class="chip ${cls || "c-mute"}">${esc(text)}</span>`; }
function statusChip(s) { return chip(STATUS_WORD[s] || String(s || "").replace(/_/g, " "), STATUS_CLASS[s] || "c-mute"); }
function kindChip(t) { const k = KIND[t] || [String(t || "").replace(/_/g, " "), "c-mute"]; return chip(k[0], k[1]); }

function busy(n) { try { window.dispatchEvent(new CustomEvent("am:fetch", { detail: n })); } catch (e) { } }
async function fetchJSON(path, opts) {
  busy(1);
  try {
    const r = await fetch(API + path, Object.assign({ cache: "no-store" }, opts || {}));
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { busy(-1); }
}
async function send(path, body) {
  busy(1);
  try {
    const r = await fetch(API + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: null }; } finally { busy(-1); }
}
function paint(key, node, html) {
  if (!node) return false;
  if (state.sig[key] === html) return false;
  state.sig[key] = html; node.innerHTML = html; return true;
}
function empty(title, sub) {
  return `<div class="empty"><svg><use href="#i-inbox"/></svg><b>${esc(title)}</b><span>${esc(sub || "")}</span></div>`;
}
function rel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(11, 16) || String(iso);
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return d.toISOString().slice(5, 16).replace("T", " ");
}

function normFlight(f) {
  return {
    flight_id: f.flight_id, airline: f.airline ?? null, origin: f.origin ?? null,
    destination: f.destination ?? null, aircraft: f.aircraft ?? null, terminal: f.terminal ?? null,
    gate_id: f.gate_id ?? f.gate ?? null, crew_id: f.crew_id ?? f.crew ?? null,
    scheduled_arrival: f.scheduled_arrival ?? null, scheduled_departure: f.scheduled_departure ?? null,
    arrival_time: f.arrival_time ?? null, departure_time: f.departure_time ?? null,
    delay_minutes: f.delay_minutes ?? 0, status: f.status ?? "ON_TIME",
    priority: f.priority ?? null, passengers: f.passengers ?? null
  };
}
function normBag(b) {
  return {
    bag_id: b.bag_id, flight_id: b.flight_id ?? null,
    connecting_flight_id: b.connecting_flight_id ?? null,
    current_location: b.current_location ?? b.location ?? null,
    status: b.status ?? null
  };
}

/* ---------------- data ---------------- */

async function refresh() {
  const [health, dash, flightsRaw, metrics, integrity, timeline, alerts, decisions, bagFull] = await Promise.all([
    fetchJSON("/health"), fetchJSON("/dashboard/"), fetchJSON("/flights/"),
    fetchJSON("/metrics"), fetchJSON("/integrity"), fetchJSON("/timeline"),
    fetchJSON("/alerts/"), fetchJSON("/decisions?limit=200"), fetchJSON("/baggage/")
  ]);

  state.online = !!health;
  $("#offline").classList.toggle("on", !state.online);
  $("#live-dot").classList.toggle("off", !state.online);

  const src = Array.isArray(flightsRaw) && flightsRaw.length ? flightsRaw : (dash && dash.flights) || [];
  const lite = new Map(((dash && dash.flights) || []).map(f => [f.flight_id, f]));
  if (src.length) state.flights = src.map(f => normFlight(Object.assign({}, lite.get(f.flight_id) || {}, f)));
  if (dash && dash.gates) state.gates = dash.gates;
  if (dash && dash.crew) state.crews = dash.crew;
  const bagSrc = (dash && dash.baggage) || [];
  const byId = new Map((Array.isArray(bagFull) ? bagFull : []).map(b => [b.bag_id, b]));
  const bags = (bagSrc.length ? bagSrc : (Array.isArray(bagFull) ? bagFull : []));
  if (bags.length) state.bags = bags.map(b => normBag(Object.assign({}, b, byId.get(b.bag_id) || {})));

  if (metrics || (dash && dash.metrics)) state.metrics = metrics || dash.metrics;
  if (integrity) state.integrity = integrity;
  if (timeline) state.timeline = timeline;
  if (alerts) state.alerts = alerts;

  const list = decisions && Array.isArray(decisions.decisions) ? decisions.decisions : null;
  if (list) { state.decisions = list; diffDecisions(list); }

  computeReassigned();
  $("#last-sync").textContent = state.online ? "Updated " + new Date().toTimeString().slice(0, 5) : "Not connected";
  renderAll();
}

function diffDecisions(list) {
  const fresh = [];
  for (const d of list) {
    const key = String(d.id ?? (d.cascade_id + "|" + d.type + "|" + d.flight_id + "|" + d.timestamp));
    if (!state.seenDecisions.has(key)) { state.seenDecisions.add(key); fresh.push(d); }
  }
  if (!state.booted) { state.booted = true; return; }
  const quiet = Date.now() < (state.mutedUntil || 0);
  fresh.slice(0, 3).reverse().forEach(d => {
    d.__new = true;
    if (!quiet) toast((KIND[d.type] || ["Update"])[0], say(d), d.severity);
    setTimeout(() => { delete d.__new; }, 1400);
  });
}

function computeReassigned() {
  const d = state.decisions;
  if (!d.length) { state.reassigned = new Set(); return; }
  const cid = d[0].cascade_id;
  const s = new Set();
  if (cid) {
    d.filter(x => x.cascade_id === cid).forEach(x => {
      if (["GATE_REASSIGNED", "CREW_REASSIGNED", "CASCADE_BUMP", "DELAY_APPLIED"].includes(x.type) && x.flight_id) s.add(x.flight_id);
    });
  }
  state.reassigned = s;
}

function derivedMetrics() {
  const m = state.metrics, f = state.flights;
  const delayed = f.filter(x => x.status === "DELAYED").length;
  const cancelled = f.filter(x => x.status === "CANCELLED").length;
  const onTime = f.filter(x => x.status === "ON_TIME").length;
  const delays = f.map(x => x.delay_minutes || 0).filter(x => x > 0);
  const dec = state.decisions;
  const cnt = t => dec.length ? dec.filter(x => x.type === t).length : null;
  const reass = dec.length ? dec.filter(x => x.type === "GATE_REASSIGNED" || x.type === "CREW_REASSIGNED").length : null;
  const base = {
    total_flights: f.length, on_time: onTime, delayed, cancelled,
    on_time_pct: f.length ? Math.round(onTime / f.length * 100) : 0,
    avg_delay_minutes: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : 0,
    conflicts_resolved: reass, reassignments: reass, cascade_bumps: cnt("CASCADE_BUMP"),
    bags_total: state.bags.length,
    bags_at_risk: state.bags.filter(b => b.status === "AT_RISK").length,
    integrity_violations: state.integrity ? (state.integrity.violations || []).length : null
  };
  return Object.assign(base, m || {});
}

/* ---------------- plain language ---------------- */

function say(d) {
  const f = d.flight_id || "This flight";
  const from = d.from_value, to = d.to_value;
  switch (d.type) {
    case "DELAY_APPLIED":
      return to ? `${f} is now running ${to} instead of ${from || "its planned time"}.` : `${f} has been delayed.`;
    case "GATE_REASSIGNED":
      return `Moved ${f} from gate ${from} to gate ${to}.`;
    case "CREW_REASSIGNED":
      return `Gave ${f} crew ${to} instead of crew ${from}.`;
    case "BAGGAGE_REROUTED":
      return `Sent ${f} baggage to ${to}.`;
    case "BAGGAGE_AT_RISK":
      return `${f} baggage is at risk of missing its connection.`;
    case "BAGGAGE_REBOOKED":
      return `Re-booked ${f} baggage onto ${to}.`;
    case "CASCADE_BUMP":
      return `Knock-on change: moved ${f} later, to ${to}, to free up space.`;
    case "NO_ACTION_NEEDED":
      return `Nothing had to change for ${f}.`;
    case "BLOCKED":
      return `Could not make room for ${f}. Nothing was changed.`;
    case "SCENARIO_RESET":
      return "Demo reset to the clean starting schedule.";
    case "CHAOS_TRIGGERED":
      return "Several random delays were thrown at the airport at once.";
    case "FLIGHT_CANCELLED":
      return `${f} was cancelled. Its gate and crew are free again.`;
    default:
      return pretty(d.reason || `${f} was updated.`);
  }
}

function planStory(p) {
  const root = p.root_flight || p.flight_id || "This flight";
  const mins = p.delay_minutes;
  const actions = Array.isArray(p.actions) ? p.actions : [];
  if (p.status === "BLOCKED") {
    return `${root} cannot be delayed by ${mins} minutes right now \u2014 there is no free gate and nothing else can be moved out of the way. Nothing was changed.`;
  }
  const parts = [`${root} is ${mins} minutes late.`];
  const gate = p.gate_reassigned || (p.new_gate && p.new_gate !== p.old_gate);
  const crew = p.crew_reassigned || (p.new_crew && p.new_crew !== p.old_crew);
  if (gate && crew) parts.push(`AeroMind moved it to gate ${p.new_gate} and gave it crew ${p.new_crew}.`);
  else if (gate) parts.push(`AeroMind moved it to gate ${p.new_gate}.`);
  else if (crew) parts.push(`AeroMind gave it crew ${p.new_crew}.`);
  else parts.push("Its gate and crew still work, so neither had to change.");

  const rebooked = actions.filter(a => a.type === "BAGGAGE_REBOOKED");
  const rerouted = (Array.isArray(p.baggage) ? p.baggage : []).length;
  if (rebooked.length) parts.push(`${plural(rebooked.length, "bag")} re-booked onto a later flight.`);
  else if (rerouted) parts.push(`${plural(rerouted, "bag")} sent to the new belt.`);

  const others = (p.flights_touched || []).filter(x => x !== root);
  if (others.length) parts.push(`${others.join(" and ")} had to move as well.`);
  else parts.push("No other flight is affected.");
  return parts.join(" ");
}

function planChanges(p) {
  const root = p.root_flight || p.flight_id;
  const rows = [];
  const nw = p.new_window || {}, ow = p.old_window || {};
  const blocked = p.status === "BLOCKED";
  const moved = (was, now) => `<span class="was">${esc(was || "")}</span><span class="ar">\u2192</span>${mono(now)}`;
  if (!blocked && (nw.arrival || nw.departure)) {
    rows.push(["New time", ow.arrival
      ? moved(ow.arrival + "\u2013" + (ow.departure || ""), (nw.arrival || "") + "\u2013" + (nw.departure || ""))
      : mono((nw.arrival || "") + "\u2013" + (nw.departure || ""))]);
  }
  const gate = p.gate_reassigned || (p.new_gate && p.new_gate !== p.old_gate);
  rows.push(["Gate", blocked ? '<span class="muted">unchanged</span>'
    : gate ? moved(p.old_gate, p.new_gate)
      : `${mono(p.new_gate || p.old_gate || "\u2014")} <span class="muted">stays the same</span>`]);
  const crew = p.crew_reassigned || (p.new_crew && p.new_crew !== p.old_crew);
  rows.push(["Crew", blocked ? '<span class="muted">unchanged</span>'
    : crew ? moved(p.old_crew, p.new_crew)
      : `${mono(p.new_crew || p.old_crew || "\u2014")} <span class="muted">stays the same</span>`]);
  const bags = Array.isArray(p.baggage) ? p.baggage : [];
  const reb = bags.filter(b => b.rebooked_to);
  rows.push(["Baggage", bags.length
    ? (reb.length ? `${plural(reb.length, "bag")} re-booked onto ${mono(reb[0].rebooked_to)}` : `${plural(bags.length, "bag")} re-routed`)
    : '<span class="muted">nothing to move</span>']);
  const others = (p.flights_touched || []).filter(x => x !== root);
  rows.push(["Other flights moved", others.length
    ? others.map(mono).join(", ")
    : '<span class="muted">none</span>']);
  const coll = Array.isArray(p.cascade_preview) ? p.cascade_preview : [];
  if (coll.length) {
    rows.push(["Trouble avoided", `${coll.map(c => mono(c.flight_id)).join(", ")} would have clashed if nothing was done`]);
  }
  return rows;
}

/* ---------------- render ---------------- */

function renderAll() {
  renderIntegrity();
  renderNavCounts();
  if (state.view === "home") {
    renderHeadline(); renderKPIs(); renderOps(); renderGantt();
    renderFeed(); renderAlerts(); renderResources(); renderImpact();
  }
  if (state.view === "delay") { renderFlightSelect(); renderPresets(); renderResult(); }
  if (state.view === "flights") renderFlights();
  if (state.view === "gates") renderGates();
  if (state.view === "crew") renderCrew();
  if (state.view === "baggage") renderBaggage();
  if (state.view === "history") renderHistory();
  if (state.drawer) refreshDrawer(false);
  if (window.Cine) Cine.onData();
}

function renderIntegrity() {
  const b = $("#integrity-badge"), t = $("#integrity-text");
  b.classList.remove("ok", "bad");
  if (!state.integrity) { t.textContent = "Checking\u2026"; return; }
  const v = (state.integrity.violations || []).length;
  const ok = state.integrity.ok !== false && v === 0;
  b.classList.add(ok ? "ok" : "bad");
  t.textContent = ok ? "Guarantee holds" : plural(v, "conflict") + " found";
}

function renderNavCounts() {
  $("#nb-flights").textContent = state.flights.length || "-";
  $("#nb-gates").textContent = state.gates.length || "-";
  $("#nb-crew").textContent = state.crews.length || "-";
  $("#nb-bags").textContent = state.bags.length || "-";
  $("#nb-dec").textContent = state.decisions.length || "-";
}

function renderHeadline() {
  const m = derivedMetrics();
  const iv = m.integrity_violations;
  const guaranteed = iv === 0 || (state.integrity && state.integrity.ok === true);
  const fixed = m.conflicts_resolved;
  let line;
  if (!state.flights.length) line = "Waiting for today's schedule\u2026";
  else if (!m.delayed && !m.cancelled) line = `All clear \u2014 <b>${m.total_flights} flights</b> today, no conflicts.`;
  else if (fixed) line = `<b>${plural(m.delayed, "flight")} delayed</b> today \u2014 every conflict resolved automatically.`;
  else line = `<b>${plural(m.delayed, "flight")} delayed</b> today \u2014 no gate or crew clash so far.`;

  paint("headline", $("#headline"), `
    <div class="hl-main">
      <div class="hl-eyebrow">Today at ${esc(new Date().toTimeString().slice(0, 5))}</div>
      <div class="hl-text">${line}</div>
      <div class="hl-guarantee ${guaranteed ? "" : "bad"}">
        <svg><use href="#i-shield"/></svg>
        ${guaranteed ? "No two flights share a gate or crew" : plural(iv || 0, "conflict") + " need attention"}
      </div>
      ${window.Cine ? Cine.heroHTML() : ""}
    </div>`);
}

function renderKPIs() {
  const m = derivedMetrics();
  const tiles = [
    { l: "Flights today", v: m.total_flights, n: m.total_flights, s: `${m.on_time} running to plan`, plain: true },
    { l: "On time", v: m.on_time_pct + "%", n: m.on_time_pct, sx: "%", s: m.avg_delay_minutes ? `average delay ${m.avg_delay_minutes} min` : "no delays recorded" },
    { l: "Delays handled", v: num(m.delayed), n: m.delayed, s: m.cancelled ? `${plural(m.cancelled, "cancellation")} today` : "none cancelled" },
    { l: "Conflicts resolved automatically", v: num(m.conflicts_resolved), n: m.conflicts_resolved, s: m.cascade_bumps ? `${plural(m.cascade_bumps, "knock-on change")}` : "no knock-on changes needed" }
  ];
  paint("kpis", $("#kpis"), tiles.map(t => `
    <div class="kpi ${t.plain ? "plain" : ""}">
      <div class="kpi-l">${esc(t.l)}</div>
      <div class="kpi-v"><span class="cu" data-k="${esc(t.l)}" data-to="${esc(t.n)}" data-pre="" data-suf="${esc(t.sx || "")}" data-raw="${esc(t.v)}">${esc(t.v)}</span></div>
      <div class="kpi-s">${esc(t.s)}</div>
    </div>`).join(""));
}

function renderOps() {
  const all = state.flights;
  $("#ops-note").textContent = all.length ? plural(all.length, "flight") + " today" : "";
  if (!all.length) { paint("ops", $("#ops-tw"), empty("No flights yet", "Waiting for today's schedule.")); return; }
  const LIMIT = 10;
  const f = all.slice().sort((a, b) => {
    const rank = x => x.status === "CANCELLED" ? 0 : (x.delay_minutes > 0 ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 1) return (b.delay_minutes || 0) - (a.delay_minutes || 0);
    return (t2m(a.arrival_time) || 0) - (t2m(b.arrival_time) || 0);
  }).slice(0, LIMIT);
  const hidden = all.length - f.length;
  const html = `<div class="tw"><table><thead><tr>
      <th>Flight</th><th>Route</th><th>Scheduled</th><th>Now</th><th>Gate</th><th>Crew</th><th>Status</th><th class="num">Delay</th>
    </tr></thead><tbody>${f.map(x => {
    const sch = (x.scheduled_arrival && x.scheduled_departure) ? `${x.scheduled_arrival}\u2013${x.scheduled_departure}` : null;
    const cur = (x.arrival_time && x.departure_time) ? `${x.arrival_time}\u2013${x.departure_time}` : null;
    const late = x.delay_minutes > 0;
    return `<tr class="clickable ${late ? "late" : ""}" data-fid="${esc(x.flight_id)}" tabindex="0">
      <td class="mono" style="font-weight:600">${esc(x.flight_id)}</td>
      <td class="mono">${x.origin && x.destination ? esc(x.origin) + " \u2192 " + esc(x.destination) : '<span class="muted">&mdash;</span>'}</td>
      <td class="mono muted">${sch || "&mdash;"}</td>
      <td class="mono" style="${late ? "color:var(--gold-2)" : ""}">${cur || "&mdash;"}</td>
      <td class="mono">${dash(x.gate_id)}</td>
      <td class="mono">${dash(x.crew_id)}</td>
      <td>${statusChip(x.status)}</td>
      <td class="num" style="${late ? "color:var(--gold-2)" : "color:var(--muted)"}">${late ? x.delay_minutes + " min" : "\u2014"}</td>
    </tr>`;
  }).join("")}</tbody></table></div>
    ${hidden > 0 ? `<div class="tbl-more">Showing the ${LIMIT} that need attention first.
      <button class="link" data-goto="flights">See all ${all.length} flights</button></div>` : ""}`;
  paint("ops", $("#ops-tw"), html);
}

function buildTimeline() {
  if (state.timeline && Array.isArray(state.timeline.gates) && state.timeline.gates.length) return state.timeline.gates;
  const byGate = new Map();
  (state.gates || []).forEach(g => byGate.set(g.gate_id, { gate_id: g.gate_id, terminal: g.terminal, status: g.status, buffer_minutes: BUFFER, blocks: [] }));
  state.flights.forEach(f => {
    if (!f.gate_id) return;
    if (!byGate.has(f.gate_id)) byGate.set(f.gate_id, { gate_id: f.gate_id, terminal: f.terminal, status: "AVAILABLE", buffer_minutes: BUFFER, blocks: [] });
    byGate.get(f.gate_id).blocks.push({
      flight_id: f.flight_id, start: f.arrival_time, end: f.departure_time,
      status: f.status, delay_minutes: f.delay_minutes, crew_id: f.crew_id, priority: f.priority
    });
  });
  return Array.from(byGate.values());
}

function renderGantt() {
  const rows = buildTimeline();
  const wrap = $("#gantt-wrap");
  if (!rows.length) { paint("gantt", wrap, empty("Nothing to show yet", "Gate information will appear here.")); return; }

  const terms = new Map();
  rows.forEach(r => {
    const t = r.terminal || "\u2014";
    if (!terms.has(t)) terms.set(t, []);
    terms.get(t).push(r);
  });

  let ticks = "";
  for (let h = 6; h < 22; h++) ticks += `<div class="gt-tick">${String(h).padStart(2, "0")}:00</div>`;
  const nowM = window.Cine ? Cine.vt() : (new Date().getHours() * 60 + new Date().getMinutes());
  const nowPos = nowM >= DAY_START && nowM <= DAY_END ? ((nowM - DAY_START) / SPAN * 100) : null;
  const nowEl = nowPos == null ? "" : `<div class="nowline" style="left:${nowPos.toFixed(2)}%"></div>`;

  let html = `<div class="gantt"><div class="gt-row gt-head"><div class="gt-lab"><span class="muted" style="font-size:10.5px;letter-spacing:1.2px">GATE</span></div><div class="gt-track">${ticks}</div></div>`;

  Array.from(terms.keys()).sort().forEach(term => {
    const gs = terms.get(term).sort((a, b) => String(a.gate_id).localeCompare(String(b.gate_id)));
    html += `<div class="gt-term">Terminal ${esc(term)}</div>`;
    gs.forEach(g => {
      const sdot = g.status === "MAINTENANCE" ? "maint" : (g.status === "OCCUPIED" ? "occ" : "");
      let blocks = "";
      (g.blocks || []).slice().sort((a, b) => (t2m(a.start) || 0) - (t2m(b.start) || 0)).forEach(b => {
        const s = t2m(b.start), e = t2m(b.end);
        if (s == null || e == null) return;
        const cs = Math.max(DAY_START, s), ce = Math.min(DAY_END, Math.max(e, s + 5));
        if (ce <= DAY_START || cs >= DAY_END) return;
        const left = (cs - DAY_START) / SPAN * 100, w = (ce - cs) / SPAN * 100;
        const cls = b.status === "CANCELLED" ? "s-can" : (b.status === "DELAYED" ? "s-del" : "s-on");
        const buf = Math.min(g.buffer_minutes || BUFFER, DAY_END - ce);
        const bw = buf > 0 ? buf / SPAN * 100 : 0;
        const key = b.flight_id + "@" + g.gate_id;
        const sig = b.start + "-" + b.end + "-" + b.status;
        const changed = state.blockSig.has(key) && state.blockSig.get(key) !== sig;
        state.blockSig.set(key, sig);
        const ra = state.reassigned.has(b.flight_id) ? " reass" : "";
        const label = w >= 6 ? `${b.start}\u2013${b.end}` : b.start;
        if (bw > 0) blocks += `<div class="buf" style="left:${(left + w).toFixed(2)}%;width:${bw.toFixed(2)}%"></div>`;
        blocks += `<div class="blk ${cls}${ra}${changed ? " flash" : ""}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%"
          data-f="${esc(b.flight_id)}" data-s="${esc(b.start)}" data-e="${esc(b.end)}" data-st="${esc(STATUS_WORD[b.status] || b.status || "")}"
          data-d="${esc(b.delay_minutes ?? 0)}" data-c="${esc(b.crew_id ?? "")}" data-g="${esc(g.gate_id)}"
          tabindex="0"><span class="bf">${esc(b.flight_id)}</span><span class="bt">${label}</span></div>`;
      });
      const maint = g.status === "MAINTENANCE" && !blocks ? `<div class="gt-maint">Closed for maintenance</div>` : "";
      html += `<div class="gt-row"><div class="gt-lab"><span class="gt-sdot ${sdot}"></span><span class="id">${esc(g.gate_id)}</span></div><div class="gt-track">${maint}${nowEl}${blocks}</div></div>`;
    });
  });
  html += "</div>";
  const keep = wrap.scrollLeft;
  if (paint("gantt", wrap, html)) {
    if (state.ganttScrolled) wrap.scrollLeft = keep;
    else {
      const first = rows.reduce((mn, g) => (g.blocks || []).reduce((m, b) => {
        const s = t2m(b.start); return s != null && s < m ? s : m;
      }, mn), DAY_END);
      if (first < DAY_END) wrap.scrollLeft = Math.max(0, (first - DAY_START - 45) / SPAN * (wrap.scrollWidth - 112));
      state.ganttScrolled = true;
    }
  }
  $("#timeline-note").textContent = "06:00 to 22:00";
}

function renderFeed() {
  const node = $("#feed");
  if (!state.decisions.length) {
    paint("feed", node, empty("Nothing to report", "When a flight is delayed, every change AeroMind makes will appear here."));
    $("#feed-note").textContent = "";
    return;
  }
  $("#feed-note").textContent = plural(state.decisions.length, "change");
  const shown = state.decisions.slice(0, 5);
  const hidden = state.decisions.length - shown.length;
  const html = shown.map(d => `
    <div class="fr${d.__new ? " new" : ""}">
      <div class="sev-bar sev-${esc(d.severity || "INFO")}"></div>
      <div class="fr-m">
        <div class="fr-top">${kindChip(d.type)}${(d.depth > 0 && d.type !== "CASCADE_BUMP") ? `<span class="knock">Knock-on change</span>` : ""}</div>
        <div class="fr-say">${esc(say(d))}</div>
        ${d.reason ? `<div class="fr-why">${txt(d.reason)}</div>` : ""}
      </div>
      <div class="fr-t">${esc(rel(d.timestamp))}</div>
    </div>`).join("")
    + (hidden > 0 ? `<div class="tbl-more">${plural(hidden, "earlier change")} not shown.
        <button class="link" data-goto="history">See the full history</button></div>` : "");
  paint("feed", node, html);
}

function renderAlerts() {
  const a = state.alerts, node = $("#alerts");
  const list = a && Array.isArray(a.alerts) ? a.alerts : [];
  $("#alerts-note").textContent = list.length ? plural(list.length, "alert") : "";
  if (!list.length) { paint("alerts", node, empty("All quiet", "Nothing needs your attention.")); return; }
  const more = list.length - Math.min(list.length, 5);
  paint("alerts", node, list.slice(0, 5).map(al => `
    <div class="al">
      <div class="sev-bar sev-${esc(al.severity || "INFO")}"></div>
      <div class="fr-m">
        <div class="fr-top">${kindChip(al.type)}${al.flight_id ? `<span class="mono" style="font-size:12px;font-weight:600">${esc(al.flight_id)}</span>` : ""}</div>
        <div class="al-msg">${txt(al.message || "")}</div>
        ${al.timestamp ? `<div class="al-meta">${esc(rel(al.timestamp))}</div>` : ""}
      </div>
    </div>`).join("") + (more > 0 ? `<div class="tbl-more">${plural(more, "other alert")} not shown.</div>` : ""));
}

function renderResources() {
  const gAvail = state.gates.filter(g => g.status === "AVAILABLE").length;
  const cAvail = state.crews.filter(c => c.status === "AVAILABLE").length;
  const inTransit = state.bags.filter(b => b.status === "IN_TRANSIT").length;
  const risk = state.bags.filter(b => b.status === "AT_RISK").length;
  const maint = state.gates.filter(g => g.status === "MAINTENANCE").length;
  paint("res", $("#resources"), `
    <div class="res"><div class="v">${gAvail} <span class="muted" style="font-size:17px">/ ${state.gates.length}</span></div>
      <div class="l">Gates available</div><div class="s">${maint ? plural(maint, "gate") + " closed for maintenance" : "all gates in service"}</div></div>
    <div class="res"><div class="v">${cAvail} <span class="muted" style="font-size:17px">/ ${state.crews.length}</span></div>
      <div class="l">Crews on duty</div><div class="s">ready to be assigned</div></div>
    <div class="res"><div class="v">${inTransit} <span class="muted" style="font-size:17px">/ ${state.bags.length}</span></div>
      <div class="l">Bags in transit</div><div class="s">${risk ? plural(risk, "bag") + " at risk" : "none at risk"}</div></div>`);
}

function renderImpact() {
  const node = $("#impact");
  const d = state.decisions;
  if (!d.length) { paint("impact", node, empty("No changes yet", "The effect of the latest change will be summarised here.")); return; }
  const cid = d[0].cascade_id;
  const grp = d.filter(x => x.cascade_id === cid);
  const root = (grp.find(x => x.type === "DELAY_APPLIED") || grp[grp.length - 1] || {}).flight_id;
  const delay = grp.find(x => x.type === "DELAY_APPLIED");
  const gate = grp.find(x => x.type === "GATE_REASSIGNED");
  const crew = grp.find(x => x.type === "CREW_REASSIGNED");
  const bumps = grp.filter(x => x.type === "CASCADE_BUMP");
  const bags = grp.filter(x => String(x.type).startsWith("BAGGAGE"));
  const blocked = grp.find(x => x.type === "BLOCKED");
  const flights = new Set(grp.map(x => x.flight_id).filter(Boolean));

  if (grp.length === 1 && grp[0].type === "SCENARIO_RESET") {
    paint("impact", node, `<div class="impact"><div class="line"><div class="k">Latest change</div>
      <div class="v">The demo was reset. ${esc(state.flights.length)} flights are back on their original schedule with nothing delayed.</div></div></div>`);
    return;
  }

  const changes = [];
  if (gate) changes.push(`gate ${mono(gate.from_value)} \u2192 ${mono(gate.to_value)}`);
  if (crew) changes.push(`crew ${mono(crew.from_value)} \u2192 ${mono(crew.to_value)}`);
  if (bumps.length) changes.push(`${bumps.map(b => mono(b.flight_id)).join(", ")} moved later`);
  if (!changes.length) changes.push('<span class="muted">no gate or crew change was needed</span>');

  paint("impact", node, `<div class="impact">
    <div class="line"><div class="k">Flight</div><div class="v">${mono(root || "\u2014")}${blocked ? ' <span class="chip c-danger" style="margin-left:8px">Blocked</span>' : ""}</div></div>
    <div class="line"><div class="k">Delay</div><div class="v">${delay ? `now ${mono(delay.to_value)} instead of ${mono(delay.from_value)}` : '<span class="muted">not delayed</span>'}</div></div>
    <div class="line"><div class="k">What changed</div><div class="v">${changes.join(" &nbsp;\u00b7&nbsp; ")}</div></div>
    <div class="line"><div class="k">Knock-on reach</div><div class="v">${plural(flights.size, "flight")} and ${plural(bags.length, "bag")} affected${bumps.length ? `, ${plural(bumps.length, "flight")} moved to make room` : ""}</div></div>
    ${blocked ? `<div class="line"><div class="k">Outcome</div><div class="v" style="color:#f0a7a7">${txt(blocked.reason)}</div></div>` : ""}
  </div>`);
}

/* ---------------- flights ---------------- */

function renderFlights() {
  const q = state.f.search.toLowerCase();
  const rows = state.flights.filter(f => {
    if (state.f.status !== "ALL" && f.status !== state.f.status) return false;
    if (!q) return true;
    return [f.flight_id, f.airline, f.origin, f.destination, f.gate_id, f.crew_id, f.terminal]
      .some(v => String(v || "").toLowerCase().includes(q));
  });
  $("#f-count").textContent = `${rows.length} of ${state.flights.length}`;
  if (!rows.length) { paint("flights", $("#flights-tw"), empty("No matches", state.flights.length ? "Try a different search." : "Waiting for today's schedule.")); return; }
  const html = `<table><thead><tr>
      <th>Flight</th><th>Airline</th><th>Route</th><th>Scheduled</th><th>Now</th>
      <th>Gate</th><th>Crew</th><th class="num">Seats</th><th>Status</th><th class="num">Delay</th>
    </tr></thead><tbody>${rows.map(f => {
    const sch = (f.scheduled_arrival && f.scheduled_departure) ? `${f.scheduled_arrival}\u2013${f.scheduled_departure}` : null;
    const cur = (f.arrival_time && f.departure_time) ? `${f.arrival_time}\u2013${f.departure_time}` : null;
    const late = f.delay_minutes > 0;
    return `<tr class="clickable ${late ? "late" : ""}" data-fid="${esc(f.flight_id)}" tabindex="0">
      <td class="mono" style="font-weight:600">${esc(f.flight_id)}</td>
      <td>${dash(f.airline)}</td>
      <td class="mono">${f.origin && f.destination ? esc(f.origin) + " \u2192 " + esc(f.destination) : '<span class="muted">&mdash;</span>'}</td>
      <td class="mono muted">${sch || "&mdash;"}</td>
      <td class="mono" style="${late ? "color:var(--gold-2)" : ""}">${cur || "&mdash;"}</td>
      <td class="mono">${dash(f.gate_id)}</td>
      <td class="mono">${dash(f.crew_id)}</td>
      <td class="num">${f.passengers == null ? '<span class="muted">&mdash;</span>' : esc(f.passengers)}</td>
      <td>${statusChip(f.status)}</td>
      <td class="num" style="${late ? "color:var(--gold-2)" : "color:var(--muted)"}">${late ? f.delay_minutes + " min" : "\u2014"}</td>
    </tr>`;
  }).join("")}</tbody></table>`;
  paint("flights", $("#flights-tw"), html);
}

/* ---------------- gates / crew ---------------- */

function byTerminal(items, key) {
  const m = new Map();
  items.forEach(x => {
    const t = x.terminal || "\u2014";
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(x);
  });
  return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, arr]) => [t, arr.sort((a, b) => String(a[key]).localeCompare(String(b[key])))]);
}
function gateBlocks(gid) {
  return state.flights.filter(f => f.gate_id === gid && f.arrival_time)
    .sort((a, b) => (t2m(a.arrival_time) || 0) - (t2m(b.arrival_time) || 0));
}

function renderGates() {
  if (!state.gates.length) { paint("gates", $("#gates"), empty("No gates yet", "Waiting for the operations server.")); return; }
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const card = g => {
    const bs = gateBlocks(g.gate_id);
    const occupied = bs.reduce((s, f) => {
      const a = t2m(f.arrival_time), d = t2m(f.departure_time);
      return s + (a != null && d != null ? Math.max(0, d - a) + BUFFER : 0);
    }, 0);
    const util = Math.min(100, Math.round(occupied / SPAN * 100));
    const current = bs.find(f => { const a = t2m(f.arrival_time), d = t2m(f.departure_time); return a != null && d != null && nowM >= a && nowM <= d; });
    const next = bs.find(f => (t2m(f.arrival_time) || 0) > nowM);
    const mini = bs.map(f => {
      const a = t2m(f.arrival_time), d = t2m(f.departure_time);
      if (a == null || d == null) return "";
      const l = Math.max(0, (a - DAY_START) / SPAN * 100), w = Math.max(1, (Math.min(d, DAY_END) - Math.max(a, DAY_START)) / SPAN * 100);
      const c = f.status === "CANCELLED" ? "c" : (f.status === "DELAYED" ? "d" : "");
      return `<i class="${c}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%" title="${esc(f.flight_id)}"></i>`;
    }).join("");
    const pairs = (current || next)
      ? [["Right now", current ? current.flight_id : null, current ? current.arrival_time + "\u2013" + current.departure_time : "gate is free"],
      ["Next up", next ? next.flight_id : null, next ? next.arrival_time + "\u2013" + next.departure_time : "nothing else today"]]
      : (bs.length
        ? [["First today", bs[0].flight_id, bs[0].arrival_time + "\u2013" + bs[0].departure_time],
        ["Last today", bs[bs.length - 1].flight_id, bs[bs.length - 1].arrival_time + "\u2013" + bs[bs.length - 1].departure_time]]
        : []);
    return `<div class="card">
      <div class="card-h"><div><div class="card-id">${esc(g.gate_id)}</div><div class="card-sub">Terminal ${esc(g.terminal || "\u2014")}</div></div>${statusChip(g.status)}</div>
      <div class="bar"><i style="width:${util}%"></i></div>
      <div class="meta"><span>${util}% of the day booked</span><span>${plural(bs.length, "flight")}</span></div>
      <div class="mini">${mini}<span class="lbl">06\u201322</span></div>
      <div class="asg">${pairs.length ? pairs.map(p => `<div class="asg-r"><span class="muted" style="font-size:11px">${esc(p[0])}</span><span class="mono">${p[1] ? esc(p[1]) : "\u2014"}</span><span class="tm">${esc(p[2])}</span></div>`).join("")
        : `<div class="asg-r muted">No flights scheduled here today</div>`}</div>
      <div class="card-foot"><span>15 min gap kept between flights</span><span>${bs.filter(f => f.status === "DELAYED").length ? plural(bs.filter(f => f.status === "DELAYED").length, "delay") : "no delays"}</span></div>
    </div>`;
  };
  paint("gates", $("#gates"), byTerminal(state.gates, "gate_id").map(([t, arr]) => {
    const moves = arr.reduce((s, g) => s + gateBlocks(g.gate_id).length, 0);
    return `<div class="cards-sec"><div class="sec-h">Terminal ${esc(t)}<span>${plural(arr.length, "gate")} \u00b7 ${plural(moves, "flight")}</span></div>
      <div class="cards">${arr.map(card).join("")}</div></div>`;
  }).join(""));
}

function renderCrew() {
  if (!state.crews.length) { paint("crew", $("#crew"), empty("No crew yet", "Waiting for the operations server.")); return; }
  const card = c => {
    const asg = state.flights.filter(f => f.crew_id === c.crew_id && f.status !== "CANCELLED")
      .sort((a, b) => (t2m(a.arrival_time) || 0) - (t2m(b.arrival_time) || 0));
    const from = t2m(c.available_from), until = t2m(c.available_until);
    const shiftL = from == null ? 0 : Math.max(0, (from - DAY_START) / SPAN * 100);
    const shiftW = (from == null || until == null) ? 100 : Math.max(2, (Math.min(until, DAY_END) - Math.max(from, DAY_START)) / SPAN * 100);
    const lastEnd = asg.length ? t2m(asg[asg.length - 1].departure_time) : null;
    const slack = (until != null && lastEnd != null) ? until - lastEnd : null;
    const blocks = asg.map(f => {
      const a = t2m(f.arrival_time), d = t2m(f.departure_time);
      if (a == null || d == null) return "";
      const l = Math.max(0, (a - DAY_START) / SPAN * 100), w = Math.max(1, (Math.min(d, DAY_END) - Math.max(a, DAY_START)) / SPAN * 100);
      return `<i class="${f.status === "DELAYED" ? "d" : ""}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%" title="${esc(f.flight_id)}"></i>`;
    }).join("");
    return `<div class="card">
      <div class="card-h"><div><div class="card-id">${esc(c.crew_id)}</div><div class="card-sub">Terminal ${esc(c.terminal || "\u2014")}</div></div>${statusChip(c.status)}</div>
      <div class="mini" style="margin-top:2px">
        <i style="left:${shiftL.toFixed(2)}%;width:${shiftW.toFixed(2)}%;background:rgba(217,210,195,.09);border-color:rgba(217,210,195,.2)"></i>
        ${blocks}<span class="lbl">06\u201322</span></div>
      <div class="meta"><span>On shift ${esc(c.available_from || "\u2014")}\u2013${esc(c.available_until || "\u2014")}</span><span>${plural(asg.length, "flight")}</span></div>
      <div class="asg">${asg.length ? asg.map(f => `<div class="asg-r"><span class="mono">${esc(f.flight_id)}</span>${f.gate_id ? `<span class="muted mono" style="font-size:11px">gate ${esc(f.gate_id)}</span>` : ""}<span class="tm">${esc(f.arrival_time || "")}\u2013${esc(f.departure_time || "")}</span></div>`).join("") : `<div class="asg-r muted">Not flying today</div>`}</div>
      <div class="card-foot"><span>20 min rest kept between flights</span><span>${slack == null ? "\u2014" : (slack >= 0 ? slack + " min left on shift" : Math.abs(slack) + " min over")}</span></div>
    </div>`;
  };
  paint("crew", $("#crew"), byTerminal(state.crews, "crew_id").map(([t, arr]) => {
    const n = arr.reduce((s, c) => s + state.flights.filter(f => f.crew_id === c.crew_id && f.status !== "CANCELLED").length, 0);
    return `<div class="cards-sec"><div class="sec-h">Terminal ${esc(t)}<span>${plural(arr.length, "crew")} \u00b7 ${plural(n, "flight")}</span></div>
      <div class="cards">${arr.map(card).join("")}</div></div>`;
  }).join(""));
}

/* ---------------- baggage ---------------- */

function renderBaggage() {
  const q = state.f.bagSearch.toLowerCase();
  const rows = state.bags.filter(b => {
    if (state.f.bagFilter === "RISK" && b.status !== "AT_RISK") return false;
    if (state.f.bagFilter === "CONN" && !b.connecting_flight_id) return false;
    if (!q) return true;
    return [b.bag_id, b.flight_id, b.connecting_flight_id, b.current_location, b.status]
      .some(v => String(v || "").toLowerCase().includes(q));
  });
  $("#b-count").textContent = `${rows.length} of ${state.bags.length}`;
  if (!rows.length) { paint("baggage", $("#baggage-tw"), empty("No matches", state.bags.length ? "Try a different search." : "Waiting for the operations server.")); return; }
  const fmap = new Map(state.flights.map(f => [f.flight_id, f]));
  const html = `<table><thead><tr><th>Bag</th><th>On flight</th><th>Connecting to</th><th>Where it is</th><th>Status</th><th>What this means</th></tr></thead><tbody>${rows.map(b => {
    const f = fmap.get(b.flight_id), cf = fmap.get(b.connecting_flight_id);
    let note = "";
    if (b.status === "AT_RISK") {
      const gap = (f && cf && t2m(cf.departure_time) != null && t2m(f.arrival_time) != null) ? t2m(cf.departure_time) - t2m(f.arrival_time) : null;
      note = gap == null ? "Too little time to make the connection." : `Only ${gap} minutes to make ${b.connecting_flight_id} \u2014 30 are needed.`;
    } else if (b.status === "REROUTED") note = b.connecting_flight_id ? `Re-booked onto ${b.connecting_flight_id}, which leaves later.` : "Re-booked onto a later flight.";
    else if (b.status === "ROUTING_UPDATED") note = "Sent to the belt for the flight's new gate.";
    else if (b.status === "IN_TRANSIT") note = "On its way, nothing to worry about.";
    return `<tr class="${b.status === "AT_RISK" ? "risk-row" : ""}">
      <td class="mono" style="font-weight:600">${esc(b.bag_id)}</td>
      <td class="mono">${dash(b.flight_id)}</td>
      <td class="mono">${b.connecting_flight_id ? esc(b.connecting_flight_id) : '<span class="muted">no connection</span>'}</td>
      <td class="mono muted">${dash(b.current_location)}</td>
      <td>${statusChip(b.status)}</td>
      <td class="muted" style="white-space:normal">${note ? esc(note) : "&mdash;"}</td>
    </tr>`;
  }).join("")}</tbody></table>`;
  paint("baggage", $("#baggage-tw"), html);
}

/* ---------------- decision history ---------------- */

function renderHistory() {
  const types = Array.from(new Set(state.decisions.map(d => d.type).filter(Boolean))).sort();
  const fl = Array.from(new Set(state.decisions.map(d => d.flight_id).filter(Boolean))).sort();
  const tHTML = `<option value="">All kinds of change</option>` + types.map(t => `<option value="${esc(t)}"${state.f.dType === t ? " selected" : ""}>${esc((KIND[t] || [t])[0])}</option>`).join("");
  if (state.sig.dtypes !== tHTML) { state.sig.dtypes = tHTML; $("#d-type").innerHTML = tHTML; }
  const fHTML = `<option value="">All flights</option>` + fl.map(t => `<option value="${esc(t)}"${state.f.dFlight === t ? " selected" : ""}>${esc(t)}</option>`).join("");
  if (state.sig.dflights !== fHTML) { state.sig.dflights = fHTML; $("#d-flight").innerHTML = fHTML; }

  const rows = state.decisions.filter(d =>
    (!state.f.dType || d.type === state.f.dType) &&
    (!state.f.dFlight || d.flight_id === state.f.dFlight));
  $("#d-count").textContent = `${rows.length} of ${state.decisions.length}`;
  if (!rows.length) { paint("dlog", $("#decisions-tw"), empty("Nothing recorded", state.decisions.length ? "No change matches this filter." : "AeroMind has not had to change anything yet.")); return; }
  const html = `<table><thead><tr><th>Time</th><th>Kind</th><th>Flight</th><th>What happened</th><th>Why</th></tr></thead><tbody>${rows.map(d => `
    <tr>
      <td class="mono muted">${esc(String(d.timestamp || "").slice(11, 16) || rel(d.timestamp))}</td>
      <td>${kindChip(d.type)}${(d.depth > 0 && d.type !== "CASCADE_BUMP") ? ` <span class="knock">knock-on</span>` : ""}</td>
      <td class="mono">${dash(d.flight_id)}</td>
      <td style="white-space:normal;max-width:330px">${esc(say(d))}</td>
      <td style="white-space:normal;max-width:420px;color:var(--muted)">${d.reason ? txt(d.reason) : '<span class="muted">&mdash;</span>'}</td>
    </tr>`).join("")}</tbody></table>`;
  paint("dlog", $("#decisions-tw"), html);
}

/* ---------------- delay a flight ---------------- */

function renderFlightSelect() {
  const sel = $("#sim-flight");
  const html = state.flights.length
    ? state.flights.map(f => `<option value="${esc(f.flight_id)}">${esc(f.flight_id)} \u00b7 ${esc(f.airline || "")} ${f.origin && f.destination ? esc(f.origin + "\u2013" + f.destination) : ""} \u00b7 ${esc(f.arrival_time || "")}\u2013${esc(f.departure_time || "")} \u00b7 gate ${esc(f.gate_id || "-")}</option>`).join("")
    : `<option value="">No flights available yet</option>`;
  if (state.sig.simsel !== html) {
    const cur = sel.value; state.sig.simsel = html; sel.innerHTML = html;
    if (cur && state.flights.some(f => f.flight_id === cur)) sel.value = cur;
  }
  if (!state.sig.quick) {
    state.sig.quick = 1;
    $("#sim-quick").innerHTML = [15, 30, 45, 60, 90].map(m => `<button class="chipbtn${m === 30 ? " on" : ""}" data-min="${m}">${m} min</button>`).join("");
  }
}

function renderPresets() {
  const list = state.presets && state.presets.length ? state.presets : [];
  $("#presets-note").textContent = list.length ? plural(list.length, "scenario") : "";
  if (!list.length) { paint("presets", $("#presets"), empty("Scenarios unavailable", "The demo scenarios could not be loaded.")); return; }
  paint("presets", $("#presets"), list.map(p => `
    <div class="preset">
      <div class="preset-n">${esc(PRESET_TITLE[p.id] || p.name || p.id)}</div>
      <div class="preset-d">${esc(PRESET_STORY[p.id] || pretty(p.description || ""))}</div>
      ${p.expected ? `<div class="preset-e">${esc(outcomeLine(p))}</div>` : ""}
      <div class="preset-f">
        <button class="btn sm primary" data-preset="${esc(p.id)}"><svg><use href="#i-play"/></svg>Run</button>
        ${p.flight_id ? `<button class="link" data-ppreview="${esc(p.flight_id)}" data-pmin="${esc(p.delay_minutes || 30)}">Preview first</button>` : ""}
        ${p.flight_id ? `<span class="fid">${esc(p.flight_id)} &middot; ${esc(p.delay_minutes || 30)} min</span>` : ""}
      </div>
    </div>`).join(""));
}

function outcomeLine(p) {
  let s = pretty(p.expected || "");
  s = s.replace(/^RESOLVED\s*[-\u2014:]?\s*/i, "What you'll see: ")
    .replace(/^BLOCKED\s*[-\u2014:]?\s*/i, "What you'll see: nothing changes \u2014 ");
  if (!/^What you'll see/.test(s)) s = "What you'll see: " + s;
  return s;
}

function planDetailsHTML(p) {
  const actions = Array.isArray(p.actions) ? p.actions : [];
  const conflicts = Array.isArray(p.conflicts_detected) ? p.conflicts_detected : [];
  const bags = Array.isArray(p.baggage) ? p.baggage : [];
  const collide = Array.isArray(p.cascade_preview) ? p.cascade_preview : [];
  let html = "";
  if (conflicts.length) {
    html += `<div class="plan-sec"><div class="sec-t">Clashes the delay created <span class="n">${conflicts.length}</span></div>
      ${conflicts.map(c => `<div class="confl">
        ${chip(c.resource_type === "CREW" ? "Crew" : "Gate", "c-danger")}
        <span class="mono">${esc(c.resource_id || "")}</span>
        <span class="muted">already promised to</span><span class="mono">${esc(c.flight_id || "")}</span>
        ${c.window ? `<span class="mono muted">${esc(c.window.arrival || "")}\u2013${esc(c.window.departure || "")}</span>` : ""}
        ${c.overlap_minutes != null ? `<span class="chip c-danger" style="margin-left:auto">${esc(c.overlap_minutes)} min overlap</span>` : ""}
      </div>`).join("")}</div>`;
  }
  if (actions.length) {
    const byHop = new Map();
    actions.forEach(a => { const h = a.depth || 0; if (!byHop.has(h)) byHop.set(h, []); byHop.get(h).push(a); });
    html += `<div class="plan-sec"><div class="sec-t">Every step AeroMind took <span class="n">${actions.length}</span></div>
      ${Array.from(byHop.keys()).sort((a, b) => a - b).map(h => `
        <div class="hopgrp"><div class="hop-h">${h === 0 ? "On the delayed flight" : "Knock-on change " + h}</div>
        ${byHop.get(h).map(a => `<div class="act">
          <div class="sev-bar sev-${esc(a.severity || "INFO")}"></div>
          <div class="act-b"><div class="act-top">${kindChip(a.type)}<span class="mono" style="font-weight:600">${esc(a.flight_id || "")}</span>
            ${(a.from_value || a.to_value) ? `<span class="fr-move">${esc(a.from_value || "\u2014")}<span class="ar">\u2192</span>${esc(a.to_value || "\u2014")}</span>` : ""}</div>
            ${a.reason ? `<div class="act-r">${txt(a.reason)}</div>` : ""}</div></div>`).join("")}</div>`).join("")}</div>`;
  }
  if (bags.length) {
    html += `<div class="plan-sec"><div class="sec-t">Baggage <span class="n">${bags.length}</span></div>
      ${bags.map(b => `<div class="act"><div class="sev-bar sev-${b.risk ? "HIGH" : "INFO"}"></div>
        <div class="act-b"><div class="act-top"><span class="mono" style="font-weight:600">${esc(b.bag_id)}</span>
        ${b.status ? statusChip(b.status) : ""}
        ${(b.old_location || b.new_location) ? `<span class="fr-move">${esc(b.old_location || "\u2014")}<span class="ar">\u2192</span>${esc(b.new_location || "\u2014")}</span>` : ""}
        ${b.risk ? chip("would miss its connection", "c-danger") : ""}
        ${b.rebooked_to ? chip("re-booked onto " + b.rebooked_to, "c-ok") : ""}</div></div></div>`).join("")}</div>`;
  }
  if (collide.length) {
    html += `<div class="plan-sec"><div class="sec-t">Would have clashed if nothing was done <span class="n">${collide.length}</span></div>
      <div class="collide">${collide.map(c => `<span class="coll"><span class="mono">${esc(c.flight_id || "")}</span>
        ${c.gate ? `<span>gate ${esc(c.gate)}</span>` : ""}${c.crew ? `<span>crew ${esc(c.crew)}</span>` : ""}</span>`).join("")}</div></div>`;
  }
  return html || `<div class="plan-sec muted" style="font-size:12.5px">No further detail for this plan.</div>`;
}

function renderResult() {
  const wrap = $("#result-wrap");
  if (state.planBusy) {
    paint("result", wrap, `<div class="result"><div class="res-top">
      <div class="res-badge">Working it out</div>
      <div class="res-headline">Checking every gate, crew and bag this delay would touch\u2026</div></div></div>`);
    return;
  }
  const p = state.plan;
  if (!p) {
    paint("result", wrap, `<div class="result"><div class="res-top">
      <div class="res-badge">Ready</div>
      <div class="res-headline">Pick a flight and a delay on the left, then press <span style="color:var(--gold-2)">See what would happen</span>.</div>
      <div style="margin-top:12px;color:var(--muted);font-size:13px">AeroMind will work out every gate clash, crew problem and bag connection the delay creates &mdash; and show you the fix before anything is saved.</div>
      </div></div>`);
    return;
  }
  if (p.__error) {
    paint("result", wrap, `<div class="result blocked"><div class="res-top">
      <div class="res-badge blocked">Could not do that</div>
      <div class="res-headline">${esc(p.__error)}</div>
      ${p.__detail ? `<div style="margin-top:11px;color:var(--muted);font-size:13px">${esc(p.__detail)}</div>` : ""}
      </div></div>`);
    return;
  }

  const applied = state.planMode === "applied";
  const blocked = p.status === "BLOCKED";
  const badge = blocked ? ["blocked", "Blocked"] : (applied ? ["applied", "Applied"] : ["", "Preview"]);
  const why = (Array.isArray(p.actions) ? p.actions : []).filter(a => a.type === "BLOCKED").map(a => a.reason)[0];
  const integ = p.integrity;
  const ok = !integ || (integ.ok !== false && !(integ.violations || []).length);

  paint("result", wrap, `<div class="result ${blocked ? "blocked" : ""}">
    <div class="res-top">
      <div class="res-badge ${badge[0]}">${esc(badge[1])}${p.resolution_ms != null ? ` \u00b7 resolved in ${esc(p.resolution_ms)} ms` : ""}</div>
      <div class="res-headline">${esc(planStory(p))}</div>
    </div>
    ${blocked && why ? `<div class="blocked-note"><svg><use href="#i-alert"/></svg><div>${txt(why)}</div></div>` : ""}
    <div class="changed">${planChanges(p).map(r => `<div class="ch-row"><div class="ch-k">${esc(r[0])}</div><div class="ch-v">${r[1]}</div></div>`).join("")}</div>
    <div style="padding:2px 24px 14px"><button class="btn sm ghost" id="btn-share"><svg><use href="#i-copy"/></svg>Share this plan</button></div>
    <details class="more"><summary>Show details</summary><div class="more-body">${planDetailsHTML(p)}</div></details>
    <div class="integ ${ok ? "" : "bad"}"><svg><use href="#i-shield"/></svg>
      ${!ok ? "This plan would break the guarantee, so nothing was saved."
      : blocked ? "Nothing was saved, so today's schedule is untouched and the guarantee still holds."
        : applied ? "Checked and saved &mdash; no two flights share a gate or crew."
          : "Checked &mdash; this plan keeps the guarantee."}</div>
  </div>`);
}

async function runSim(flightId, minutes, mode) {
  if (!flightId) { toast("Pick a flight", "Choose a flight in step 1 first."); return; }
  go("delay");
  state.planBusy = true; state.plan = null; renderResult();
  state.mutedUntil = Date.now() + 4000;
  const path = mode === "preview" ? `/flights/${encodeURIComponent(flightId)}/simulate` : `/flights/${encodeURIComponent(flightId)}/delay`;
  const r = await send(path, { delay_minutes: Number(minutes) });
  state.planBusy = false;
  if (!r.ok || !r.data) {
    const detail = r.data && (r.data.detail || r.data.message);
    state.plan = {
      __error: r.status === 0 ? "We can't reach the operations server" : `${flightId} could not be delayed by ${minutes} minutes`,
      __detail: typeof detail === "string" ? pretty(detail) : "Please try again in a moment."
    };
    state.planMode = null; renderResult();
    return;
  }
  state.plan = r.data;
  state.planMode = mode === "preview" ? "preview" : "applied";
  renderResult();
  if (mode !== "preview" && window.Cine) Cine.animatePlan(r.data);
  toast(mode === "preview" ? "Preview ready" : "Plan applied", planStory(r.data), r.data.status === "BLOCKED" ? "CRITICAL" : "INFO");
  if (mode !== "preview") await refresh();
}

async function runPreset(id) {
  const list = state.presets || [];
  const p = list.find(x => x.id === id);
  go("delay");
  state.planBusy = true; state.plan = null; renderResult();
  state.mutedUntil = Date.now() + 4000;
  let r = await send(`/scenario/presets/${encodeURIComponent(id)}/run`);
  if ((!r.ok || !r.data) && p && p.flight_id) {
    r = await send(`/flights/${encodeURIComponent(p.flight_id)}/delay`, { delay_minutes: Number(p.delay_minutes || 30) });
  }
  state.planBusy = false;
  if (!r.ok || !r.data) {
    state.plan = { __error: "That scenario could not be run", __detail: "The operations server did not accept it. Please try again." };
    renderResult(); return;
  }
  state.plan = r.data; state.planMode = "applied"; renderResult();
  if (window.Cine) Cine.animatePlan(r.data);
  toast(PRESET_TITLE[id] || "Scenario run", planStory(r.data), r.data.status === "BLOCKED" ? "CRITICAL" : "INFO");
  await refresh();
}

/* ---------------- drawer ---------------- */

async function openDrawer(fid) {
  state.drawer = fid;
  $("#drawer").classList.add("on"); $("#scrim").classList.add("on");
  document.body.classList.add("drawer-open");
  $("#dw-id").textContent = fid;
  await refreshDrawer(true);
  $("#dw-close").focus();
}
function closeDrawer() {
  state.drawer = null; state.drawerData = null;
  $("#drawer").classList.remove("on"); $("#scrim").classList.remove("on");
  document.body.classList.remove("drawer-open");
}
async function refreshDrawer(force) {
  const fid = state.drawer; if (!fid) return;
  const f = state.flights.find(x => x.flight_id === fid);
  $("#dw-sub").textContent = f ? [f.airline, f.origin && f.destination ? f.origin + " \u2192 " + f.destination : null, "Terminal " + (f.terminal || "")].filter(Boolean).join(" \u00b7 ") : "Flight detail";
  if (force || !state.drawerData || state.drawerData.fid !== fid) {
    const [cascade, dec] = await Promise.all([
      fetchJSON(`/flights/${encodeURIComponent(fid)}/cascade`),
      fetchJSON(`/decisions?limit=50&flight_id=${encodeURIComponent(fid)}`)
    ]);
    state.drawerData = { fid, cascade, decisions: dec && dec.decisions ? dec.decisions : state.decisions.filter(d => d.flight_id === fid) };
  }
  const c = state.drawerData.cascade, dl = state.drawerData.decisions || [];
  let html = "";
  if (f) {
    html += `<div class="dw-sec"><div class="dw-t">Right now</div><dl class="kv">
      <dt>Status</dt><dd>${statusChip(f.status)}</dd>
      <dt>Planned</dt><dd>${f.scheduled_arrival ? esc(f.scheduled_arrival + " \u2013 " + (f.scheduled_departure || "")) : "&mdash;"}</dd>
      <dt>Now</dt><dd style="${f.delay_minutes ? "color:var(--gold-2)" : ""}">${esc((f.arrival_time || "\u2014") + " \u2013 " + (f.departure_time || "\u2014"))}</dd>
      <dt>Delay</dt><dd>${f.delay_minutes ? f.delay_minutes + " min" : "none"}</dd>
      <dt>Gate</dt><dd>${dash(f.gate_id)}</dd><dt>Crew</dt><dd>${dash(f.crew_id)}</dd>
      <dt>Aircraft</dt><dd>${dash(f.aircraft)}</dd><dt>Passengers</dt><dd>${dash(f.passengers)}</dd>
    </dl></div>`;
  }
  if (c) {
    const af = c.affected_flights || [], ab = c.affected_baggage || [];
    html += `<div class="dw-sec"><div class="dw-t">What this flight affects</div>
      <div style="font-size:13px;line-height:1.6;margin-bottom:10px">
        ${af.length ? `${plural(af.length, "other flight")} and ` : "No other flight, and "}${plural(c.total_affected_bags ?? ab.length, "bag")} are tied to it.</div>
      ${af.map(x => `<div class="asg-r"><span class="mono">${esc(x.flight_id || x)}</span><span class="tm">${esc(x.impact || x.reason || x.gate || "")}</span></div>`).join("")}
      ${ab.length ? `<div class="asg" style="margin-top:8px">${ab.map(b => `<div class="asg-r"><span class="mono">${esc(b.bag_id)}</span>${statusChip(b.status)}<span class="tm">${esc(b.location || b.current_location || "")}</span></div>`).join("")}</div>` : ""}
    </div>`;
  }
  html += `<div class="dw-sec"><div class="dw-t">Decision history</div>`;
  html += dl.length ? dl.map(d => `<div class="act">
      <div class="sev-bar sev-${esc(d.severity || "INFO")}"></div>
      <div class="act-b"><div class="act-top">${kindChip(d.type)}${(d.depth > 0 && d.type !== "CASCADE_BUMP") ? `<span class="knock">knock-on</span>` : ""}</div>
      <div style="font-size:12.5px;margin-top:5px">${esc(say(d))}</div>
      ${d.reason ? `<div class="act-r">${txt(d.reason)}</div>` : ""}</div></div>`).join("")
    : `<div class="muted" style="font-size:12.5px">Nothing has had to change for this flight.</div>`;
  html += `</div>`;
  paint("drawer" + fid, $("#dw-body"), html);
}

/* ---------------- toasts ---------------- */

function toast(title, msg, sev) {
  if (window.Cine && Cine.inPlay && Cine.inPlay()) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="sev-bar sev-${esc(sev || "INFO")}"></div><div class="toast-b">
    <div class="toast-t">${esc(title)}</div>${msg ? `<div class="toast-m">${esc(msg)}</div>` : ""}</div>`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, 5600);
  while ($("#toasts").children.length > 3) $("#toasts").firstChild.remove();
}

/* ---------------- nav ---------------- */

const VIEWS = {
  home: ["Home", "Today at a glance"],
  delay: ["Delay a flight", "See the knock-on effect before you commit to it"],
  flights: ["Flights", "Everything flying today. Click any row for the full story."],
  gates: ["Gates", "How busy each gate is, and which aircraft it is holding."],
  crew: ["Crew", "Each crew's shift, what they are flying, and how much time they have left."],
  baggage: ["Baggage", "Where every bag is heading. Bags that might miss a connection are highlighted."],
  report: ["Day report", "A printable record of everything that happened today."],
  history: ["Decision history", "Every change AeroMind has made today, newest first, with the reason for each one."],
  how: ["How it works", "What AeroMind does, in four steps"]
};
function go(view) {
  if (!VIEWS[view]) view = "home";
  state.view = view;
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(s => s.classList.toggle("active", s.id === "v-" + view));
  $("#view-title").textContent = VIEWS[view][0];
  $("#view-sub").textContent = VIEWS[view][1];
  $("#sidebar").classList.remove("on");
  if (location.hash.slice(1) !== view) history.replaceState(null, "", "#" + view);
  window.scrollTo(0, 0);
  renderAll();
}

/* ---------------- events ---------------- */

$("#nav").addEventListener("click", e => {
  const b = e.target.closest(".nav-item"); if (b) go(b.dataset.view);
});
$("#menu").addEventListener("click", () => $("#sidebar").classList.toggle("on"));
$("#btn-preview").addEventListener("click", () => runSim($("#sim-flight").value, $("#sim-min").value, "preview"));
$("#btn-apply").addEventListener("click", () => runSim($("#sim-flight").value, $("#sim-min").value, "apply"));
$("#sim-quick").addEventListener("click", e => {
  const b = e.target.closest("[data-min]"); if (!b) return;
  $("#sim-min").value = b.dataset.min;
  $$("#sim-quick .chipbtn").forEach(x => x.classList.toggle("on", x === b));
});
$("#sim-min").addEventListener("input", () => {
  $$("#sim-quick .chipbtn").forEach(x => x.classList.toggle("on", x.dataset.min === $("#sim-min").value));
});
$("#presets").addEventListener("click", e => {
  const run = e.target.closest("[data-preset]");
  if (run) { runPreset(run.dataset.preset); return; }
  const pv = e.target.closest("[data-ppreview]");
  if (pv) runSim(pv.dataset.ppreview, pv.dataset.pmin, "preview");
});
$("#btn-chaos").addEventListener("click", async () => {
  if (!confirm("Throw three random delays at the airport at once?")) return;
  state.mutedUntil = Date.now() + 4000;
  const r = await send("/scenario/chaos", { count: 3, max_delay: 60 });
  if (!r.ok) { toast("Not available", "That could not be run right now."); return; }
  const cas = r.data && r.data.cascades;
  if (Array.isArray(cas) && cas.length) { state.plan = cas[cas.length - 1]; state.planMode = "applied"; }
  toast("A chaotic hour", pretty((r.data && r.data.summary) || "Random delays applied."), "HIGH");
  await refresh();
});
$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("Put the schedule back to its clean starting state? Everything applied today will be cleared.")) return;
  state.mutedUntil = Date.now() + 4000;
  const r = await send("/scenario/reset");
  if (!r.ok) { toast("Not available", "The reset could not be run right now."); return; }
  state.plan = null; state.planMode = null; state.seenDecisions.clear(); state.blockSig.clear(); state.booted = false;
  toast("Demo reset", "The schedule is back to its clean starting state.");
  await refresh();
});
$("#f-search").addEventListener("input", e => { state.f.search = e.target.value; renderFlights(); });
$("#f-filter").addEventListener("click", e => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  state.f.status = b.dataset.f;
  $$("#f-filter button").forEach(x => x.classList.toggle("on", x === b));
  renderFlights();
});
$("#b-search").addEventListener("input", e => { state.f.bagSearch = e.target.value; renderBaggage(); });
$("#b-filter").addEventListener("click", e => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  state.f.bagFilter = b.dataset.f;
  $$("#b-filter button").forEach(x => x.classList.toggle("on", x === b));
  renderBaggage();
});
$("#d-type").addEventListener("change", e => { state.f.dType = e.target.value; renderHistory(); });
$("#d-flight").addEventListener("change", e => { state.f.dFlight = e.target.value; renderHistory(); });
$("#d-clear").addEventListener("click", () => {
  state.f.dType = ""; state.f.dFlight = "";
  $("#d-type").value = ""; $("#d-flight").value = "";
  renderHistory();
});
function rowClick(e) {
  const g = e.target.closest("[data-goto]");
  if (g) { go(g.dataset.goto); return; }
  const r = e.target.closest("tr[data-fid]"); if (r) openDrawer(r.dataset.fid);
}
$("#flights-tw").addEventListener("click", rowClick);
$("#ops-tw").addEventListener("click", rowClick);
$("#feed").addEventListener("click", rowClick);
$("#flights-tw").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const r = e.target.closest("tr[data-fid]"); if (r) { e.preventDefault(); openDrawer(r.dataset.fid); }
});
$("#dw-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
$(".dw-f").addEventListener("click", async e => {
  const d = e.target.closest("[data-dl]");
  if (d && state.drawer) { const fid = state.drawer; closeDrawer(); runSim(fid, d.dataset.dl, "preview"); return; }
  if (e.target.closest("#dw-cancel") && state.drawer) {
    if (!confirm("Cancel flight " + state.drawer + "? Its gate and crew will be released.")) return;
    state.mutedUntil = Date.now() + 4000;
    const r = await send(`/flights/${encodeURIComponent(state.drawer)}/cancel`);
    if (!r.ok) { toast("Not available", "That flight could not be cancelled right now."); return; }
    toast("Flight cancelled", state.drawer + " released its gate and crew.", "HIGH");
    await refresh(); await refreshDrawer(true);
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });

const tip = $("#tip");
document.addEventListener("mouseover", e => {
  const b = e.target.closest(".blk"); if (!b) return;
  const d = b.dataset;
  tip.innerHTML = `<div class="tt">${esc(d.f)}</div>
    <div class="tr"><span>At the gate</span><b>${esc(d.s)}\u2013${esc(d.e)}</b></div>
    <div class="tr"><span>Gate</span><b>${esc(d.g)}</b></div>
    <div class="tr"><span>Crew</span><b>${esc(d.c || "\u2014")}</b></div>
    <div class="tr"><span>Status</span><b>${esc(d.st)}</b></div>
    ${+d.d > 0 ? `<div class="tr"><span>Delay</span><b>${esc(d.d)} min</b></div>` : ""}`;
  tip.classList.add("on");
});
document.addEventListener("mousemove", e => {
  if (!tip.classList.contains("on")) return;
  tip.style.left = Math.min(e.clientX + 15, window.innerWidth - 262) + "px";
  tip.style.top = Math.min(e.clientY + 15, window.innerHeight - 140) + "px";
});
document.addEventListener("mouseout", e => { if (e.target.closest(".blk")) tip.classList.remove("on"); });
window.addEventListener("hashchange", () => go(location.hash.slice(1)));

function clock() { $("#clock").textContent = new Date().toTimeString().slice(0, 8); }

async function loadPresets() {
  const p = await fetchJSON("/scenario/presets");
  if (Array.isArray(p) && p.length) { state.presets = p; state.presetsLive = true; if (state.view === "delay") renderPresets(); }
}

window.AM = {
  state, refresh, send, fetchJSON, go, toast, planStory, say, esc, pretty, plural, t2m,
  STATUS_WORD, PRESET_TITLE, VIEWS, runPreset, runSim, renderGantt, paint
};

clock(); setInterval(clock, 1000);
go(location.hash.slice(1) || "home");
refresh();
loadPresets();
setInterval(refresh, 5000);
setInterval(loadPresets, 30000);
