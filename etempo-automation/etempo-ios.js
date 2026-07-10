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

// Converts local hour to UTC — so clock-in at "8am Spain" becomes T06:00:00Z
// and the app displays 08:00 Spain local.  Do NOT use for query ranges.
function isoZ(d, hour) {
  const r = new Date(d);
  r.setHours(hour, 0, 0, 0);
  return r.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// "2026-05-15T00:00:00" — no Z, used by anotaciones endpoint
function localIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T00:00:00`;
}

// Query range helpers — always anchored to midnight/23:59 on the LOCAL calendar
// date, so the range never drifts to the previous/next UTC day.
function dayStart(d) { return localIso(d).slice(0, 10) + "T00:00:00Z"; }
function dayEnd(d)   { return localIso(d).slice(0, 10) + "T23:59:59Z"; }

// Find the marcaje list in any response shape.
// Prefers an array whose items have marcaje fields (sentidoId / uid).
// Falls back to the largest non-empty array, then any array, then null.
function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const arrays = Object.values(data).filter(Array.isArray);
    const isMarcaje = a => a.length > 0 &&
      (a[0].sentidoId !== undefined || a[0].SentidoId !== undefined || a[0].uid !== undefined);
    return arrays.find(isMarcaje)
        || arrays.filter(a => a.length > 0).sort((a,b) => b.length - a.length)[0]
        || arrays[0]
        || null;
  }
  return null;
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

// ── Body builders ─────────────────────────────────────────────────────────────

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

function anotacion(day) {
  const fecha = localIso(day);
  return {
    ids:             [USER_ID],
    origenAnotacion: 3,
    tipoAnotacion:   7,
    fechaInicio:     fecha,
    fechaFin:        fecha,
    horaInicio:      0,
    horaFin:         0,
    conceptoId:      16,   // TRABAJO EN REMOTO
  };
}

// ── Submit one day ────────────────────────────────────────────────────────────

async function submitDay(day) {
  const dateStr = localIso(day).slice(0, 10);
  const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${dayStart(day)}&fechaFin=${dayEnd(day)}`);
  console.log(`${dateStr}: GET ${existing.status} → ${existing.raw}`);
  const list = toArray(existing.data);
  console.log(`${dateStr}: toArray found ${list === null ? "null" : list.length} entries`);
  if (existing.ok && list !== null && list.length >= 2) {
    console.log(`${dateStr}: ${list.length} marcajes already — skipping`);
    return { ok: true, skipped: true };
  }

  const inResult  = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR),  2));
  const outResult = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 3));
  const annResult = await apiPost(`/api/anotaciones/${USER_ID}`, anotacion(day));

  console.log(`${dateStr}: IN  ${inResult.status}  OUT ${outResult.status}  ANN ${annResult.status}`);

  const failed = [
    { r: inResult,  l: "IN"  },
    { r: outResult, l: "OUT" },
    { r: annResult, l: "ANN" },
  ].find(x => !x.r.ok);

  if (failed) {
    const a = new Alert();
    a.title   = `❌ ${dateStr} ${failed.l} (${failed.r.status})`;
    a.message = failed.r.raw?.slice(0, 500) || "No response";
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
