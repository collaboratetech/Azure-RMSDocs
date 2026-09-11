// eTempo Diagnostic — probes each endpoint and reports exact status + body.
// Read-only: performs NO writes, safe to run any time.
// Run this when a script reports an unexplained error, then send the output.

const SERVER   = "https://philipmorris.softmachine.es:440";
const USERNAME = "william.hill@pmi.com";
const PASSWORD = "50552441";
const USER_ID  = 2956;

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
  if (m) { SESSION_COOKIE = `ASP.NET_SessionId=${m[1]}`; return true; }
  return false;
}

async function probe(label, path, apiVersion) {
  const req = new Request(SERVER + path);
  req.method = "GET";
  req.headers = baseHeaders(apiVersion);
  try {
    const raw  = await req.loadString();
    const got  = extractCookie(req.response);
    const code = req.response.statusCode;
    const line = `${code}  ${label}${got ? "  [cookie]" : ""}`;
    console.log(line);
    console.log(`     ${path}`);
    console.log(`     ${String(raw).slice(0, 200)}`);
    return { label, code, raw: String(raw).slice(0, 200) };
  } catch (e) {
    console.log(`ERR  ${label}: ${e.message}`);
    console.log(`     ${path}`);
    return { label, code: 0, raw: e.message };
  }
}

// Today's date, local calendar.
function todayKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

async function main() {
  const t = todayKey();
  const results = [];

  // The warm-up call the other scripts open with — unverified, prime 404 suspect.
  results.push(await probe("perfiles (warm-up)", `/api/perfiles/${USER_ID}`, 1));

  // The endpoint the fill logic actually depends on — Proxyman-confirmed.
  results.push(await probe("marcajes (today)",
    `/api/marcajes/${USER_ID}?fechaInicio=${t}T00:00:00Z&fechaFin=${t}T23:59:59Z`, 1));

  // Same call at api-version 2, in case v1 was retired.
  results.push(await probe("marcajes (api-version 2)",
    `/api/marcajes/${USER_ID}?fechaInicio=${t}T00:00:00Z&fechaFin=${t}T23:59:59Z`, 2));

  const ok = r => r && r.code >= 200 && r.code < 300;
  const lines = results.map(r => `${ok(r) ? "✅" : "❌"} ${r.code || "ERR"}  ${r.label}`);

  // Report each version on its own. An earlier version of this script used
  // .some() across both, so a v1 failure was masked by a v2 success — which is
  // exactly the case the fill scripts trip over, since they pick one version.
  const v1 = results.find(r => r.label === "marcajes (today)");
  const v2 = results.find(r => r.label === "marcajes (api-version 2)");

  lines.push("");
  if (ok(v1) && ok(v2))       lines.push("✅ marcajes answers on api-version 1 and 2.");
  else if (ok(v2))            lines.push("⚠️ marcajes answers on api-version 2 ONLY.\nGETs must send api-version: 2.");
  else if (ok(v1))            lines.push("⚠️ marcajes answers on api-version 1 ONLY.\nGETs must send api-version: 1.");
  else                        lines.push("❌ marcajes answers on NEITHER version — see console.");

  const a = new Alert();
  a.title   = "eTempo endpoint probe";
  a.message = lines.join("\n");
  a.addAction("OK");
  await a.present();
  Script.complete();
}

await main();
