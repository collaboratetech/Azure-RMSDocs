// eTempo Rolling Catch-up — last 60 days
// Walks back LOOKBACK_DAYS from today. For every working day (Mon–Fri, not a
// Madrid public holiday) with fewer than 2 marcajes, posts a standard day:
//   clock-in 08:00 (sentidoId:2) + clock-out 17:00 (sentidoId:3)
//   + anotacion TRABAJO EN REMOTO (conceptoId:16)
// Idempotent — safe to re-run any time. Supersedes the fixed-month scripts.

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const LOOKBACK_DAYS  = 60;   // includes today
const CLOCK_IN_HOUR  = 8;
const CLOCK_OUT_HOUR = 17;

// A refused day is skipped rather than fatal, so one closed period doesn't
// block the rest of the window. This caps a run where everything is refused.
const MAX_REFUSALS = 25;

// ── Madrid public holidays ────────────────────────────────────────────────────
// VERIFY against the official BOE / Comunidad de Madrid calendar each year,
// and add the next year's dates before the window rolls into it.
const HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // Año Nuevo
  "2026-01-06", // Epifanía del Señor
  "2026-03-19", // San José (Madrid city)
  "2026-04-02", // Jueves Santo (CAM)
  "2026-04-03", // Viernes Santo
  "2026-05-01", // Fiesta del Trabajo
  "2026-05-02", // Fiesta de la Comunidad de Madrid
  "2026-05-15", // San Isidro (Madrid city)
  "2026-08-15", // Asunción de la Virgen
  "2026-10-12", // Fiesta Nacional de España
  "2026-11-02", // Todos los Santos (transferred from Sun Nov 1)
  "2026-12-07", // Día de la Constitución (transferred from Sun Dec 6)
  "2026-12-08", // Inmaculada Concepción
  "2026-12-25", // Navidad
]);

// Extra one-off dates to leave alone (holidays taken, absences, etc.)
// Without these the catch-up would see 0 marcajes and fill the day.
const SKIP_DATES = new Set([
  "2026-07-29", // deliberately excluded in the July run
]);

// ── HTTP ──────────────────────────────────────────────────────────────────────
let SESSION_COOKIE = "";
const BASIC  = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);
const ACCEPT = "application/json,text/json,text/x-json,text/javascript,application/xml,text/xml";
const UA     = "RestSharp/110.2.0.0";

function baseHeaders(v) {
  const h = { "Accept": ACCEPT, "User-Agent": UA, "Authorization": BASIC,
    "Accept-Language": "en-GB,en;q=0.9", "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive", "api-version": String(v) };
  if (SESSION_COOKIE) h["Cookie"] = SESSION_COOKIE;
  return h;
}

function extractCookie(res) {
  const sc = (res.headers || {})["Set-Cookie"] || (res.headers || {})["set-cookie"] || "";
  const m = sc.match(/ASP\.NET_SessionId=([^;]+)/);
  if (m) SESSION_COOKIE = `ASP.NET_SessionId=${m[1]}`;
}

// GETs used api-version 1 historically; the server appears to have retired it,
// answering 404 "Recurso inexistente" because the versioned route no longer
// resolves. Detected at warm-up rather than hardcoded, so this survives the
// server moving again.
let GET_VERSION = 2;

