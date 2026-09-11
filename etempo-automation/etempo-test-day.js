// eTempo Single-Day POST Test — isolates which of the three writes fails.
//
// ⚠️ THIS WRITES. It posts one day only, and stops at the first failure, so at
// worst it leaves a partial day behind (visible in the log, easy to delete).
//
// Set TEST_DATE to a day you don't mind touching, then run and send the console.

const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const TEST_DATE = "2026-09-10";   // yyyy-mm-dd — a recent working day
const CLOCK_IN_HOUR  = 8;
const CLOCK_OUT_HOUR = 17;

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
    return { ok: status >= 200 && status < 300, status, data, raw: String(raw) };
  } catch (e) { return { ok: false, status: 0, data: null, raw: e.message }; }
}

// Reports the full request and response for one POST.
async function tryPost(label, path, body) {
  console.log(`\n── ${label} ─────────────────────────`);
  console.log(`POST ${path}`);
  console.log(`body: ${JSON.stringify(body)}`);

  const req = new Request(SERVER + path);
  req.method = "POST";
  req.headers = { ...baseHeaders(2), "Content-Type": "application/json; charset=utf-8" };
  req.body = JSON.stringify(body);

  try {
    const raw    = await req.loadString();
    extractCookie(req.response);
    const status = req.response.statusCode;
    const ok     = status >= 200 && status < 300;
    console.log(`→ ${status} ${ok ? "OK" : "FAIL"}`);
    console.log(`→ ${String(raw).slice(0, 400)}`);
    return { label, ok, status, raw: String(raw).slice(0, 400) };
  } catch (e) {
    console.log(`→ ERR ${e.message}`);
    return { label, ok: false, status: 0, raw: e.message };
  }
}

// ── Date helpers (identical to the catch-up script) ──────────────────────────
function isoZ(d, hour) {
  const r = new Date(d);
  r.setHours(hour, 0, 0, 0);
  return r.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function localIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T00:00:00`;
}

function marcaje(fecha, sentidoId) {
  return { uid: USER_ID, sentidoId, fecha, estado: 0, justificable: 0,
           manual: false, origen: 0, deshabilitarIncidencia: false, deshabilitarTarea: false };
}
function anotacion(day) {
  const fecha = localIso(day);
  return { ids: [USER_ID], origenAnotacion: 3, tipoAnotacion: 7,
           fechaInicio: fecha, fechaFin: fecha, horaInicio: 0, horaFin: 0, conceptoId: 16 };
}

async function main() {
  const [y, m, dd] = TEST_DATE.split("-").map(Number);
  const day = new Date(y, m - 1, dd);
  day.setHours(0, 0, 0, 0);

  console.log(`Test date: ${TEST_DATE}`);

  // Establish cookie + show what's already there.
  const before = await apiGet(
    `/api/marcajes/${USER_ID}?fechaInicio=${TEST_DATE}T00:00:00Z&fechaFin=${TEST_DATE}T23:59:59Z`);
  console.log(`\nGET existing → ${before.status}`);
  console.log(before.raw.slice(0, 300));

  const results = [];

  // Each call is attempted independently so one failure still tells us about
  // the others — except we stop before piling writes on a broken day.
  results.push(await tryPost("IN  clock-in", "/api/marcajes",
    marcaje(isoZ(day, CLOCK_IN_HOUR), 2)));

  if (results[0].ok) {
    results.push(await tryPost("OUT clock-out", "/api/marcajes",
      marcaje(isoZ(day, CLOCK_OUT_HOUR), 3)));
  }

  // The anotacion is worth testing even if the marcajes failed — it is a
  // different endpoint, and conceptoId 16 is the likeliest "resource" in
  // "Recurso inexistente".
  results.push(await tryPost("ANN remote-work", `/api/anotaciones/${USER_ID}`,
    anotacion(day)));

  const lines = results.map(r => `${r.ok ? "✅" : "❌"} ${r.status}  ${r.label}`);
  const firstFail = results.find(r => !r.ok);
  if (firstFail) {
    lines.push("");
    lines.push(firstFail.raw.slice(0, 200));
  }

  const a = new Alert();
  a.title   = firstFail ? "❌ Failure isolated" : "✅ All three OK";
  a.message = lines.join("\n");
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
