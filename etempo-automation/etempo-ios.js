// eTempo Timesheet Automation — iOS Scriptable Script
// ─────────────────────────────────────────────────────
// Install: https://scriptable.app  (free on App Store)
// Tap to run, or schedule via iOS Shortcuts.

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;                 // confirmed from /api/perfiles/2956
const DAILY_HOURS = 8;                 // hours per day (Mon–Fri)

// Work hours — adjust to match your normal schedule
const START_HOUR = 9;                  // 09:00
const END_HOUR   = 17;                 // 17:00  (9 + 8 = 17)

// Set true to inspect existing marcajes before writing anything
const INSPECT_ONLY = false;

// ── Date helpers ──────────────────────────────────────────────────────────────

function thisMonday() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

// .NET round-trip format: 2026-05-08T09:00:00.0000000Z
function dotnetDate(d) {
  const pad = (n, w=2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.0000000Z`;
}

function dayStart(d) {
  const r = new Date(d); r.setUTCHours(0, 0, 0, 0); return r;
}
function dayEnd(d) {
  const r = new Date(d); r.setUTCHours(23, 59, 59, 0); return r;
}
function workStart(d) {
  const r = new Date(d); r.setUTCHours(START_HOUR, 0, 0, 0); return r;
}
function workEnd(d) {
  const r = new Date(d); r.setUTCHours(END_HOUR, 0, 0, 0); return r;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function authHeaders(token) {
  return {
    "Accept":        "application/json",
    "Content-Type":  "application/json",
    "User-Agent":    "TempoMobile/4.0",
    "Authorization": token ? `Bearer ${token}` : "Basic " + btoa(`${USERNAME}:${PASSWORD}`),
  };
}

async function apiGet(path, token) {
  const req = new Request(SERVER + path);
  req.method = "GET";
  req.headers = authHeaders(token);
  try {
    const raw = await req.loadString();
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

async function apiPost(path, body, token) {
  const req = new Request(SERVER + path);
  req.method = "POST";
  req.headers = authHeaders(token);
  req.body = JSON.stringify(body);
  try {
    const raw = await req.loadString();
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function login() {
  const userShort  = USERNAME.split("@")[0];
  const basicFull  = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);
  const basicShort = "Basic " + btoa(`${userShort}:${PASSWORD}`);

  const loginUrls = ["/api/login", "/api/v1/login"];
  const bodies    = [
    { username: userShort, password: PASSWORD },
    { username: USERNAME,  password: PASSWORD },
  ];

  for (const path of loginUrls) {
    for (const body of bodies) {
      for (const auth of [basicShort, basicFull, null]) {
        const req = new Request(SERVER + path);
        req.method = "POST";
        req.headers = { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "TempoMobile/4.0" };
        if (auth) req.headers["Authorization"] = auth;
        req.body = JSON.stringify(body);
        try {
          const raw    = await req.loadString();
          const status = req.response.statusCode;
          let d; try { d = JSON.parse(raw); } catch (_) { d = { _raw: raw }; }
          console.log(`${status} ${path} → ${raw.slice(0, 80)}`);
          if (status >= 200 && status < 300) {
            const token = d.access_token || d.token || d.Token || d.accessToken ||
                          d.jwt || d.id_token || d.sessionToken || d.authToken ||
                          d.SessionId || d.sessionId || d.SessionID;
            if (token) return { token, loginData: d };
            const a = new Alert(); a.title = `Login 200 — ${path}`; a.message = raw.slice(0, 500); a.addAction("OK"); await a.present();
            return { token: null, loginData: d, raw };
          }
        } catch (_) {}
      }
    }
  }
  return null;
}

// ── Inspect existing marcajes for one day ─────────────────────────────────────

async function inspectDay(day, token) {
  const fi = dotnetDate(dayStart(day));
  const ff = dotnetDate(dayEnd(day));
  const r  = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${fi}&fechaFin=${ff}`, token);
  return r;
}

// ── Submit one day (8 h clock-in + clock-out) ─────────────────────────────────

async function submitDay(day, token) {
  const fi = dotnetDate(dayStart(day));
  const ff = dotnetDate(dayEnd(day));
  const clockIn  = dotnetDate(workStart(day));
  const clockOut = dotnetDate(workEnd(day));

  // First: check if entries already exist
  const existing = await inspectDay(day, token);
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    console.log(`  Already has ${existing.data.length} marcaje(s) — skipping`);
    return { ok: true, skipped: true };
  }

  // Try the payload shapes most likely for a marcajes clock-in/out system
  const payloads = [
    // Single entry covering the whole day
    { fechaInicio: clockIn, fechaFin: clockOut },
    { FechaInicio: clockIn, FechaFin: clockOut },
    // Two separate clock events
    [{ fecha: clockIn, tipo: "E" }, { fecha: clockOut, tipo: "S" }],
    [{ Fecha: clockIn, Tipo: "E" }, { Fecha: clockOut, Tipo: "S" }],
    // Hours-based
    { fecha: clockIn, horas: DAILY_HOURS },
    { fecha: fi,      horas: DAILY_HOURS },
  ];

  for (const payload of payloads) {
    if (Array.isArray(payload)) {
      // Submit as two separate POSTs
      let allOk = true;
      for (const p of payload) {
        const r = await apiPost(`/api/marcajes/${USER_ID}`, p, token);
        console.log(`  POST marcaje ${JSON.stringify(p).slice(0,60)} → ${r.status} ${r.raw?.slice(0,40)}`);
        if (!r.ok) { allOk = false; break; }
      }
      if (allOk) return { ok: true };
    } else {
      const r = await apiPost(`/api/marcajes/${USER_ID}`, payload, token);
      console.log(`  POST marcaje ${JSON.stringify(payload).slice(0,60)} → ${r.status} ${r.raw?.slice(0,40)}`);
      if (r.ok) return { ok: true };
    }
  }
  return { ok: false };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Login
  const loginResult = await login();
  if (!loginResult) {
    const a = new Alert();
    a.title   = "❌ Login failed";
    a.message = "No login endpoint responded.\nCheck console for details.";
    a.addAction("OK");
    await a.present();
    Script.complete();
    return;
  }

  if (!loginResult.token) {
    const a = new Alert();
    a.title   = "⚠️ Login OK — no token";
    a.message = JSON.stringify(loginResult.loginData, null, 2).slice(0, 400);
    a.addAction("OK");
    await a.present();
    Script.complete();
    return;
  }

  const token = loginResult.token;
  const monday = thisMonday();

  // Inspect mode — show existing marcajes for Monday to understand structure
  if (INSPECT_ONLY) {
    const r = await inspectDay(monday, token);
    const a = new Alert();
    a.title   = "Marcajes — Monday";
    a.message = `Status: ${r.status}\n\n${JSON.stringify(r.data, null, 2).slice(0, 600)}`;
    a.addAction("OK");
    await a.present();
    Script.complete();
    return;
  }

  // Fill Mon–Fri
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    console.log(`Processing ${day.toISOString().slice(0,10)} …`);
    const result = await submitDay(day, token);
    if (result.ok) ok++;
  }

  const a = new Alert();
  if (ok === 5) {
    a.title   = "✅ Week filled";
    a.message = `All 5 days submitted (${DAILY_HOURS * 5} h total)\nWeek of ${monday.toISOString().slice(0,10)}`;
  } else {
    a.title   = "⚠️ Partial";
    a.message = `${ok}/5 days submitted.\nCheck console for details.`;
  }
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
