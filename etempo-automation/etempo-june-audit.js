// eTempo June 2026 — Audit & Fill
// Checks every working day in June 2026:
//   0 marcajes  → fills (clock-in + clock-out + anotacion)
//   1 marcaje   → reports as partial (needs manual review)
//   2 marcajes  → already complete, skips
//   3+ marcajes → reports as duplicate (needs manual cleanup)

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const CLOCK_IN_HOUR  = 8;
const CLOCK_OUT_HOUR = 17;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
let SESSION_COOKIE = "";
const BASIC  = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);
const ACCEPT = "application/json,text/json,text/x-json,text/javascript,application/xml,text/xml";
const UA     = "RestSharp/110.2.0.0";

function baseHeaders(v) {
  const h = {
    "Accept": ACCEPT, "User-Agent": UA, "Authorization": BASIC,
    "Accept-Language": "en-GB,en;q=0.9", "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive", "api-version": String(v),
  };
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
  req.method = "GET";
  req.headers = baseHeaders(1);
  try {
    const raw = await req.loadString();
    extractCookie(req.response);
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
    extractCookie(req.response);
    const status = req.response.statusCode;
    let data; try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function isoZ(d, hour) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hour)}:00:00Z`;
}

function localIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T00:00:00`;
}

function dateKey(d) { return localIso(d).slice(0, 10); }

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

// ── June 2026 working days (no public holidays in June) ───────────────────────
function juneWorkingDays() {
  const days = [];
  for (let i = 1; i <= 30; i++) {
    const d = new Date(2026, 5, i);  // month 5 = June
    d.setHours(0, 0, 0, 0);
    const dow = d.getDay();
    if (dow > 0 && dow < 6) days.push(d);
  }
  return days;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const profile = await apiGet(`/api/perfiles/${USER_ID}`);
  if (!profile.ok) {
    const a = new Alert(); a.title = "❌ Auth failed"; a.message = String(profile.status); a.addAction("OK"); await a.present();
    Script.complete(); return;
  }

  const days = juneWorkingDays();
  const complete = [], filled = [], partial = [], duplicates = [], errors = [];

  for (const day of days) {
    const key = dateKey(day);
    const existing = await apiGet(`/api/marcajes/${USER_ID}?fechaInicio=${isoZ(day,0)}&fechaFin=${isoZ(day,23)}`);
    const list = toArray(existing.data);
    const count = list ? list.length : 0;

    if (count >= 3) {
      duplicates.push(`${key} (${count} marcajes)`);
      console.log(`DUPLICATE  ${key}: ${count} marcajes`);

    } else if (count === 2) {
      complete.push(key);
      console.log(`OK         ${key}`);

    } else if (count === 1) {
      partial.push(key);
      console.log(`PARTIAL    ${key}: only 1 marcaje`);

    } else {
      // 0 — fill it
      const inR  = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_IN_HOUR),  2));
      const outR = await apiPost("/api/marcajes", marcaje(isoZ(day, CLOCK_OUT_HOUR), 3));
      const annR = await apiPost(`/api/anotaciones/${USER_ID}`, anotacion(day));

      if (inR.ok && outR.ok && annR.ok) {
        filled.push(key);
        console.log(`FILLED     ${key}`);
      } else {
        const bad = [inR, outR, annR].find(r => !r.ok);
        errors.push(`${key} (${bad.status})`);
        console.log(`ERROR      ${key}: ${bad.status} ${bad.raw?.slice(0,60)}`);
        break;  // stop on first error
      }
    }

    await new Promise(r => Timer.schedule(300, false, r));
  }

  // ── Summary alert ─────────────────────────────────────────────────────────
  const lines = [
    `June 2026 — ${days.length} working days\n`,
    `✅ Already complete: ${complete.length}`,
    `📝 Filled now:       ${filled.length}`,
  ];
  if (partial.length)    lines.push(`⚠️  Partial (1/2):    ${partial.length}  → ${partial.join(", ")}`);
  if (duplicates.length) lines.push(`❌ Duplicates (3+):  ${duplicates.length}  → ${duplicates.join(", ")}`);
  if (errors.length)     lines.push(`🔴 Errors:           ${errors.length}  → ${errors.join(", ")}`);

  const a = new Alert();
  a.title   = errors.length ? "⚠️ Finished with errors" : "✅ June audit complete";
  a.message = lines.join("\n");
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
