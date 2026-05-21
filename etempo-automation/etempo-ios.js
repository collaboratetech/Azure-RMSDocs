// eTempo Timesheet Automation — iOS Scriptable Script
// ─────────────────────────────────────────────────────
// Install: https://scriptable.app  (free on App Store)
// Usage: tap the script, or add a widget, or run via Shortcuts on a schedule.
//
// What it does: fills the current week (Mon–Fri) with 8 h/day (40 h total)
// and saves the timesheet via the eTempo mobile API.

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER   = "https://philipmorris.softmachine.es:440";
const MOB_BASE = SERVER;                        // mobile API root (port 440)
const USERNAME = "William.hill@pmi.com";
const PASSWORD = "50552441";
const WEEKLY_HOURS = 40;

// ── Login endpoint candidates (tried in order) ────────────────────────────────
const LOGIN_PATHS = [
  "/api/v1/login",
  "/api/login",
  "/api/v1/account/login",
  "/api/account/login",
  "/api/v1/auth/login",
  "/api/v1/FormsLogin",
  "/api/FormsLogin",
  "/api/v1/users/login",
  "/api/v9/login",
  "/connect/token",
  "/login",
];

// Timesheet write endpoint candidates
const TIMESHEET_PATHS = [
  "/api/v1/timesheets",
  "/api/v1/timesheet",
  "/api/v1/workdays",
  "/api/v1/jornadas",
  "/api/v1/imputaciones",
  "/api/timesheets",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function thisMonday() {
  const d = new Date();
  const day = d.getDay();                          // 0=Sun, 1=Mon …
  const diff = day === 0 ? -6 : 1 - day;          // go back to Monday
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

function basicAuth(user, pass) {
  return "Basic " + btoa(`${user}:${pass}`);
}

async function apiPost(url, body, token) {
  const isForm = body && body.grant_type;
  const req = new Request(url);
  req.method = "POST";
  req.headers = {
    "Accept":       "application/json",
    "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json",
    "User-Agent":   "TempoMobile/4.0",
    "Authorization": token ? `Bearer ${token}` : basicAuth(USERNAME, PASSWORD),
  };
  if (isForm) {
    req.body = Object.entries(body).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  } else {
    req.body = JSON.stringify(body);
  }
  try {
    const resp = await req.loadJSON();
    return { ok: true, data: resp };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function apiPut(url, body, token) {
  const req = new Request(url);
  req.method = "PUT";
  req.headers = {
    "Accept":       "application/json",
    "Content-Type": "application/json",
    "User-Agent":   "TempoMobile/4.0",
    "Authorization": token ? `Bearer ${token}` : basicAuth(USERNAME, PASSWORD),
  };
  req.body = JSON.stringify(body);
  try {
    const resp = await req.loadJSON();
    return { ok: true, data: resp };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function login() {
  const payloads = [
    { username: USERNAME, password: PASSWORD },
    { Username: USERNAME, Password: PASSWORD },
    { user:     USERNAME, pass:     PASSWORD },
    { login:    USERNAME, password: PASSWORD },
    // IdentityServer ROPC
    { grant_type: "password", username: USERNAME, password: PASSWORD,
      scope: "openid offline_access", client_id: "TempoMobile" },
  ];

  for (const path of LOGIN_PATHS) {
    const url = MOB_BASE + path;
    for (const payload of payloads) {
      const result = await apiPost(url, payload, null);
      if (result.ok) {
        const d = result.data;
        const token = d.access_token || d.token || d.Token ||
                      d.accessToken  || d.jwt   || d.id_token;
        if (token) {
          console.log("✓ Login OK at " + path);
          return token;
        }
        // Might be a session-cookie login with no token
        console.log("Login OK (no token) at " + path);
        return "session";
      }
    }
  }
  return null;
}

// ── Fill timesheet ────────────────────────────────────────────────────────────

async function fillWeek(token) {
  const daily = Math.floor(WEEKLY_HOURS / 5);
  const extra = WEEKLY_HOURS % 5;
  const monday = thisMonday();
  const results = [];

  for (let i = 0; i < 5; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const hours = daily + (i === 0 ? extra : 0);
    const ds    = dateStr(day);

    const payloads = [
      { date: ds,      hours },
      { fecha: ds,     horas: hours },
      { Date: ds,      Hours: hours },
      { workDate: ds,  hours, taskId: null },
    ];

    let written = false;
    outer:
    for (const tsPath of TIMESHEET_PATHS) {
      const url = MOB_BASE + tsPath;
      for (const payload of payloads) {
        // Try POST then PUT
        for (const fn of [apiPost, apiPut]) {
          const r = await fn(url, payload, token);
          if (r.ok) {
            console.log(`✓ ${ds} → ${hours} h`);
            results.push({ date: ds, hours, ok: true });
            written = true;
            break outer;
          }
        }
      }
    }
    if (!written) {
      console.log(`✗ Could not write ${ds}`);
      results.push({ date: ds, hours, ok: false });
    }
  }
  return results;
}

// ── Notification helper ───────────────────────────────────────────────────────

function notify(title, body) {
  const n = new Notification();
  n.title = title;
  n.body  = body;
  n.schedule();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("eTempo Timesheet Automation starting …");
  console.log("Week: " + dateStr(thisMonday()));

  // Step 1 — Login
  const token = await login();
  if (!token) {
    const msg = "Login failed. The /tempomobile API may be down. Check the server.";
    console.error(msg);
    notify("eTempo ✗", msg);
    Script.complete();
    return;
  }

  // Step 2 — Fill week
  const results = await fillWeek(token);
  const ok    = results.filter(r => r.ok).length;
  const total = results.length;

  if (ok === total) {
    const msg = `Week of ${dateStr(thisMonday())} filled: ${WEEKLY_HOURS} h ✓`;
    console.log(msg);
    notify("eTempo ✓", msg);
  } else {
    const msg = `Partial: ${ok}/${total} days written. Check console for details.`;
    console.warn(msg);
    notify("eTempo ⚠️", msg);
  }

  Script.complete();
}

await main();
