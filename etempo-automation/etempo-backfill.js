// eTempo Backfill — fills timesheet from 1 Jan 2026 to today
// Ad hoc, run once. Skips weekends, Madrid public holidays, and days
// that already have entries.
//
// VERIFY this holiday list each year against the official Madrid BOE/CAM calendar.

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const CLOCK_IN_HOUR  = 8;   // sentidoId: 2
const CLOCK_OUT_HOUR = 17;  // sentidoId: 3

// ── Madrid public holidays 2026 ───────────────────────────────────────────────
// Sources: national (BOE), Comunidad de Madrid, Madrid city (San Isidro)
// Nov 1 (Sun) → transferred to Nov 2 Mon
// Dec 6 (Sun) → transferred to Dec 7 Mon
const HOLIDAYS = new Set([
  "2026-01-01", // Año Nuevo
  "2026-01-06", // Epifanía del Señor (Reyes Magos)
  "2026-03-19", // San José (Madrid city)
  "2026-04-02", // Jueves Santo (Comunidad de Madrid)
  "2026-04-03", // Viernes Santo (nacional)
  "2026-05-01", // Fiesta del Trabajo (nacional)
  "2026-05-02", // Fiesta de la Comunidad de Madrid (Sat — skipped by weekend check anyway)
  "2026-05-15", // San Isidro (Madrid city, Fri)
  "2026-08-15", // Asunción de la Virgen (nacional, Sat)
  "2026-10-12", // Fiesta Nacional de España (Mon)
  "2026-11-02", // Todos los Santos — transferred from Nov 1 (Sun)
  "2026-12-07", // Día de la Constitución — transferred from Dec 6 (Sun)
  "2026-12-08", // Inmaculada Concepción (Tue)
  "2026-12-25", // Navidad (Fri)
]);

function isWorkingDay(d) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;              // weekend
  const key = d.toISOString().slice(0, 10);
  return !HOLIDAYS.has(key);                             // not a holiday
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function isoZ(d, hour) {
  const r = new Date(d);
  r.setHours(hour, 0, 0, 0);
  return r.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function localIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T00:00:00`;
}

function dayStart(d) { return localIso(d).slice(0, 10) + "T00:00:00Z"; }
function dayEnd(d)   { return localIso(d).slice(0, 10) + "T23:59:59Z"; }

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

// ── HTTP ──────────────────────────────────────────────────────────────────────
let SESSION_COOKIE = "";
const BASIC  = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);
const ACCEPT = "application/json,text/json,text/x-json,text/javascript,application/xml,text/xml";
const UA     = "RestSharp/110.2.0.0";

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
    return { ok: status >= 200 && status < 300, status, data };
  } catch (e) { return { ok: false, status: 0, data: null }; }
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

// ── Process one day ───────────────────────────────────────────────────────────
async function processDay(day) {
  const dateStr = localIso(day).slice(0, 10);
  const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${dayStart(day)}&fechaFin=${dayEnd(day)}`);
  const list = toArray(existing.data);
  if (existing.ok && list !== null && list.length >= 2) {
    return "skip";
  }

  const inRes  = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR),  2));
  const outRes = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 3));
  const annRes = await apiPost(`/api/anotaciones/${USER_ID}`, anotacion(day));

  if (inRes.ok && outRes.ok && annRes.ok) {
    console.log(`${dateStr}: OK`);
    return "ok";
  }

  const failPair = [
    { r: inRes,  l: "IN"  },
    { r: outRes, l: "OUT" },
    { r: annRes, l: "ANN" },
  ].find(x => !x.r.ok);
  console.log(`${dateStr}: FAIL ${failPair.l} ${failPair.r.status} ${failPair.r.raw?.slice(0, 60)}`);
  return "fail";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Establish session
  const profile = await apiGet(`/api/perfiles/${USER_ID}`);
  if (!profile.ok) {
    const a = new Alert();
    a.title   = "❌ Auth failed";
    a.message = String(profile.status);
    a.addAction("OK");
    await a.present();
    Script.complete();
    return;
  }

  const start = new Date("2026-01-01T00:00:00");
  const today = new Date();
  today.setHours(23, 59, 59, 0);

  // Build list of working days
  const workingDays = [];
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    if (isWorkingDay(d)) workingDays.push(new Date(d));
  }

  let ok = 0, skipped = 0, failed = 0;

  for (const day of workingDays) {
    const result = await processDay(day);
    if (result === "ok")     ok++;
    if (result === "skip")   skipped++;
    if (result === "fail") { failed++; break; }   // stop on first failure
    // small pause to avoid flooding the server
    await new Promise(r => Timer.schedule(300, false, r));
  }

  const a = new Alert();
  const total = workingDays.length;
  a.title   = failed ? "⚠️ Stopped on error" : "✅ Backfill complete";
  a.message = `${total} working days (Jan–today)\n` +
              `Posted: ${ok}\n` +
              `Already filled: ${skipped}\n` +
              (failed ? `Failed: ${failed} — check console` : "");
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
