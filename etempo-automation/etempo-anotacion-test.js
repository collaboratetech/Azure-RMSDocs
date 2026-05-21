// eTempo Anotaciones — one-day test
// Tries posting an anotación for today and shows the raw server response.
// If it returns 2xx, update both scripts to use this endpoint.

const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

const BASIC  = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);
const ACCEPT = "application/json,text/json,text/x-json,text/javascript,application/xml,text/xml";
const UA     = "RestSharp/110.2.0.0";

let SESSION_COOKIE = "";

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
  const setCookie = (response.headers || {})["Set-Cookie"] || (response.headers || {})["set-cookie"] || "";
  const match = setCookie.match(/ASP\.NET_SessionId=([^;]+)/);
  if (match) SESSION_COOKIE = `ASP.NET_SessionId=${match[1]}`;
}

// Date as "2026-05-21T00:00:00" — no Z, matches captured format
function localIso(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00:00`;
}

async function main() {
  // Establish session
  const profReq = new Request(`${SERVER}/api/perfiles/${USER_ID}`);
  profReq.method = "GET";
  profReq.headers = baseHeaders(1);
  await profReq.loadString();
  extractSessionCookie(profReq.response);

  const today = new Date();
  const fecha = localIso(today);

  const body = {
    ids:             [USER_ID],
    origenAnotacion: 3,
    tipoAnotacion:   7,
    fechaInicio:     fecha,
    fechaFin:        fecha,
    horaInicio:      0,
    horaFin:         0,
    conceptoId:      16,
  };

  console.log("POST body:", JSON.stringify(body, null, 2));

  const req = new Request(`${SERVER}/api/anotaciones/${USER_ID}`);
  req.method = "POST";
  req.headers = { ...baseHeaders(2), "Content-Type": "application/json; charset=utf-8" };
  req.body = JSON.stringify(body);
  const raw    = await req.loadString();
  const status = req.response.statusCode;

  console.log(`${status}: ${raw}`);

  const a = new Alert();
  a.title   = `${status >= 200 && status < 300 ? "✅" : "❌"} ${status}`;
  a.message = raw.slice(0, 600) || "(empty body)";
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
