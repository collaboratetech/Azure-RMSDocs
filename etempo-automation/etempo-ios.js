// eTempo Timesheet Automation — iOS Scriptable Script
// Install: https://scriptable.app  (free on App Store)

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const CLOCK_IN_HOUR  = 8;    // 08:00 sentidoId: 2
const CLOCK_OUT_HOUR = 17;   // 17:00 sentidoId: 3

// ── State ─────────────────────────────────────────────────────────────────────
let SESSION_COOKIE = "";

const BASIC  = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);
const ACCEPT = "application/json,text/json,text/x-json,text/javascript,application/xml,text/xml";
const UA     = "RestSharp/110.2.0.0";

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

function baseHeaders(apiVersion) {
  const h = {
    "Accept":          ACCEPT,
    "User-Agent":      UA,
    "Authorization":   BASIC,
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection":      "keep-alive",
    "api-version":     String(apiVersion),
  };
  if (SESSION_COOKIE) h["Cookie"] = SESSION_COOKIE;
  return h;
}

function extractSessionCookie(response) {
  // Scriptable exposes response headers via req.response.headers
  const headers = response.headers || {};
  const setCookie = headers["Set-Cookie"] || headers["set-cookie"] || "";
  const match = setCookie.match(/ASP\.NET_SessionId=([^;]+)/);
  if (match) SESSION_COOKIE = `ASP.NET_SessionId=${match[1]}`;
}

async function apiGet(path) {
  const req = new Request(SERVER + path);
  req.method = "GET";
  req.headers = baseHeaders(1);
  try {
    const raw = await req.loadString();
    extractSessionCookie(req.response);
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

async function apiPost(path, body) {
  const req = new Request(SERVER + path);
  req.method = "POST";
  req.headers = { ...baseHeaders(2), "Content-Type": "application/json; charset=utf-8" };
  req.body = JSON.stringify(body);
  try {
    const raw = await req.loadString();
    extractSessionCookie(req.response);
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

// ── Marcaje template ──────────────────────────────────────────────────────────

function marcaje(fecha, sentidoId) {
  return {
    uid:                    USER_ID,
    sentidoId,
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

  const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${fi}&fechaFin=${ff}`);
  if (existing.ok && Array.isArray(existing.data) && existing.data.length >= 2) {
    console.log(`${dateStr}: ${existing.data.length} marcajes already — skipping`);
    return { ok: true, skipped: true };
  }

  const inResult  = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR),  2));
  const outResult = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 3));

  console.log(`${dateStr}: IN  ${inResult.status}  ${inResult.raw?.slice(0, 60)}`);
  console.log(`${dateStr}: OUT ${outResult.status}  ${outResult.raw?.slice(0, 60)}`);

  if (!inResult.ok || !outResult.ok) {
    const failed = !inResult.ok ? inResult : outResult;
    const label  = !inResult.ok ? "IN" : "OUT";
    const a = new Alert();
    a.title   = `❌ ${dateStr} ${label} (${failed.status})`;
    a.message = failed.raw?.slice(0, 500) || "No response";
    a.addAction("OK");
    await a.present();
    return { ok: false };
  }
  return { ok: true };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // First GET establishes the session cookie
  const profile = await apiGet(`/api/perfiles/${USER_ID}`);
  if (!profile.ok) {
    const a = new Alert();
    a.title   = "❌ Auth failed";
    a.message = `${profile.status}\n${profile.raw?.slice(0, 300)}`;
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
