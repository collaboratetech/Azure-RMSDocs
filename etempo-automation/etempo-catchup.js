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

async function apiGet(path) {
  const req = new Request(SERVER + path);
  req.method = "GET"; req.headers = baseHeaders(1);
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

  // Warm-up: establishes the session cookie and proves auth, using the same
  // endpoint the fill logic depends on. (The old /api/perfiles/ probe was never
  // confirmed against the real API and aborted the run when it 404'd.)
  const probeDay = days[days.length - 1];
  const probe = await apiGet(
    `/api/marcajes/${USER_ID}?fechaInicio=${dayStart(probeDay)}&fechaFin=${dayEnd(probeDay)}`);

  if (probe.status === 401 || probe.status === 403) {
    const a = new Alert(); a.title = `❌ Auth rejected (${probe.status})`;
    a.message = `${probe.raw?.slice(0, 300)}`;
    a.addAction("OK"); await a.present();
    Script.complete(); return;
  }
  if (!probe.ok) {
    // 404 here means the path itself is wrong, not "no entries" — if we carried
    // on, every day would look empty and we'd post 40+ duplicate days.
    const a = new Alert(); a.title = `❌ Cannot reach marcajes (${probe.status})`;
    a.message = `GET /api/marcajes/${USER_ID}\n\n` +
                `${probe.raw?.slice(0, 250) || "no response"}\n\n` +
                `Run etempo-diag.js and send the output.`;
    a.addAction("OK"); await a.present();
    Script.complete(); return;
  }
  const filled = [], partial = [], errors = [];
  let skipped = 0;

  console.log(`Window: ${dateKey(days[0])} → ${dateKey(days[days.length - 1])} (${days.length} working days)`);

  for (const day of days) {
    const key = dateKey(day);
    const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${dayStart(day)}&fechaFin=${dayEnd(day)}`);

    // The warm-up proved this path works, so a 404 now means "no records for
    // that day" rather than a bad URL — treat it as empty and fill it.
    if (!existing.ok && existing.status !== 404) {
      errors.push(`${key} (GET ${existing.status})`);
      console.log(`${key}: GET failed ${existing.status} — stopping`);
      break;
    }

    const list  = existing.ok ? toArray(existing.data) : null;
    const count = list ? list.length : 0;

    if (count >= 2) {
      skipped++;
      console.log(`${key}: ${count} marcajes — skip`);
    } else {
      // count 1 is a half-filled day: record it, but still complete the day.
      if (count === 1) partial.push(key);

      const inR  = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR),  2));
      const outR = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 3));
      const annR = await apiPost(`/api/anotaciones/${USER_ID}`, anotacion(day));

      if (inR.ok && outR.ok && annR.ok) {
        filled.push(key);
        console.log(`${key}: ✓ IN ${inR.status}  OUT ${outR.status}  ANN ${annR.status}`);
      } else {
        const bad = [inR, outR, annR].find(r => !r.ok);
        errors.push(`${key} (${bad.status})`);
        console.log(`${key}: ✗ ${bad.status} ${bad.raw?.slice(0, 80)}`);
        const a = new Alert();
        a.title   = `❌ ${key} failed (${bad.status})`;
        a.message = bad.raw?.slice(0, 500) || "no response";
        a.addAction("OK"); await a.present();
        break;   // stop on first error
      }
    }

    await new Promise(r => Timer.schedule(300, false, r));
  }

  const lines = [
    `Last ${LOOKBACK_DAYS} days — ${days.length} working days\n`,
    `✅ Already done: ${skipped}`,
    `📝 Filled now:   ${filled.length}`,
  ];
  if (filled.length)  lines.push(`   ${filled.join(", ")}`);
  if (partial.length) lines.push(`⚠️  Had 1 marcaje: ${partial.join(", ")}`);
  if (errors.length)  lines.push(`❌ Errors: ${errors.join(", ")}`);

  const a = new Alert();
  a.title   = errors.length ? "⚠️ Stopped on error" : "✅ Catch-up complete";
  a.message = lines.join("\n");
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
