// eTempo Timesheet Automation — iOS Scriptable Script
// ─────────────────────────────────────────────────────
// Install: https://scriptable.app  (free on App Store)
// Usage: tap the script, or add a widget, or run via Shortcuts on a schedule.

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER     = "https://philipmorris.softmachine.es:440";
const USERNAME   = "william.hill@pmi.com";
const PASSWORD   = "50552441";
const WEEKLY_HOURS = 40;

// Set to true to run endpoint discovery instead of filling the timesheet
const DISCOVER_MODE = false;

// Pre-login discovery paths — GETted before login to find company/tenant info
const PRE_LOGIN_PATHS = [
  "/api/v1/empresas",
  "/api/v1/empresa",
  "/api/v1/companies",
  "/api/v1/company",
  "/api/v1/tenants",
  "/api/v1/clientes",
  "/api/v1/config",
  "/api/v1/setup",
  "/api/v1/version",
  "/api/v1/info",
  "/api/v1/server",
];

// Timesheet endpoint candidates (GETted first to discover structure)
const TIMESHEET_PATHS = [
  "/api/v1/imputaciones",
  "/api/v1/jornadas",
  "/api/v1/timesheets",
  "/api/v1/timesheet",
  "/api/v1/workdays",
  "/api/v1/entries",
  "/api/v1/timeentries",
  "/api/v1/horas",
  "/api/v1/fichajes",
  "/api/timesheets",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function thisMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateStr(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function apiRequest(method, url, body, token) {
  const req = new Request(url);
  req.method = method;
  req.headers = {
    "Accept":        "application/json",
    "Content-Type":  "application/json",
    "User-Agent":    "TempoMobile/4.0",
    "Authorization": `Bearer ${token}`,
  };
  if (body) req.body = JSON.stringify(body);
  try {
    // loadString so we always get the raw response even on non-JSON
    const raw  = await req.loadString();
    const status = req.response.statusCode;
    let data = null;
    try { data = JSON.parse(raw); } catch (_) { data = raw; }
    return { ok: status >= 200 && status < 300, status, data, raw };
  } catch (e) {
    return { ok: false, status: 0, data: null, raw: e.message };
  }
}

// ── Pre-login: discover company/tenant endpoints ──────────────────────────────

async function preLoginDiscover() {
  const hits = [];
  for (const path of PRE_LOGIN_PATHS) {
    const req = new Request(SERVER + path);
    req.method = "GET";
    req.headers = { "Accept": "application/json", "User-Agent": "TempoMobile/4.0" };
    try {
      const raw    = await req.loadString();
      const status = req.response.statusCode;
      if (status < 400) hits.push({ path, status, raw: raw.slice(0, 200) });
    } catch (_) {}
  }
  if (hits.length > 0) {
    const a = new Alert();
    a.title   = "Pre-login endpoints";
    a.message = hits.map(h => `${h.status} ${h.path}\n${h.raw}`).join("\n\n");
    a.addAction("OK");
    await a.present();
  }
  return hits;
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function tryLogin(url, body, authHeader) {
  const req = new Request(url);
  req.method = "POST";
  req.headers = {
    "Accept":       "application/json",
    "Content-Type": "application/json",
    "User-Agent":   "TempoMobile/4.0",
  };
  if (authHeader) req.headers["Authorization"] = authHeader;
  if (body) req.body = JSON.stringify(body);
  try {
    const raw    = await req.loadString();
    const status = req.response.statusCode;
    let d;
    try { d = JSON.parse(raw); } catch (_) { d = { _raw: raw }; }
    console.log(`${status} ${url.replace(SERVER,"")} ${authHeader?"auth":"no-auth"} ${body?JSON.stringify(body).slice(0,40):"no-body"} → ${raw.slice(0,60)}`);
    return { status, d, raw };
  } catch (_) { return null; }
}

async function login() {
  const userShort = USERNAME.split("@")[0];
  const basicFull  = "Basic " + btoa(`${USERNAME}:${PASSWORD}`);
  const basicShort = "Basic " + btoa(`${userShort}:${PASSWORD}`);

  // Extra headers the mobile app likely sends — try each set in turn
  const headerSets = [
    {},   // no extras (baseline)
    { "X-Api-Key":      "TempoMobile" },
    { "X-Api-Key":      "softmachine" },
    { "X-App-Id":       "com.softmachine.tempomobile" },
    { "X-App-Id":       "com.softmachine.mytempo" },
    { "X-Client-Id":    "TempoMobile" },
    { "X-App-Version":  "4.0.34.0" },
    { "X-Api-Key": "TempoMobile", "X-App-Version": "4.0.34.0" },
  ];

  const loginUrl = SERVER + "/api/v1/login";
  const bodies = [
    { username: userShort, password: PASSWORD },
    { username: USERNAME,  password: PASSWORD },
  ];
  // Also try credentials as query string
  const qsUrls = [
    `${loginUrl}?username=${encodeURIComponent(userShort)}&password=${encodeURIComponent(PASSWORD)}`,
    `${loginUrl}?username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`,
  ];

  for (const extraHeaders of headerSets) {
    for (const body of bodies) {
      for (const auth of [basicShort, basicFull, null]) {
        const req = new Request(loginUrl);
        req.method = "POST";
        req.headers = {
          "Accept":       "application/json",
          "Content-Type": "application/json",
          "User-Agent":   "TempoMobile/4.0",
          ...extraHeaders,
        };
        if (auth) req.headers["Authorization"] = auth;
        req.body = JSON.stringify(body);
        try {
          const raw    = await req.loadString();
          const status = req.response.statusCode;
          let d; try { d = JSON.parse(raw); } catch (_) { d = { _raw: raw }; }
          const extras = Object.keys(extraHeaders).join(",") || "none";
          console.log(`${status} headers=[${extras}] user=${body.username?.split("@")[0]} → ${raw.slice(0,60)}`);
          if (status >= 200 && status < 300) {
            const token = d.access_token || d.token || d.Token || d.accessToken ||
                          d.jwt || d.id_token || d.sessionToken || d.authToken ||
                          d.SessionId || d.sessionId || d.SessionID;
            if (token) return { token, loginData: d };
            const a = new Alert(); a.title = `200!`; a.message = raw.slice(0,500); a.addAction("OK"); await a.present();
            return { token: null, loginData: d, raw };
          }
        } catch (_) {}
      }
    }
    // Query-string attempts (no body)
    for (const url of qsUrls) {
      const req = new Request(url);
      req.method = "POST";
      req.headers = { "Accept": "application/json", "User-Agent": "TempoMobile/4.0", ...extraHeaders };
      try {
        const raw    = await req.loadString();
        const status = req.response.statusCode;
        const extras = Object.keys(extraHeaders).join(",") || "none";
        console.log(`${status} QS headers=[${extras}] → ${raw.slice(0,60)}`);
        if (status >= 200 && status < 300) {
          let d; try { d = JSON.parse(raw); } catch (_) { d = { _raw: raw }; }
          const token = d.access_token || d.token || d.Token || d.sessionId;
          if (token) return { token, loginData: d };
          const a = new Alert(); a.title = `200 QS!`; a.message = raw.slice(0,500); a.addAction("OK"); await a.present();
          return { token: null, loginData: d, raw };
        }
      } catch (_) {}
    }
  }
  return null;
}

// ── Discovery: GET every candidate endpoint and show what comes back ──────────

async function discoverEndpoints(token) {
  const monday  = thisMonday();
  const results = [];

  for (const path of TIMESHEET_PATHS) {
    const url = SERVER + path;
    const r   = await apiRequest("GET", url, null, token);
    results.push({ path, status: r.status, preview: JSON.stringify(r.data).slice(0, 120) });
  }

  // Show results in an alert (scroll through them)
  const lines = results.map(r => `${r.status}  ${r.path}\n     ${r.preview}`).join("\n\n");
  const a = new Alert();
  a.title   = "Endpoint Discovery";
  a.message = lines || "No responses";
  a.addAction("OK");
  await a.present();
  return results;
}

// ── Fill timesheet ────────────────────────────────────────────────────────────

async function fillWeek(token, loginData) {
  const daily  = Math.floor(WEEKLY_HOURS / 5);
  const monday = thisMonday();
  const results = [];

  // Build every plausible payload shape from what we know about the login response
  function buildPayloads(ds, hours) {
    const base = [
      { date: ds,      hours },
      { fecha: ds,     horas: hours },
      { Date: ds,      Hours: hours },
      { workDate: ds,  hours },
      { day: ds,       hours },
    ];
    // If login returned employee/user ID, include it in payloads
    const uid = loginData && (loginData.userId || loginData.UserId ||
                               loginData.employeeId || loginData.id);
    if (uid) {
      base.push({ date: ds, hours, userId: uid });
      base.push({ fecha: ds, horas: hours, empleadoId: uid });
    }
    return base;
  }

  for (let i = 0; i < 5; i++) {
    const day  = new Date(monday);
    day.setDate(monday.getDate() + i);
    const ds   = dateStr(day);
    const hours = daily;

    const payloads = buildPayloads(ds, hours);
    let written = false;

    outer:
    for (const tsPath of TIMESHEET_PATHS) {
      const url = SERVER + tsPath;
      for (const payload of payloads) {
        for (const method of ["POST", "PUT"]) {
          const r = await apiRequest(method, url, payload, token);
          if (r.ok) {
            console.log(`✓ ${ds} ${hours}h via ${method} ${tsPath}`);
            results.push({ date: ds, hours, ok: true, path: tsPath, method });
            written = true;
            break outer;
          }
        }
      }
    }

    if (!written) {
      console.log(`✗ ${ds} — no endpoint accepted the submission`);
      results.push({ date: ds, hours, ok: false });
    }
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Step 0 — Pre-login discovery (finds company/tenant endpoints if any)
  await preLoginDiscover();

  // Step 1 — Login
  const loginResult = await login();
  if (!loginResult) {
    const a = new Alert();
    a.title   = "❌ Login failed";
    a.message = SERVER + "\nNo login endpoint responded. Check console for details.";
    a.addAction("OK");
    await a.present();
    Script.complete();
    return;
  }

  if (!loginResult.token) {
    // Login responded but no token — show what came back so we can debug
    const a = new Alert();
    a.title   = "⚠️ Login OK but no token";
    a.message = JSON.stringify(loginResult.loginData, null, 2).slice(0, 400);
    a.addAction("OK");
    await a.present();
    Script.complete();
    return;
  }

  const { token, loginData } = loginResult;

  // Step 2a — Discovery mode: show what each endpoint returns
  if (DISCOVER_MODE) {
    await discoverEndpoints(token);
    Script.complete();
    return;
  }

  // Step 2b — Fill the week
  const results  = await fillWeek(token, loginData);
  const okCount  = results.filter(r => r.ok).length;
  const total    = results.length;

  if (okCount === total) {
    const a = new Alert();
    a.title   = "✅ Timesheet filled";
    a.message = `Week of ${dateStr(thisMonday())}\n${WEEKLY_HOURS} h submitted (${okCount}/${total} days)\nEndpoint: ${results[0]?.path}`;
    a.addAction("OK");
    await a.present();
  } else if (okCount > 0) {
    const failed = results.filter(r => !r.ok).map(r => r.date).join(", ");
    const a = new Alert();
    a.title   = "⚠️ Partial submission";
    a.message = `${okCount}/${total} days written.\nFailed: ${failed}`;
    a.addAction("OK");
    await a.present();
  } else {
    // Nothing worked — switch to discovery mode automatically
    const a = new Alert();
    a.title   = "❌ Submission failed";
    a.message = "Could not write to any timesheet endpoint.\nSwitching to discovery mode…";
    a.addAction("OK");
    await a.present();
    await discoverEndpoints(token);
  }

  Script.complete();
}

await main();
