// eTempo Timesheet Automation — iOS Scriptable Script
// Install: https://scriptable.app  (free on App Store)
// Tap to run, or schedule weekly via iOS Shortcuts.

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const CLOCK_IN_HOUR  = 8;    // 08:00
const CLOCK_OUT_HOUR = 16;   // 16:00  (8 hours later)

// ── Helpers ───────────────────────────────────────────────────────────────────

function thisMonday() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoZ(d, hour) {
  const r = new Date(d);
  r.setUTCHours(hour, 0, 0, 0);
  return r.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const BASIC = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);

async function apiGet(path) {
  const req = new Request(SERVER + path);
  req.method = "GET";
  req.headers = { "Accept": "application/json", "User-Agent": "TempoMobile/4.0", "Authorization": BASIC };
  try {
    const raw = await req.loadString();
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

async function apiPost(path, body) {
  const req = new Request(SERVER + path);
  req.method = "POST";
  req.headers = { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "TempoMobile/4.0", "Authorization": BASIC };
  req.body = JSON.stringify(body);
  try {
    const raw = await req.loadString();
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

// ── Marcaje — exact structure from Proxyman capture ───────────────────────────

function marcaje(fecha, sentidoId) {
  return {
    uid:                    USER_ID,
    sentidoId,              // 2 = clock-in, 1 = clock-out
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

async function submitDay(day) {
  const dateStr = day.toISOString().slice(0, 10);
  const fi = isoZ(day, 0);
  const ff = isoZ(day, 23);

  // Skip days already filled
  const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${fi}&fechaFin=${ff}`);
  if (existing.ok && Array.isArray(existing.data) && existing.data.length >= 2) {
    console.log(`${dateStr}: ${existing.data.length} marcajes already — skipping`);
    return { ok: true, skipped: true };
  }

  const inResult  = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR),  2));
  const outResult = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 1));

  console.log(`${dateStr}: IN  ${inResult.status}  ${inResult.raw?.slice(0, 60)}`);
  console.log(`${dateStr}: OUT ${outResult.status}  ${outResult.raw?.slice(0, 60)}`);

  return { ok: inResult.ok && outResult.ok };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Verify auth by fetching profile
  const profile = await apiGet(`/api/perfiles/${USER_ID}`);
  if (!profile.ok) {
    const a = new Alert();
    a.title   = "❌ Auth failed";
    a.message = `GET /api/perfiles/${USER_ID} → ${profile.status}\n${profile.raw?.slice(0, 200)}`;
    a.addAction("OK");
    await a.present();
    Script.complete();
    return;
  }

  const monday = thisMonday();
  let ok = 0, skipped = 0;

  for (let i = 0; i < 5; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const r = await submitDay(day);
    if (r.ok) { ok++; if (r.skipped) skipped++; }
  }

  const a = new Alert();
  a.title   = ok === 5 ? "✅ Done" : "⚠️ Partial";
  a.message = `Week of ${monday.toISOString().slice(0, 10)}\n${ok}/5 days OK (${skipped} already filled)`;
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
