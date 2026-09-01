// eTempo August 2026 — Fill
// Fills all working days Aug 1–31.
// No weekday public holidays in August (Aug 15 Asunción = Saturday, skipped by weekend check).
// Idempotent: skips any day that already has 2+ marcajes.
// Each day: clock-in 08:00 (sentidoId:2) + clock-out 17:00 (sentidoId:3)
//           + anotacion TRABAJO EN REMOTO (conceptoId:16)

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const CLOCK_IN_HOUR  = 8;
const CLOCK_OUT_HOUR = 17;

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
function isoZ(d, hour) {
  const r = new Date(d);
  r.setHours(hour, 0, 0, 0);
  return r.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function localIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T00:00:00`;
}

function dateKey(d) { return localIso(d).slice(0, 10); }
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

// ── Working days Aug 1–31 ─────────────────────────────────────────────────────
function workingDays() {
  const days = [];
  for (let i = 1; i <= 31; i++) {
    const d = new Date(2026, 7, i);   // month 7 = August
    d.setHours(0, 0, 0, 0);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;   // weekend
    days.push(d);
  }
  return days;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const profile = await apiGet(`/api/perfiles/${USER_ID}`);
  if (!profile.ok) {
    const a = new Alert(); a.title = "❌ Auth failed";
    a.message = String(profile.status); a.addAction("OK"); await a.present();
    Script.complete(); return;
  }

  const days = workingDays();
  let filled = 0, skipped = 0, failed = 0;

  for (const day of days) {
    const key = dateKey(day);
    const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${dayStart(day)}&fechaFin=${dayEnd(day)}`);
    const list = toArray(existing.data);
    const count = list ? list.length : 0;

    console.log(`${key}: ${count} existing`);

    if (count >= 2) {
      skipped++;
      console.log(`${key}: already complete — skip`);
    } else {
      const inR  = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR),  2));
      const outR = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 3));
      const annR = await apiPost(`/api/anotaciones/${USER_ID}`, anotacion(day));

      if (inR.ok && outR.ok && annR.ok) {
        filled++;
        console.log(`${key}: ✓ IN ${inR.status}  OUT ${outR.status}  ANN ${annR.status}`);
      } else {
        failed++;
        const bad = [inR, outR, annR].find(r => !r.ok);
        console.log(`${key}: ✗ ${bad.status} ${bad.raw?.slice(0, 80)}`);
        const a = new Alert();
        a.title   = `❌ ${key} failed (${bad.status})`;
        a.message = bad.raw?.slice(0, 500) || "no response";
        a.addAction("OK"); await a.present();
        break;
      }
    }

    await new Promise(r => Timer.schedule(300, false, r));
  }

  const a = new Alert();
  a.title   = failed ? "⚠️ Stopped on error" : "✅ Done";
  a.message = `August 2026 — ${days.length} working days\n` +
              `📝 Filled:       ${filled}\n` +
              `✅ Already done: ${skipped}\n` +
              (failed ? `❌ Errors: ${failed}` : "");
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