async function apiGet(path, version) {
  const req = new Request(SERVER + path);
  req.method = "GET"; req.headers = baseHeaders(version || GET_VERSION);
  try {
    const raw = await req.loadString();
    extractCookie(req.response);
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
    extractCookie(req.response);
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// Local hour → UTC, so 08:00 Spain posts as T06:00:00Z and displays as 08:00.
function isoZ(d, hour) {
  const r = new Date(d);
  r.setHours(hour, 0, 0, 0);
  return r.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// "2026-09-11T00:00:00" — no Z, used by the anotaciones endpoint.
function localIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T00:00:00`;
}

// Query ranges anchored to the LOCAL calendar date so they never drift a day.
function dateKey(d)  { return localIso(d).slice(0, 10); }
function dayStart(d) { return dateKey(d) + "T00:00:00Z"; }
function dayEnd(d)   { return dateKey(d) + "T23:59:59Z"; }

// ── Response helpers ──────────────────────────────────────────────────────────
function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const arrays = Object.values(data).filter(Array.isArray);
    const isMarcaje = a => a.length > 0 &&
      (a[0].sentidoId !== undefined || a[0].SentidoId !== undefined || a[0].uid !== undefined);
    return arrays.find(isMarcaje)
        || arrays.filter(a => a.length > 0).sort((a, b) => b.length - a.length)[0]
        || arrays[0]
        || null;
  }
  return null;
}

// Pulls the human-readable message out of an error response, e.g.
// {"Message":"Recurso inexistente..."} → "Recurso inexistente...".
function serverMsg(r) {
  const d = r.data;
  if (d && typeof d === "object") {
    const m = d.Message || d.message || d.error || d.Error;
    if (m) return String(m);
  }
  return String(r.raw || "").slice(0, 120);
}

// ── Body builders ─────────────────────────────────────────────────────────────
function marcaje(fecha, sentidoId) {
  return { uid: USER_ID, sentidoId, fecha, estado: 0, justificable: 0,
           manual: false, origen: 0, deshabilitarIncidencia: false, deshabilitarTarea: false };
}

function anotacion(day) {
  const fecha = localIso(day);
  return { ids: [USER_ID], origenAnotacion: 3, tipoAnotacion: 7,
           fechaInicio: fecha, fechaFin: fecha, horaInicio: 0, horaFin: 0, conceptoId: 16 };
}

// ── Working days in the lookback window (oldest first) ───────────────────────
function workingDays() {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let back = LOOKBACK_DAYS - 1; back >= 0; back--) {
    const d = new Date(today);
    d.setDate(today.getDate() - back);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;          // weekend
    const key = dateKey(d);
    if (HOLIDAYS.has(key)) continue;               // public holiday
    if (SKIP_DATES.has(key)) continue;             // manual exclusion
    days.push(d);
  }
  return days;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const days = workingDays();

  // Warm-up: establishes the session cookie, proves auth, and works out which
  // api-version the GET route answers on — trying each in turn rather than
  // assuming, since a retired version 404s in a way that looks like a bad path.
  const probeDay = days[days.length - 1];
  const probeUrl =
    `/api/marcajes/${USER_ID}?fechaInicio=${dayStart(probeDay)}&fechaFin=${dayEnd(probeDay)}`;

  let probe = null;
  for (const v of [2, 1]) {
    const r = await apiGet(probeUrl, v);
    console.log(`warm-up api-version ${v} → ${r.status}`);
    if (r.ok) { GET_VERSION = v; probe = r; break; }
    if (!probe) probe = r;                               // keep the first failure
    if (r.status === 401 || r.status === 403) break;     // auth, not versioning
  }

  if (probe.status === 401 || probe.status === 403) {
    const a = new Alert(); a.title = `❌ Auth rejected (${probe.status})`;
    a.message = `${probe.raw?.slice(0, 300)}`;
    a.addAction("OK"); await a.present();
    Script.complete(); return;
  }
  if (!probe.ok) {
    // Neither version answered — the path itself is wrong. If we carried on,
    // every day would look empty and we'd post 40+ duplicate days.
    const a = new Alert(); a.title = `❌ Cannot reach marcajes (${probe.status})`;
    a.message = `GET /api/marcajes/${USER_ID}\n` +
                `tried api-version 2 and 1\n\n` +
                `${probe.raw?.slice(0, 250) || "no response"}`;
    a.addAction("OK"); await a.present();
    Script.complete(); return;
  }
  console.log(`Using api-version ${GET_VERSION} for GETs.`);
  const filled = [], partial = [], refused = [], incomplete = [];
  let skipped = 0, aborted = "";

  console.log(`Window: ${dateKey(days[0])} → ${dateKey(days[days.length - 1])} (${days.length} working days)`);

  for (const day of days) {
    const key = dateKey(day);
    const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${dayStart(day)}&fechaFin=${dayEnd(day)}`);

    // The warm-up proved this path works, so a 404 now means "no records for
    // that day" rather than a bad URL — treat it as empty and fill it.
    if (!existing.ok && existing.status !== 404) {
      refused.push(`${key} GET ${existing.status}: ${serverMsg(existing)}`);
      console.log(`${key}: GET failed ${existing.status} ${serverMsg(existing)}`);
      continue;
    }

    const list  = existing.ok ? toArray(existing.data) : null;
    const count = list ? list.length : 0;

    if (count >= 2) {
      skipped++;
      console.log(`${key}: ${count} marcajes — skip`);
      continue;
    }

    // count 1 is a half-filled day: record it, but still complete the day.
    if (count === 1) partial.push(key);

    // Clock-in goes first and alone. If the server refuses this day outright
    // (closed period, no contract, etc.) it surfaces here — so don't pile OUT
    // and ANN on top of a day it has already rejected.
    const inR = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR), 2));
    if (!inR.ok) {
      refused.push(`${key} IN ${inR.status}: ${serverMsg(inR)}`);
      console.log(`${key}: ✗ IN ${inR.status} ${serverMsg(inR)}`);
      console.log(`   sent: ${JSON.stringify(marcaje(isoZ(day, CLOCK_IN_HOUR), 2))}`);
      if (refused.length >= MAX_REFUSALS) { aborted = key; break; }
      await new Promise(r => Timer.schedule(300, false, r));
      continue;   // skip this day, keep going — later days may still be open
    }

    const outR = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 3));
    const annR = await apiPost(`/api/anotaciones/${USER_ID}`, anotacion(day));

    if (outR.ok && annR.ok) {
      filled.push(key);
      console.log(`${key}: ✓ IN ${inR.status}  OUT ${outR.status}  ANN ${annR.status}`);
    } else {
      // Clock-in landed but something after it didn't — the day is now partial
      // and needs a look, which is different from a day that was refused whole.
      const bad = !outR.ok
        ? { l: "OUT", r: outR }
        : { l: `ANN (/api/anotaciones/${USER_ID})`, r: annR };
      incomplete.push(`${key} ${bad.l} ${bad.r.status}: ${serverMsg(bad.r)}`);
      console.log(`${key}: ⚠ IN ok but ${bad.l} ${bad.r.status} ${serverMsg(bad.r)}`);
    }

    await new Promise(r => Timer.schedule(300, false, r));
  }

  const lines = [
    `Last ${LOOKBACK_DAYS} days — ${days.length} working days\n`,
    `✅ Already done: ${skipped}`,
    `📝 Filled now:   ${filled.length}`,
  ];
  if (filled.length)  lines.push(`   ${filled[0]} … ${filled[filled.length - 1]}`);
  if (partial.length) lines.push(`\n⚠️  Had 1 marcaje: ${partial.join(", ")}`);

  if (incomplete.length) {
    lines.push(`\n⚠️  Left partial (${incomplete.length}) — clock-in posted, rest failed:`);
    incomplete.slice(0, 5).forEach(e => lines.push(`   ${e}`));
  }

  // The refused range is the useful signal: if it is a contiguous block of the
  // oldest days, the server is closing off past periods rather than erroring.
  if (refused.length) {
    const first = refused[0].split(" ")[0];
    const last  = refused[refused.length - 1].split(" ")[0];
    lines.push(`\n❌ Refused (${refused.length}): ${first} … ${last}`);
    lines.push(`   ${refused[0].split(": ").slice(1).join(": ")}`);
  }
  if (aborted) lines.push(`\n🛑 Stopped at ${aborted} after ${MAX_REFUSALS} refusals.`);

  console.log(`\n── Refused days ──`);
  refused.forEach(e => console.log(e));

  const a = new Alert();
  a.title   = refused.length || incomplete.length
    ? `⚠️ Filled ${filled.length}, refused ${refused.length}`
    : "✅ Catch-up complete";
  a.message = lines.join("\n");
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
