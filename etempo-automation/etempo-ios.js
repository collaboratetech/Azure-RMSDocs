// eTempo Timesheet Automation — iOS Scriptable Script
// Install: https://scriptable.app  (free on App Store)
// Tap to run, or schedule weekly via iOS Shortcuts.

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const CLOCK_IN_HOUR  = 8;    // 08:00  — matches captured marcaje
const CLOCK_OUT_HOUR = 16;   // 16:00  — 8 hours later

// ── Date helpers ──────────────────────────────────────────────────────────────

function thisMonday() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

// Server expects "2026-05-08T08:00:00Z" (no sub-seconds)
function isoZ(d, hour) {
  const r = new Date(d);
  r.setUTCHours(hour, 0, 0, 0);
  return r.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiGet(path, token) {
  const req = new Request(SERVER + path);
  req.method = "GET";
  req.headers = { "Accept": "application/json", "User-Agent": "TempoMobile/4.0", "Authorization": `Bearer ${token}` };
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
  req.headers = { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "TempoMobile/4.0", "Authorization": `Bearer ${token}` };
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
  const userShort = USERNAME.split("@")[0];
  for (const path of ["/api/login", "/api/v1/login"]) {
    for (const user of [userShort, USERNAME]) {
      for (const auth of ["Basic " + btoa(`${userShort}:${PASSWORD}`), null]) {
        const req = new Request(SERVER + path);
        req.method = "POST";
        req.headers = { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "TempoMobile/4.0" };
        if (auth) req.headers["Authorization"] = auth;
        req.body = JSON.stringify({ username: user, password: PASSWORD });
        try {
          const raw    = await req.loadString();
          const status = req.response.statusCode;
          let d; try { d = JSON.parse(raw); } catch (_) { d = { _raw: raw }; }
          console.log(`${status} ${path} user=${user} → ${raw.slice(0, 80)}`);
          if (status >= 200 && status < 300) {
            const token = d.access_token || d.token || d.Token || d.accessToken ||
                          d.jwt || d.id_token || d.sessionToken || d.authToken ||
                          d.SessionId || d.sessionId || d.SessionID;
            if (token) return { token, loginData: d };
            const a = new Alert(); a.title = `Login 200`; a.message = raw.slice(0, 500); a.addAction("OK"); await a.present();
            return { token: null, loginData: d };
          }
        } catch (_) {}
      }
    }
  }
  return null;
}

// ── Marcaje template — exact structure from Proxyman capture ─────────────────

function marcaje(fecha, sentidoId) {
  return {
    uid:                    USER_ID,
    sentidoId,              // 2 = clock-in (entrada), 1 = clock-out (salida)
    fecha,
    estado:                 0,
    justificable:           0,
    manual:                 false,
    origen:                 0,
    deshabilitarIncidencia: false,
    deshabilitarTarea:      false,
  };
}

// ── Submit one day ────────────────────────────────────────────────────────────

async function submitDay(day, token) {
  const dateStr = day.toISOString().slice(0, 10);

  // Check for existing marcajes
  const fi = isoZ(day, 0);
  const ff = isoZ(day, 23);
  const existing = await apiGet(
    `/api/marcajes/${USER_ID}?fechaInicio=${fi}&fechaFin=${ff}`, token
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length >= 2) {
    console.log(`${dateStr}: already has ${existing.data.length} marcajes — skipping`);
    return { ok: true, skipped: true };
  }

  const clockIn  = isoZ(day, CLOCK_IN_HOUR);
  const clockOut = isoZ(day, CLOCK_OUT_HOUR);

  const inResult  = await apiPost("/api/marcajes", marcaje(clockIn,  2), token);
  const outResult = await apiPost("/api/marcajes", marcaje(clockOut, 1), token);

  console.log(`${dateStr}: IN  → ${inResult.status}  ${inResult.raw?.slice(0, 60)}`);
  console.log(`${dateStr}: OUT → ${outResult.status}  ${outResult.raw?.slice(0, 60)}`);

  return { ok: inResult.ok && outResult.ok };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const loginResult = await login();
  if (!loginResult) {
    const a = new Alert(); a.title = "❌ Login failed"; a.message = "Check console."; a.addAction("OK"); await a.present();
    Script.complete(); return;
  }
  if (!loginResult.token) {
    const a = new Alert(); a.title = "⚠️ Login OK — no token"; a.message = JSON.stringify(loginResult.loginData, null, 2).slice(0, 400); a.addAction("OK"); await a.present();
    Script.complete(); return;
  }

  const token  = loginResult.token;
  const monday = thisMonday();
  let ok = 0, skipped = 0;

  for (let i = 0; i < 5; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const r = await submitDay(day, token);
    if (r.ok) { ok++; if (r.skipped) skipped++; }
  }

  const a = new Alert();
  a.title   = ok === 5 ? "✅ Done" : "⚠️ Partial";
  a.message = `Week of ${monday.toISOString().slice(0,10)}\n${ok}/5 days OK (${skipped} already filled)`;
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
