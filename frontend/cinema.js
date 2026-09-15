(function () {
  const A = window.AM;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const SVGNS = "http://www.w3.org/2000/svg";
  const esc = A.esc, pretty = A.pretty, plural = A.plural, t2m = A.t2m;
  const m2t = m => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(Math.round(m) % 60).padStart(2, "0");
  const fmt = n => (n === null || n === undefined || n === "" || (typeof n === "number" && !isFinite(n)))
    ? "\u2014" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const wait = ms => new Promise(r => setTimeout(r, ms));

  /* ================= geometry ================= */
  const MAP = { w: 1000, h: 400, taxiY: 172, dockY: 213, padY: 190, padH: 100 };
  const STANDS = {};
  function layout(gates) {
    const t1 = gates.filter(g => (g.terminal || "") === "T1").map(g => g.gate_id).sort();
    const t2 = gates.filter(g => (g.terminal || "") !== "T1").map(g => g.gate_id).sort();
    const place = (ids, x0, x1) => {
      const n = Math.max(ids.length, 1), span = (x1 - x0) / n;
      ids.forEach((id, i) => { STANDS[id] = { x: Math.round(x0 + span * (i + 0.5)), t: ids === t1 ? "T1" : "T2" }; });
    };
    place(t1, 84, 474); place(t2, 566, 934);
    return { t1, t2 };
  }

  /* ================= state ================= */
  const C = {
    vt: 540, playing: false, speed: 2, raf: 0, last: 0,
    fired: new Set(), beats: null, docked: new Map(), ghosts: new Map(), story: null,
    report: null, sound: false, actx: null, busy: 0, ticking: false, session: false
  };
  const LOCAL_BEATS = [
    { at: 525, preset: "double-conflict", title: "A morning delay", narration: "08:45 \u2014 F101 reports 30 minutes late. Its gate is promised to F102 and its crew to F103." },
    { at: 555, preset: "cascade-bump", title: "A knock-on delay", narration: "09:15 \u2014 F201 lands 45 minutes late in Terminal 2. Nothing is free: something else has to move first." },
    { at: 630, preset: "blocked", title: "Nothing left to give", narration: "10:30 \u2014 F203 asks for another hour. Every gate is taken and the only other flight outranks it." },
    { at: 665, preset: "missed-connection", title: "Bags at risk", narration: "11:05 \u2014 F104 is 90 minutes late. Two transfer bags can no longer make their onward flight." },
    { at: 945, preset: "evening-rush", title: "The evening rush", narration: "15:45 \u2014 The evening departures stack up and the airport has to absorb all of them at once." }
  ];

  /* ================= progress line ================= */
  window.addEventListener("am:fetch", e => {
    C.busy += e.detail;
    const p = $("#progress");
    if (C.busy > 0) { p.classList.add("on"); p.style.width = "72%"; }
    else { p.style.width = "100%"; p.classList.remove("on"); setTimeout(() => { p.style.width = "0"; }, 320); }
  });

  /* ================= count up ================= */
  const seen = {};
  function countUp(el) {
    const k = el.dataset.k, to = parseFloat(el.dataset.to);
    if (!isFinite(to)) { el.textContent = el.dataset.raw || el.textContent; return; }
    const from = seen[k] === undefined ? (to === 0 ? 0 : 0) : seen[k];
    seen[k] = to;
    if (from === to) { el.textContent = el.dataset.pre + fmt(to) + el.dataset.suf; return; }
    const t0 = performance.now(), dur = 700, dec = (el.dataset.dec | 0);
    (function step(t) {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      el.textContent = el.dataset.pre + fmt(dec ? v.toFixed(dec) : Math.round(v)) + el.dataset.suf;
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  function sweepCounts(root) { $$((root || "") + " .cu").forEach(countUp); }

  /* ================= hero strip ================= */
  function heroHTML() {
    const m = A.state.metrics || {};
    const cell = (k, v, l, pre, suf, dec) => `<div class="hero-s"><div class="v cu" data-k="${k}" data-to="${v == null ? "" : v}"
      data-pre="${pre || ""}" data-suf="${suf || ""}" data-dec="${dec || 0}" data-raw="\u2014">\u2014</div><div class="l">${l}</div></div>`;
    return `<div class="hero-stats">
      ${cell("pax", m.passengers_protected, "passengers protected")}
      ${cell("abs", m.delay_minutes_absorbed, "delay minutes absorbed")}
      ${cell("ms", m.last_resolution_ms, "last plan worked out", "", " ms")}
    </div>
    <div class="hl-actions">
      <button class="btn primary" id="btn-play"><svg><use href="#i-play"/></svg>Play the day</button>
      <button class="btn ghost" data-nav="how">How it works</button>
    </div>`;
  }

  /* ================= airport map ================= */
  function buildMap() {
    const gates = A.state.gates || [];
    if (!gates.length) return false;
    const { t1, t2 } = layout(gates);
    const gmap = new Map(gates.map(g => [g.gate_id, g]));
    const pad = id => {
      const s = STANDS[id], g = gmap.get(id) || {};
      const maint = g.status === "MAINTENANCE";
      return `<g class="st" data-g="${esc(id)}">
        <line class="lead" x1="${s.x}" y1="${MAP.taxiY}" x2="${s.x}" y2="${MAP.padY + 8}"/>
        <rect class="stand${maint ? " maint" : ""}" id="pad-${esc(id)}" x="${s.x - 40}" y="${MAP.padY}" width="80" height="${MAP.padH}" rx="5"/>
        <text class="stand-id" id="sid-${esc(id)}" x="${s.x}" y="${MAP.padY + MAP.padH - 9}">${esc(id)}</text>
        ${maint ? `<text class="maint-l" x="${s.x}" y="${MAP.padY + 52}">CLOSED</text>` : ""}
      </g>`;
    };
    const pier = (x, w, label) => `<g><rect class="pier" x="${x}" y="296" width="${w}" height="52" rx="7"/>
      <text class="pier-l" x="${x + 18}" y="327">${esc(label)}</text></g>`;

    $("#map").innerHTML = `
      <defs>
        <pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="7" height="7" fill="#151312"/><line x1="0" y1="0" x2="0" y2="7" stroke="rgba(212,175,55,.1)" stroke-width="3"/>
        </pattern>
      </defs>
      <rect class="runway" x="40" y="46" width="920" height="26" rx="3"/>
      <line class="rwy-dash" x1="60" y1="59" x2="940" y2="59"/>
      <text class="rwy-l" x="44" y="88">RUNWAY 09 / 27</text>
      <path class="link" d="M150 72 L 210 ${MAP.taxiY}"/><path class="link" d="M850 72 L 790 ${MAP.taxiY}"/>
      <rect class="apron" x="44" y="140" width="912" height="226" rx="10"/>
      <line class="taxi" x1="52" y1="${MAP.taxiY}" x2="948" y2="${MAP.taxiY}"/>
      <line class="taxi-c" x1="52" y1="${MAP.taxiY}" x2="948" y2="${MAP.taxiY}"/>
      <text class="rwy-l" x="44" y="160">TAXIWAY ALPHA</text>
      <path class="belt" d="M100 372 H 900"/>
      <text class="rwy-l" x="44" y="376">BAGGAGE</text>
      ${t1.map(pad).join("")}${t2.map(pad).join("")}
      ${pier(78, 400, "Terminal 1")}${pier(560, 378, "Terminal 2")}
      <line class="nowbar" id="map-now" x1="0" y1="0" x2="0" y2="0"/>
      <g id="ac-layer"></g><g id="fx-layer"></g>`;
    return true;
  }

  const AC_PATH = "M0,-13 C2.2,-13 3.3,-9 3.5,-5 L13,0.6 L13,3.3 L3.5,0.9 L3.3,7.6 L6.3,10.1 L6.3,11.7 L0,10.3 L-6.3,11.7 L-6.3,10.1 L-3.3,7.6 L-3.5,0.9 L-13,3.3 L-13,0.6 L-3.5,-5 C-3.3,-9 -2.2,-13 0,-13 Z";

  function acNode(f) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "ac" + (f.delay_minutes > 0 ? " late" : ""));
    g.dataset.f = f.flight_id;
    const dot = f.status === "CANCELLED" ? "sd-can" : (f.delay_minutes > 0 ? "sd-late" : "sd-on");
    g.innerHTML = `<g class="inner"><path class="body" d="${AC_PATH}"/></g>
      <circle class="sd ${dot}" cx="-27" cy="35" r="2.6"/>
      <text class="fid" y="39">${esc(f.flight_id)}</text>
      <text class="rt crewb" y="50">${esc((f.origin || "") + "\u2013" + (f.destination || ""))}</text>`;
    g.addEventListener("mouseenter", () => showTip(g, f));
    g.addEventListener("mouseleave", hideTip);
    return g;
  }
  function setT(el, x, y) { el.style.transform = `translate(${x}px, ${y}px)`; }

  function showTip(el, f) {
    const tip = $("#tip"), r = el.getBoundingClientRect();
    tip.innerHTML = `<div class="tt">${esc(f.flight_id)}</div>
      <div class="tr"><span>Airline</span><b>${esc(f.airline || "\u2014")}</b></div>
      <div class="tr"><span>Route</span><b>${esc((f.origin || "?") + " \u2192 " + (f.destination || "?"))}</b></div>
      <div class="tr"><span>At the gate</span><b>${esc((f.arrival_time || "") + "\u2013" + (f.departure_time || ""))}</b></div>
      <div class="tr"><span>Crew</span><b>${esc(f.crew_id || "\u2014")}</b></div>
      <div class="tr"><span>Passengers</span><b>${esc(f.passengers == null ? "\u2014" : f.passengers)}</b></div>
      ${f.delay_minutes > 0 ? `<div class="tr"><span>Delay</span><b>${f.delay_minutes} min</b></div>` : ""}`;
    tip.style.left = Math.min(r.left + r.width / 2, innerWidth - 262) + "px";
    tip.style.top = Math.max(12, r.top - 132) + "px";
    tip.classList.add("on");
  }
  function hideTip() { $("#tip").classList.remove("on"); }

  function fx(kind, gateId) {
    const s = STANDS[gateId]; if (!s) return;
    const layer = $("#fx-layer"); if (!layer) return;
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("class", "ring " + kind);
    c.setAttribute("cx", s.x); c.setAttribute("cy", MAP.dockY); c.setAttribute("r", 22);
    layer.appendChild(c);
    setTimeout(() => c.remove(), 1250);
  }
  function bags(fromGate, toGate, n) {
    const a = STANDS[fromGate], b = STANDS[toGate];
    if (!a || !b) return;
    const layer = $("#fx-layer");
    for (let i = 0; i < (n || 3); i++) {
      const g = document.createElementNS(SVGNS, "g");
      g.innerHTML = `<circle class="bag" r="3">
        <animateMotion dur="1.5s" begin="${i * 0.16}s" fill="freeze"
          path="M${a.x} ${MAP.dockY + 52} L${a.x} 372 L${b.x} 372 L${b.x} ${MAP.dockY + 52}"/></circle>`;
      layer.appendChild(g);
      setTimeout(() => g.remove(), 2100 + i * 160);
    }
  }
  function shake(gateId) {
    const p = $("#pad-" + CSS.escape(gateId)); if (!p) return;
    p.classList.add("shake"); setTimeout(() => p.classList.remove("shake"), 1100);
  }

  const LEAD = 25, LAG = 10;
  function syncMap() {
    const layer = $("#ac-layer"); if (!layer) return;
    const vt = C.vt;
    const live = new Map(), taken = new Set();
    (A.state.flights || []).forEach(f => {
      if (f.status === "CANCELLED" || !f.gate_id || !STANDS[f.gate_id]) return;
      const a = t2m(f.arrival_time), d = t2m(f.departure_time);
      if (a == null || d == null) return;
      if (vt >= a - LEAD && vt <= d + LAG) { live.set(f.flight_id, f); taken.add(f.gate_id); }
    });
    C.docked.forEach((el, fid) => {
      if (!live.has(fid)) {
        const gid = el.dataset.g;
        el.classList.add("moving");
        if (STANDS[gid]) setT(el, STANDS[gid].x, MAP.taxiY);
        setTimeout(() => setT(el, 1090, MAP.taxiY), 460);
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 1500);
        C.docked.delete(fid);
      }
    });
    live.forEach((f, fid) => {
      const s2 = STANDS[f.gate_id];
      let el = C.docked.get(fid);
      if (!el) {
        const gh = C.ghosts.get(f.gate_id);
        if (gh) { gh.remove(); C.ghosts.delete(f.gate_id); }
        el = acNode(f); el.dataset.g = f.gate_id;
        setT(el, -90, MAP.taxiY); el.style.opacity = "0";
        layer.appendChild(el);
        C.docked.set(fid, el);
        requestAnimationFrame(() => {
          el.style.opacity = "1";
          setT(el, s2.x, MAP.taxiY);
          setTimeout(() => setT(el, s2.x, MAP.dockY), 520);
        });
      } else {
        if (el.dataset.g !== f.gate_id) moveAircraft(fid, el.dataset.g, f.gate_id);
        el.classList.toggle("late", f.delay_minutes > 0);
        const dot = el.querySelector(".sd");
        if (dot) dot.setAttribute("class", "sd " + (f.status === "CANCELLED" ? "sd-can" : (f.delay_minutes > 0 ? "sd-late" : "sd-on")));
      }
    });

    // ghosts: the next aircraft due at every free stand
    const nextAt = {};
    (A.state.flights || []).forEach(f => {
      if (f.status === "CANCELLED" || !f.gate_id || !STANDS[f.gate_id] || taken.has(f.gate_id)) return;
      const a = t2m(f.arrival_time);
      if (a == null || a <= vt) return;
      if (!nextAt[f.gate_id] || a < t2m(nextAt[f.gate_id].arrival_time)) nextAt[f.gate_id] = f;
    });
    Object.keys(STANDS).forEach(gid => {
      const f = nextAt[gid];
      const cur = C.ghosts.get(gid);
      if (!f) { if (cur) { cur.remove(); C.ghosts.delete(gid); } return; }
      if (cur && cur.dataset.f === f.flight_id) return;
      if (cur) cur.remove();
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "ac ghost");
      g.dataset.f = f.flight_id;
      g.innerHTML = `<g class="inner"><path class="body" d="${AC_PATH}"/></g>
        <text class="fid" y="39">${esc(f.flight_id)}</text>
        <text class="rt" y="50">due ${esc(f.arrival_time || "")}</text>`;
      g.addEventListener("mouseenter", () => showTip(g, f));
      g.addEventListener("mouseleave", hideTip);
      setT(g, STANDS[gid].x, MAP.dockY);
      layer.appendChild(g);
      C.ghosts.set(gid, g);
    });

    $$("#map .stand").forEach(pad => {
      const gid = pad.id.slice(4);
      const busy = taken.has(gid);
      pad.classList.toggle("busy", busy);
      const sid = $("#sid-" + CSS.escape(gid));
      if (sid) sid.classList.toggle("busy", busy);
    });
    const due = Object.keys(nextAt).length;
    const note = $("#map-note");
    if (note) note.textContent = `${plural(taken.size, "stand")} in use \u00b7 ${due} aircraft due`;
    const x = 52 + (Math.min(1320, Math.max(360, vt)) - 360) / 960 * 896;
    const nb = $("#map-now");
    if (nb) { nb.setAttribute("x1", x); nb.setAttribute("x2", x); nb.setAttribute("y1", 42); nb.setAttribute("y2", 78); }
    $("#vclock").textContent = m2t(vt);
  }

  function moveAircraft(fid, fromG, toG) {
    const el = C.docked.get(fid); if (!el || !STANDS[toG]) return;
    const a = STANDS[fromG], b = STANDS[toG];
    el.dataset.g = toG;
    el.classList.add("moving");
    fx("red", fromG);
    if (a) setT(el, a.x, MAP.taxiY);
    setTimeout(() => setT(el, b.x, MAP.taxiY), 460);
    setTimeout(() => { setT(el, b.x, MAP.dockY); fx("gold", toG); }, 980);
    setTimeout(() => el.classList.remove("moving"), 1900);
    if (a) bags(fromG, toG, 3);
    const cb = el.querySelector(".crewb");
    if (cb) { cb.classList.add("flip"); setTimeout(() => cb.classList.remove("flip"), 800); }
  }

  async function animatePlan(plan) {
    if (!plan) return;
    if (plan.status === "BLOCKED") {
      const g = (A.state.flights.find(f => f.flight_id === plan.root_flight) || {}).gate_id || plan.old_gate;
      if (g) { fx("red", g); shake(g); }
      chime("low");
      return;
    }
    const root = plan.root_flight;
    if (plan.old_gate && plan.new_gate && plan.old_gate !== plan.new_gate && C.docked.has(root)) {
      moveAircraft(root, plan.old_gate, plan.new_gate);
    } else if (plan.new_gate) { fx("gold", plan.new_gate); }
    chime("ok");
    const bumps = (plan.actions || []).filter(a => a.type === "CASCADE_BUMP" || (a.type === "GATE_REASSIGNED" && a.flight_id !== root));
    for (let i = 0; i < bumps.length; i++) {
      await wait(600);
      const b = bumps[i];
      const el = C.docked.get(b.flight_id);
      if (el && b.type === "GATE_REASSIGNED" && b.from_value && b.to_value) moveAircraft(b.flight_id, b.from_value, b.to_value);
      else if (el) { fx("gold", el.dataset.g); el.classList.add("moving"); setTimeout(() => el.classList.remove("moving"), 900); }
    }
  }

  /* ================= narration ================= */
  let typer = 0;
  function narrate(tag, text) {
    const n = $("#narr"), x = $("#nr-x");
    $("#nr-tag").textContent = tag;
    n.classList.add("on");
    x.classList.remove("done"); x.textContent = "";
    clearInterval(typer);
    let i = 0;
    typer = setInterval(() => {
      x.textContent = text.slice(0, ++i);
      if (i >= text.length) { clearInterval(typer); x.classList.add("done"); }
    }, 16);
  }
  function hideNarr() { $("#narr").classList.remove("on"); }

  /* ================= sound ================= */
  function chime(kind) {
    if (!C.sound) return;
    try {
      C.actx = C.actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = C.actx.currentTime;
      const notes = kind === "low" ? [[174, 0]] : [[587.33, 0], [880, 0.11]];
      notes.forEach(([f, d]) => {
        const o = C.actx.createOscillator(), g = C.actx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(kind === "low" ? 0.09 : 0.06, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + (kind === "low" ? 0.9 : 0.5));
        o.connect(g); g.connect(C.actx.destination);
        o.start(t + d); o.stop(t + d + 1);
      });
    } catch (e) { }
  }

  /* ================= play the day ================= */
  function setVT(v, quiet) {
    C.vt = Math.max(360, Math.min(1320, v));
    $("#scrubber").value = String(Math.round(C.vt));
    if (!quiet) syncMap();
    if (A.state.view === "home") A.renderGantt && A.renderGantt();
  }
  function loop(ts) {
    if (!C.playing) return;
    if (!C.last) C.last = ts;
    const dt = ts - C.last; C.last = ts;
    setVT(C.vt + (dt / 60) * C.speed);
    const beat = (C.beats || []).find(b => !C.fired.has(b.preset) && C.vt >= b.at);
    if (beat) { C.fired.add(beat.preset); runBeat(beat); return; }
    if (C.vt >= 1320) { stopPlay(); showSummary(); return; }
    C.raf = requestAnimationFrame(loop);
  }
  async function runBeat(b) {
    C.playing = false; cancelAnimationFrame(C.raf); C.last = 0;
    setBtns();
    const mc2 = document.querySelector(".map-card");
    if (mc2) mc2.scrollIntoView({ block: "start", behavior: "smooth" });
    narrate(m2t(b.at), b.narration.replace(/^\d{2}:\d{2}\s*\u2014\s*/, ""));
    await wait(2500);
    const r = await A.send(`/scenario/presets/${encodeURIComponent(b.preset)}/run`);
    await A.refresh();
    const plan = r && r.data;
    if (plan) {
      narrate(m2t(b.at), A.planStory(plan));
      animatePlan(plan);
    }
    await wait(3000);
    hideNarr();
    await wait(300);
    if (!C.stopped) { C.playing = true; C.last = 0; setBtns(); C.raf = requestAnimationFrame(loop); }
  }
  async function startPlay() {
    if (!confirm("Play the whole day? The demo will be reset first, then the airport runs from 06:00 to 22:00.")) return;
    C.stopped = false; C.session = true;
    A.go("home");
    await A.send("/scenario/reset");
    A.state.seenDecisions.clear(); A.state.booted = false;
    await A.refresh();
    C.fired.clear();
    C.beats = C.story || LOCAL_BEATS;
    setVT(360);
    C.playing = true; C.last = 0; setBtns();
    const mc = document.querySelector(".map-card");
    if (mc) mc.scrollIntoView({ block: "start", behavior: "smooth" });
    C.raf = requestAnimationFrame(loop);
  }
  function stopPlay() {
    C.playing = false; C.stopped = true; C.session = false; cancelAnimationFrame(C.raf); C.last = 0; hideNarr(); setBtns();
  }
  function setBtns() {
    const b = $("#mp-play");
    if (b) b.innerHTML = C.playing ? `<svg><use href="#i-pause"/></svg>Pause` : `<svg><use href="#i-play"/></svg>Play`;
    $$("#btn-play").forEach(x => { x.disabled = C.playing; });
  }

  /* ================= day summary ================= */
  function showSummary() {
    const m = A.state.metrics || {}, d = A.state.decisions || [];
    const cnt = t => d.filter(x => x.type === t).length;
    const cascades = new Set(d.filter(x => x.type === "DELAY_APPLIED").map(x => x.cascade_id)).size;
    const iv = m.integrity_violations;
    const items = [
      ["Flights handled", m.total_flights],
      ["Disruptions absorbed", cascades],
      ["Knock-on changes", cnt("CASCADE_BUMP")],
      ["Passengers protected", m.passengers_protected != null ? m.passengers_protected : (A.state.flights || []).reduce((s, f) => s + (f.passengers || 0), 0)],
      ["Bags saved", cnt("BAGGAGE_REBOOKED") + cnt("BAGGAGE_REROUTED")],
      ["Changes refused", cnt("BLOCKED")]
    ];
    $("#sum-body").innerHTML = `
      <div class="sum-eyebrow">06:00 &mdash; 22:00</div>
      <div class="sum-h">The day, handled.</div>
      <div class="sum-sub">Every delay was detected, resolved and recorded while the airport kept moving.</div>
      <div class="sum-grid">${items.map((it, i) => `<div class="sum-i">
        <div class="sum-v cu" data-k="sum${i}" data-to="${it[1] == null ? 0 : it[1]}" data-pre="" data-suf="">0</div>
        <div class="sum-l">${esc(it[0])}</div></div>`).join("")}</div>
      <div class="sum-g">
        <svg viewBox="0 0 24 24"><path d="M3.5 12.5 9 18 20.5 6.5"/></svg>
        <div><div class="t">${iv === 0 || iv == null ? "Guarantee held all day" : plural(iv, "conflict") + " to review"}</div>
        <div class="s">No two flights ever shared a gate or a crew.</div></div>
      </div>
      <div class="sum-f">
        <button class="btn primary" id="sum-again"><svg><use href="#i-play"/></svg>Watch again</button>
        <button class="btn" id="sum-report">Open the report</button>
        <button class="btn ghost" id="sum-close">Close</button>
      </div>`;
    $("#summary").classList.add("on");
    $$(".sum-g path").forEach(p => p.style.setProperty("--len", p.getTotalLength()));
    setTimeout(() => sweepCounts("#sum-body"), 200);
    burst();
    chime("ok");
  }
  function burst() {
    const cv = $("#sumcanvas"), ctx = cv.getContext("2d");
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.scale(dpr, dpr);
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const ps = Array.from({ length: 90 }, () => {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6.5;
      return { x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.2, r: 1 + Math.random() * 2.2, l: 1 };
    });
    const t0 = performance.now();
    (function f(t) {
      const el = (t - t0) / 1500;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ps.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.075; p.vx *= 0.988; p.l = Math.max(0, 1 - el);
        ctx.globalAlpha = p.l * 0.9;
        ctx.fillStyle = "#e6c76a";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.3); ctx.fill();
      });
      ctx.globalAlpha = 1;
      if (el < 1) requestAnimationFrame(f); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(t0);
  }

  /* ================= ticker ================= */
  function renderTicker() {
    const d = (A.state.decisions || []).slice(0, 14);
    const win = $("#tk-win");
    if (!d.length) { win.innerHTML = `<div class="tk-run"><span class="tk-i">Standing by. No changes to report.</span></div>`; return; }
    const items = d.map(x => `<span class="tk-i"><b>${esc(x.flight_id || "\u2014")}</b>${esc(A.say(x))}</span>`).join("");
    const html = `<div class="tk-run">${items}${items}</div>`;
    if (win.dataset.sig === html) return;
    win.dataset.sig = html; win.innerHTML = html;
  }

  /* ================= report ================= */
  function deriveReport() {
    const m = A.state.metrics || {}, d = A.state.decisions || [];
    const byC = new Map();
    d.forEach(x => {
      if (!x.cascade_id || x.type === "SCENARIO_RESET") return;
      if (!byC.has(x.cascade_id)) byC.set(x.cascade_id, []);
      byC.get(x.cascade_id).push(x);
    });
    const fm = new Map((A.state.flights || []).map(f => [f.flight_id, f]));
    const disruptions = Array.from(byC.entries()).map(([cid, acts]) => {
      const root = (acts.find(a => a.type === "DELAY_APPLIED") || acts[acts.length - 1] || {}).flight_id;
      const f = fm.get(root) || {};
      const blocked = acts.some(a => a.type === "BLOCKED");
      const gate = acts.find(a => a.type === "GATE_REASSIGNED"), crew = acts.find(a => a.type === "CREW_REASSIGNED");
      const bump = acts.filter(a => a.type === "CASCADE_BUMP");
      const bag = acts.filter(a => String(a.type).startsWith("BAGGAGE"));
      const bits = [];
      if (gate) bits.push(`moved to gate ${gate.to_value}`);
      if (crew) bits.push(`given crew ${crew.to_value}`);
      if (bump.length) bits.push(`${bump.map(b => b.flight_id).join(" and ")} moved later`);
      if (bag.length) bits.push(`${plural(bag.length, "bag")} handled`);
      return {
        cascade_id: cid, root_flight: root, airline: f.airline, delay_minutes: f.delay_minutes,
        route: f.origin && f.destination ? f.origin + " \u2192 " + f.destination : null,
        status: blocked ? "BLOCKED" : "RESOLVED",
        summary: blocked ? `${root} could not be moved \u2014 nothing was changed.`
          : `${root} ran late and was ${bits.length ? bits.join(", ") : "left where it was"}.`,
        actions: acts.slice().reverse().map(a => A.say(a))
      };
    }).reverse();
    return {
      generated_at: new Date().toISOString(), airport: "Bengaluru \u00b7 BLR", metrics: m,
      disruptions, flights: A.state.flights || [],
      baggage_exceptions: (A.state.bags || []).filter(b => b.status === "AT_RISK" || b.status === "REROUTED"),
      guarantee: { ok: (m.integrity_violations || 0) === 0, checked: (A.state.decisions || []).length }
    };
  }
  function renderReport() {
    const r = C.report || deriveReport();
    const airport = typeof r.airport === "string" ? r.airport
      : (r.airport ? `${r.airport.terminals} terminals \u00b7 ${r.airport.gates} gates \u00b7 ${r.airport.crews} crews` : "\u2014");
    const actText = a => typeof a === "string" ? a : A.say(a);
    const isBlocked = d => String(d.status || "").toUpperCase() === "BLOCKED";
    const m = r.metrics || {};
    const node = $("#report");
    const kpis = [
      ["Flights handled", m.total_flights], ["On time", m.on_time_pct == null ? null : m.on_time_pct + "%"],
      ["Delays absorbed", m.delayed], ["Conflicts resolved", m.conflicts_resolved],
      ["Knock-on changes", m.cascade_bumps], ["Bags at risk", m.bags_at_risk]
    ];
    const when = new Date(r.generated_at || Date.now());
    node.innerHTML = `<div class="rep">
      <div class="rep-head">
        <div class="rep-mast">AeroMind &mdash; Daily Operations Report</div>
        <div class="rep-rule"></div>
        <div class="rep-meta">
          <span>Airport <b>${esc(airport)}</b></span>
          <span>Date <b>${esc(when.toDateString())}</b></span>
          <span>Produced <b>${esc(when.toTimeString().slice(0, 5))}</b></span>
          <span>Disruptions <b>${esc((r.disruptions || []).length)}</b></span>
        </div>
      </div>
      <div class="rep-body">
        <div class="rep-sec"><div class="rep-h2">The day in numbers</div>
          <div class="rep-kpis">${kpis.map(k => `<div class="rep-k"><div class="v">${k[1] == null ? "\u2014" : esc(k[1])}</div>
            <div class="l">${esc(k[0])}</div></div>`).join("")}</div></div>

        <div class="rep-sec"><div class="rep-h2">Disruptions handled</div>
          ${(r.disruptions || []).length ? (r.disruptions || []).map((d, i) => `<div class="dis">
            <div class="dis-n">${String(i + 1).padStart(2, "0")}</div>
            <div class="dis-b">
              <div class="dis-h"><span class="fid">${esc(d.root_flight || "\u2014")}</span>
                ${d.airline ? `<span class="rt">${esc(d.airline)}</span>` : ""}
                ${d.route ? `<span class="rt">${esc(pretty(d.route))}</span>` : ""}
                ${d.delay_minutes ? `<span class="chip c-warn">${esc(d.delay_minutes)} min late</span>` : ""}
                <span class="chip ${isBlocked(d) ? "c-danger" : "c-ok"}">${isBlocked(d) ? "Refused" : "Resolved"}</span>
                ${d.resolution_ms != null ? `<span class="rt">worked out in ${esc(Math.round(d.resolution_ms * 10) / 10)} ms</span>` : ""}</div>
              <div class="dis-s">${esc(pretty(d.summary || ""))}</div>
              <ul class="dis-a">${(d.actions || []).map(a => `<li>${esc(pretty(actText(a)))}</li>`).join("")}</ul>
            </div></div>`).join("")
        : `<div class="muted" style="font-size:13px">No disruptions were recorded today.</div>`}
        </div>

        <div class="rep-sec"><div class="rep-h2">Flight record</div>
          <div class="tw"><table><thead><tr><th>Flight</th><th>Airline</th><th>Route</th><th>Planned</th><th>Actual</th>
            <th>Gate</th><th>Crew</th><th>Status</th></tr></thead><tbody>
            ${(r.flights || []).map(f => `<tr><td class="mono">${esc(f.flight_id)}</td><td>${esc(f.airline || "\u2014")}</td>
              <td class="mono">${esc(f.route ? pretty(f.route) : ((f.origin || "?") + " \u2192 " + (f.destination || "?")))}</td>
              <td class="mono muted">${esc(f.scheduled || ((f.scheduled_arrival || "") + "\u2013" + (f.scheduled_departure || "")))}</td>
              <td class="mono"${f.delay_minutes ? ' style="color:var(--gold-2)"' : ''}>${esc(f.now || ((f.arrival_time || "") + "\u2013" + (f.departure_time || "")))}</td>
              <td class="mono">${esc(f.gate_id || "\u2014")}</td><td class="mono">${esc(f.crew_id || "\u2014")}</td>
              <td>${esc(A.STATUS_WORD[f.status] || f.status || "")}</td></tr>`).join("")}
          </tbody></table></div></div>

        <div class="rep-sec"><div class="rep-h2">Baggage exceptions</div>
          ${(r.baggage_exceptions || []).length ? `<div class="tw"><table><thead><tr><th>Bag</th><th>Flight</th>
            <th>Connecting to</th><th>Outcome</th></tr></thead><tbody>
            ${(r.baggage_exceptions || []).map(b => `<tr><td class="mono">${esc(b.bag_id)}</td>
              <td class="mono">${esc(b.flight_id || "\u2014")}</td><td class="mono">${esc(b.connecting_flight_id || "\u2014")}</td>
              <td>${esc(b.status === "AT_RISK" ? "At risk of missing its connection" : "Re-booked onto a later flight")}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="muted" style="font-size:13px">No bag missed a connection today.</div>`}
        </div>

        <div class="rep-sec" style="margin-bottom:0"><div class="rep-h2">Guarantee</div>
          <div class="rep-guar"><svg><use href="#i-shield"/></svg>
            <div>${(r.guarantee && r.guarantee.ok !== false)
        ? "Checked after every single change: no two flights shared a gate or a crew at any point today."
        : "One or more conflicts remain open and need review."}</div></div></div>
      </div></div>`;
  }

  /* ================= command palette ================= */
  const CMDS = () => {
    const base = [
      { t: "Play the day", d: "Watch the whole day unfold", run: startPlay },
      { t: "Reset the demo", d: "Back to the clean schedule", run: async () => { await A.send("/scenario/reset"); await A.refresh(); A.toast("Demo reset", "The schedule is back to its clean starting state."); } },
      { t: "Print the day report", d: "Save as PDF", run: () => { A.go("report"); setTimeout(() => print(), 400); } }
    ];
    Object.keys(A.VIEWS).forEach(v => base.push({ t: "Go to " + A.VIEWS[v][0], d: A.VIEWS[v][1], run: () => A.go(v) }));
    (A.state.presets || []).forEach(p => base.push({
      t: "Run \u201c" + (A.PRESET_TITLE[p.id] || p.name) + "\u201d", d: "Scenario \u00b7 " + p.flight_id + " " + p.delay_minutes + " min",
      run: () => A.runPreset(p.id)
    }));
    return base;
  };
  let palIdx = 0, palList = [];
  function openPal() {
    $("#palette").classList.add("on");
    const i = $("#pal-in"); i.value = ""; palIdx = 0; filterPal(""); i.focus();
  }
  function closePal() { $("#palette").classList.remove("on"); }
  function filterPal(q) {
    const t = q.trim().toLowerCase();
    const dm = t.match(/^delay\s+([a-z]\d+)\s+(\d+)/i);
    palList = dm ? [{
      t: "Delay " + dm[1].toUpperCase() + " by " + dm[2] + " minutes",
      d: "Preview the plan first", run: () => A.runSim(dm[1].toUpperCase(), dm[2], "preview")
    }] : CMDS().filter(c => !t || (c.t + " " + c.d).toLowerCase().includes(t));
    palIdx = 0;
    $("#pal-list").innerHTML = palList.length
      ? palList.slice(0, 40).map((c, i) => `<div class="pal-i${i === 0 ? " sel" : ""}" data-i="${i}">
          <div><div>${esc(c.t)}</div><div class="d">${esc(c.d)}</div></div></div>`).join("")
      : `<div class="pal-i"><div><div>No match</div><div class="d">Try "delay F101 30" or a view name</div></div></div>`;
  }
  function palMove(n) {
    if (!palList.length) return;
    palIdx = (palIdx + n + palList.length) % palList.length;
    $$("#pal-list .pal-i").forEach((e, i) => e.classList.toggle("sel", i === palIdx));
    const s = $("#pal-list .sel"); if (s) s.scrollIntoView({ block: "nearest" });
  }

  /* ================= share ================= */
  function sharePlan() {
    const p = A.state.plan; if (!p || p.__error) { A.toast("Nothing to share", "Preview or apply a plan first."); return; }
    const lines = ["AeroMind \u2014 resolution plan", "", A.planStory(p), ""];
    (p.actions || []).forEach(a => lines.push("  - " + pretty(A.say(a))));
    lines.push("", (p.integrity && p.integrity.ok !== false) ? "Guarantee holds: no two flights share a gate or a crew." : "Guarantee at risk.");
    const txt = lines.join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(() => A.toast("Copied", "The plan is on your clipboard."))
      .catch(() => A.toast("Could not copy", "Your browser blocked clipboard access."));
  }

  /* ================= wiring ================= */
  async function loadExtras() {
    const st = await A.fetchJSON("/scenario/story");
    if (Array.isArray(st) && st.length) {
      C.story = st.map(b => ({
        at: typeof b.at === "string" ? t2m(b.at) : b.at,
        preset: b.preset, title: b.title, narration: b.narration
      })).filter(b => b.at != null).sort((a, b) => a.at - b.at);
    }
    const rp = await A.fetchJSON("/report");
    if (rp && rp.metrics) C.report = rp;
    if (A.state.view === "report") renderReport();
  }

  function onData() {
    if (!$("#map").children.length || $("#map").dataset.n !== String((A.state.gates || []).length)) {
      if (buildMap()) $("#map").dataset.n = String((A.state.gates || []).length);
    }
    if (A.state.view === "home") { syncMap(); sweepCounts("#headline"); sweepCounts("#kpis"); }
    if (A.state.view === "report") renderReport();
    renderTicker();
    $("#ticker").classList.toggle("hide", A.state.view === "report");
  }

  document.addEventListener("click", e => {
    const n = e.target.closest("[data-nav]"); if (n) { A.go(n.dataset.nav); return; }
    if (e.target.closest("#btn-play") || e.target.closest("#sum-again")) {
      $("#summary").classList.remove("on"); startPlay(); return;
    }
    if (e.target.closest("#sum-report")) { $("#summary").classList.remove("on"); A.go("report"); return; }
    if (e.target.closest("#sum-close")) { $("#summary").classList.remove("on"); return; }
    if (e.target.closest("#mp-play")) { if (C.playing) { C.playing = false; cancelAnimationFrame(C.raf); C.last = 0; setBtns(); } else if (C.beats) { C.stopped = false; C.playing = true; C.last = 0; setBtns(); C.raf = requestAnimationFrame(loop); } else startPlay(); return; }
    if (e.target.closest("#mp-stop")) { stopPlay(); return; }
    if (e.target.closest("#rep-print")) { print(); return; }
    if (e.target.closest("#btn-share")) { sharePlan(); return; }
    const sp = e.target.closest("[data-spd]");
    if (sp) { C.speed = +sp.dataset.spd; $$("[data-spd]").forEach(b => b.classList.toggle("on", b === sp)); return; }
    const snd = e.target.closest("#snd");
    if (snd) { C.sound = !C.sound; snd.classList.toggle("ok", C.sound); $("#snd-l").textContent = C.sound ? "Sound on" : "Sound off"; if (C.sound) chime("ok"); return; }
    const pi = e.target.closest(".pal-i");
    if (pi && pi.dataset.i !== undefined) { const c = palList[+pi.dataset.i]; closePal(); if (c) c.run(); return; }
    if (e.target.id === "palette") closePal();
    if (e.target.id === "keys") $("#keys").classList.remove("on");
  });
  $("#scrubber").addEventListener("input", e => {
    if (C.playing) { C.playing = false; cancelAnimationFrame(C.raf); C.last = 0; setBtns(); }
    setVT(+e.target.value);
  });
  $("#pal-in").addEventListener("input", e => filterPal(e.target.value));
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPal(); return; }
    if ($("#palette").classList.contains("on")) {
      if (e.key === "Escape") closePal();
      if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
      if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
      if (e.key === "Enter") { const c = palList[palIdx]; closePal(); if (c) c.run(); }
      return;
    }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.key === "?") { $("#keys").classList.toggle("on"); return; }
    if (e.key === "Escape") { $("#keys").classList.remove("on"); $("#summary").classList.remove("on"); if (C.session) stopPlay(); }
  });

  /* ================= splash ================= */
  function splash() {
    const s = $("#splash");
    const force = /[?&]intro=1/.test(location.search);
    let seenIt = false;
    try { seenIt = localStorage.getItem("am_intro") === "1"; } catch (err) { }
    if (seenIt && !force) { s.remove(); return; }
    const arcs = $("#splash-arcs");
    let d = "";
    for (let i = 0; i < 7; i++) {
      const y = 90 + i * 110, x2 = 1400, cy = y - 150 - i * 12;
      d += `<path d="M-80 ${y} Q 700 ${cy} ${x2} ${y - 40}" style="--len:1600;animation-delay:${(i * 0.13).toFixed(2)}s"/>`;
      d += `<circle r="2.2"><animateMotion dur="${(5 + i * 0.7).toFixed(1)}s" begin="${(0.6 + i * 0.2).toFixed(1)}s"
        repeatCount="indefinite" path="M-80 ${y} Q 700 ${cy} ${x2} ${y - 40}"/></circle>`;
    }
    arcs.innerHTML = d;
    $$("#splash-mark path, #splash-mark circle").forEach(p => {
      try { p.style.setProperty("--len", Math.ceil(p.getTotalLength())); } catch (err) { p.style.setProperty("--len", 300); }
    });
    const done = () => {
      if (s.classList.contains("gone")) return;
      s.classList.add("gone");
      try { localStorage.setItem("am_intro", "1"); } catch (err) { }
      setTimeout(() => s.remove(), 800);
    };
    s.addEventListener("click", done);
    document.addEventListener("keydown", function k(e) { if (e.key === "Escape" || e.key === "Enter") { done(); document.removeEventListener("keydown", k); } });
    if (!force) setTimeout(done, 3500);
    window.__splashDone = done;
  }

  window.Cine = {
    onData, heroHTML, vt: () => C.vt, playing: () => C.playing,
    animatePlan, renderReport, chime, sharePlan, startPlay, setVT, summary: showSummary, loadExtras,
    inPlay: () => C.session
  };
  splash();
  loadExtras();
  setInterval(loadExtras, 20000);
  setVT(540, true);
  $$("[data-spd]").forEach(b => b.classList.toggle("on", +b.dataset.spd === C.speed));
})();
