#!/usr/bin/env python3
"""
eTempo Timesheet Automation — Softmachine eTempo (Philip Morris)

Automatically fills the current week with 40 h (8 h/day, Mon–Fri).

Architecture
------------
The Philip Morris eTempo deployment has two separate ASP.NET apps on the same host:

  Web UI  →  https://philipmorris.softmachine.es/eTempo/      (Azure AD SSO)
  Mobile  →  https://philipmorris.softmachine.es/tempomobile/  (basic auth)

This tool tries the mobile API first (fast, no browser), then falls back
to Playwright browser automation against the web UI.

Usage
-----
  python3 etempo.py [options]

  --week   YYYY-MM-DD  Monday of the target week (default: current week)
  --hours  N           Total weekly hours to distribute (default: 40)
  --dry-run            Authenticate and navigate but do NOT save
  --headed             Show the browser window (useful for MFA / debugging)
  --discover           Print intercepted API calls to help debug the flow
  --api-only           Skip browser fallback — fail if REST API does not respond
  --browser-only       Skip REST API attempt — go straight to browser automation

Environment variables
  ETEMPO_URL   Web UI base URL  (default: https://philipmorris.softmachine.es/eTempo/)
  ETEMPO_MOB   Mobile API base  (default: https://philipmorris.softmachine.es/tempomobile/)
  ETEMPO_USER  Username         (default: William.hill@pmi.com)
  ETEMPO_PASS  Password

Example
  ETEMPO_PASS=50552441 python3 etempo.py --headed --week 2026-05-19
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import ssl
from datetime import date, timedelta
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────
ETEMPO_URL  = os.getenv("ETEMPO_URL",  "https://philipmorris.softmachine.es/eTempo/")
ETEMPO_MOB  = os.getenv("ETEMPO_MOB",  "https://philipmorris.softmachine.es/tempomobile/")
ETEMPO_USER = os.getenv("ETEMPO_USER", "William.hill@pmi.com")
ETEMPO_PASS = os.getenv("ETEMPO_PASS", "50552441")

# Disable SSL verification for self-signed certs (common in on-prem deployments)
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode    = ssl.CERT_NONE


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _log(tag: str, msg: str):
    print(f"[{tag}] {msg}")


def this_monday() -> date:
    today = date.today()
    return today - timedelta(days=today.weekday())


def _api_request(method: str, url: str, body: dict | None = None,
                 token: str | None = None, username: str = "", password: str = "") -> dict:
    """
    Make an HTTP request to the eTempo mobile API.
    Returns parsed JSON on success, raises urllib.error.HTTPError otherwise.
    """
    data = json.dumps(body).encode() if body else None
    headers = {
        "Accept":       "application/json",
        "Content-Type": "application/json",
        "User-Agent":   "TempoMobile/4.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif username and password:
        b64 = base64.b64encode(f"{username}:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {b64}"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, context=SSL_CTX, timeout=15) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else {}


# ─────────────────────────────────────────────────────────────────────────────
# Mobile REST API path
# ─────────────────────────────────────────────────────────────────────────────

# Login endpoint candidates — tried in order until one returns 2xx
_LOGIN_PATHS = [
    "api/v1/login",
    "api/login",
    "api/v1/account/login",
    "api/account/login",
    "api/v1/auth/login",
    "api/v1/FormsLogin",
    "api/FormsLogin",
    "api/v1/users/login",
    "api/v1/Users/Login",
    "api/v9/login",            # eTempo ModelServices API version 9
    "connect/token",           # IdentityServer ROPC
    "api/v1/token",
    "login",
]

# Additional base URLs to try when primary returns 500 (server startup crash)
# Ordered by likelihood based on server probing and APK analysis
_FALLBACK_MOB_BASES = [
    "https://philipmorris.softmachine.es/tempomobile/",   # confirmed path, currently 500
    "https://philipmorris.softmachine.es/TempoMobile/",   # case variant, same app
    "https://philipmorris.softmachine.es/eTempo/api/mobile/",
    "https://philipmorris.softmachine.es/eTempo/mobile/api/",
    "https://philipmorris.softmachine.es/eTempo/app/api/",
]

# Timesheet endpoint candidates
_TIMESHEET_PATHS = [
    "api/v1/timesheets",
    "api/v1/timesheet",
    "api/v1/workdays",
    "api/v1/jornadas",
    "api/v1/imputaciones",
    "api/timesheets",
    "api/timesheet",
    "api/workdays",
]


def mobile_login(mob_base: str, username: str, password: str) -> str | None:
    """
    POST credentials to the mobile API and return the auth token.
    Tries the primary base URL then falls back to alternate bases.
    Returns None if all endpoints fail.
    """
    # Build list of bases to try (primary first, then fallbacks)
    bases_to_try = [mob_base] + [b for b in _FALLBACK_MOB_BASES if b != mob_base]
    for base in bases_to_try:
        result = _try_mobile_login(base, username, password)
        if result is not None:
            return result
    return None


def _try_mobile_login(mob_base: str, username: str, password: str) -> str | None:
    _log("api", f"Trying mobile API login at {mob_base} …")
    b64 = base64.b64encode(f"{username}:{password}".encode()).decode()

    payloads = [
        {"username": username, "password": password},
        {"Username": username, "Password": password},
        {"user":     username, "pass":     password},
        {"login":    username, "password": password},
        # IdentityServer ROPC grant
        {"grant_type": "password", "username": username, "password": password,
         "scope": "openid offline_access", "client_id": "TempoMobile"},
    ]

    for path in _LOGIN_PATHS:
        url = mob_base.rstrip("/") + "/" + path
        for payload in payloads:
            for auth_header in [None, f"Basic {b64}"]:
                headers = {
                    "Accept":       "application/json",
                    "Content-Type": "application/json",
                    "User-Agent":   "TempoMobile/4.0",
                }
                if auth_header:
                    headers["Authorization"] = auth_header

                # IdentityServer uses form-encoded
                if payload.get("grant_type"):
                    headers["Content-Type"] = "application/x-www-form-urlencoded"
                    data = urllib.parse.urlencode(payload).encode()
                else:
                    data = json.dumps(payload).encode()

                req = urllib.request.Request(url, data=data, method="POST", headers=headers)
                try:
                    with urllib.request.urlopen(req, context=SSL_CTX, timeout=8) as resp:
                        if resp.status < 300:
                            raw = resp.read().decode()
                            result = json.loads(raw) if raw.strip() else {}
                            # Look for token in the response
                            token = (result.get("access_token") or result.get("token") or
                                     result.get("Token") or result.get("accessToken") or
                                     result.get("jwt") or result.get("id_token"))
                            if token:
                                _log("api", f"✓ Login success at {url}")
                                _log("api", f"  Token: {token[:40]}…")
                                return token
                            # Login succeeded but no token field found
                            _log("api", f"  Login OK at {url} but no token in response: {raw[:200]}")
                            return "session"   # indicates cookie-based session
                except urllib.error.HTTPError as e:
                    if e.code not in (301, 302, 303, 500):
                        _log("api", f"  {url} → HTTP {e.code}")
                except Exception:
                    pass

    _log("api", "Mobile API login failed on all endpoints.")
    return None


def mobile_get_timesheets(mob_base: str, token: str, week_monday: date) -> dict | None:
    """Fetch the timesheet data for a given week from the mobile API."""
    week_str = week_monday.strftime("%Y-%m-%d")
    for path in _TIMESHEET_PATHS:
        for url in [
            f"{mob_base.rstrip('/')}/{path}?week={week_str}",
            f"{mob_base.rstrip('/')}/{path}?startDate={week_str}",
            f"{mob_base.rstrip('/')}/{path}/{week_str}",
        ]:
            try:
                result = _api_request("GET", url, token=token)
                _log("api", f"  Timesheets fetched from {url}")
                return result
            except Exception:
                pass
    return None


def mobile_fill_week(mob_base: str, token: str, week_monday: date,
                     total_hours: int, dry_run: bool) -> bool:
    """
    PUT/POST timesheet hours for Mon–Fri via the mobile REST API.
    Returns True if at least one request succeeded.
    """
    daily = total_hours // 5
    extra = total_hours % 5
    days  = [week_monday + timedelta(days=i) for i in range(5)]
    hours = [daily + (extra if i == 0 else 0) for i in range(5)]

    _log("api", f"Filling week {week_monday}: {hours} hours across Mon–Fri")

    if dry_run:
        _log("api", "DRY RUN — skipping write.")
        return True

    filled = 0
    for day, h in zip(days, hours):
        day_str = day.strftime("%Y-%m-%d")
        payloads = [
            {"date": day_str, "hours": h},
            {"fecha": day_str, "horas": h},
            {"Date": day_str, "Hours": h},
            {"workDate": day_str, "hours": h, "taskId": None},
        ]

        for path in _TIMESHEET_PATHS:
            url = f"{mob_base.rstrip('/')}/{path}"
            for payload in payloads:
                for method in ("POST", "PUT"):
                    try:
                        _api_request(method, url, body=payload, token=token)
                        _log("api", f"  ✓ {day} ({day.strftime('%A')}) → {h} h")
                        filled += 1
                        break
                    except urllib.error.HTTPError as e:
                        if e.code == 405:   # method not allowed — try next method
                            continue
                        if e.code in (401, 403):
                            _log("api", f"  Auth error on {url}: {e.code}")
                            return False
                    except Exception:
                        pass
                else:
                    continue
                break

    return filled > 0


# ─────────────────────────────────────────────────────────────────────────────
# Browser automation (Playwright) — web UI fallback
# ─────────────────────────────────────────────────────────────────────────────

def _require_playwright():
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
        return sync_playwright, PWTimeout
    except ImportError:
        sys.exit(
            "Playwright is not installed.\n"
            "Install it with:  pip install playwright && python -m playwright install chromium"
        )


def browser_run(web_url: str, username: str, password: str,
                week_monday: date, total_hours: int,
                dry_run: bool, headed: bool, discover: bool):
    """Full browser automation: login → navigate → fill → save."""
    sync_playwright, PWTimeout = _require_playwright()

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=not (headed or discover),
            args=["--ignore-certificate-errors"],
        )
        context = browser.new_context(ignore_https_errors=True)
        page    = context.new_page()

        # Network interception for discovery mode
        api_log = []
        if discover:
            api_log = _setup_discovery(page)

        try:
            _log("browser", f"Navigating to {web_url}")
            page.goto(web_url, wait_until="domcontentloaded", timeout=30000)

            _browser_login(page, username, password, PWTimeout)
            _wait_for_app(page, PWTimeout)
            _navigate_to_timesheet(page)
            _fill_timesheet(page, week_monday, total_hours, dry_run)

        except RuntimeError as e:
            print(f"\n[ERROR] {e}")
            page.screenshot(path="etempo_error.png")
            _log("debug", "Screenshot saved → etempo_error.png")
            sys.exit(1)
        except Exception as e:
            print(f"\n[ERROR] Unexpected: {e}")
            page.screenshot(path="etempo_error.png")
            _log("debug", "Screenshot saved → etempo_error.png")
            raise
        finally:
            if discover and api_log:
                _print_discovery(api_log)
            browser.close()


def _setup_discovery(page) -> list:
    log = []

    def on_req(req):
        url = req.url
        if not any(x in url for x in ["google", "microsoft", "fonts", "analytics", "favicon"]):
            log.append({"type": "req", "method": req.method, "url": url,
                        "auth": req.headers.get("authorization", "")[:80]})

    def on_resp(resp):
        url = resp.url
        if not any(x in url for x in ["google", "microsoft", "fonts", "analytics", "favicon"]):
            for entry in log:
                if entry.get("url") == url and "status" not in entry:
                    entry["status"] = resp.status
                    try:
                        entry["body"] = resp.body()[:300].decode("utf-8", errors="replace")
                    except Exception:
                        pass

    page.on("request",  on_req)
    page.on("response", on_resp)
    return log


def _print_discovery(log: list):
    print("\n" + "=" * 70)
    print("INTERCEPTED API CALLS")
    print("=" * 70)
    for e in log:
        if e.get("type") == "req":
            print(f"\n{e['method']} {e['url']}")
            if e.get("auth"):
                print(f"  Auth: {e['auth']}")
            if "status" in e:
                print(f"  → {e['status']}")
            if e.get("body"):
                print(f"  Body: {e['body'][:200]}")
    Path("api_calls.json").write_text(json.dumps(log, indent=2))
    _log("discover", "Full log saved → api_calls.json")


def _browser_login(page, username: str, password: str, PWTimeout):
    """Handle Microsoft OAuth2 login flow in the browser."""
    _log("auth", f"Microsoft OAuth login as {username} …")

    try:
        page.wait_for_selector('input[type="email"]', timeout=15000)
    except PWTimeout:
        if "microsoftonline" not in page.url:
            _log("auth", "No MS login page — app might already be authenticated.")
            return
        raise RuntimeError("Timed out waiting for Microsoft email field.")

    page.fill('input[type="email"]', username)
    page.click('input[type="submit"]')
    time.sleep(2)

    _check_ms_error(page, "username")

    try:
        page.wait_for_selector('input[type="password"]', timeout=10000)
    except PWTimeout:
        raise RuntimeError(
            "Microsoft login stalled after username entry.\n"
            "Possible causes:\n"
            "  • Wrong username format — the portal expects JSnow@pmintl.net style\n"
            "  • MFA / conditional access (run with --headed to complete manually)\n"
            "  • Account does not exist in the PMI Azure AD tenant\n"
            "\nNote: The mobile app uses credentials stored in eTempo's own user DB\n"
            "(not Azure AD). Run --api-only against the mobile API instead."
        )

    page.fill('input[type="password"]', password)
    page.click('input[type="submit"]')
    time.sleep(4)

    _check_ms_error(page, "password")

    # "Stay signed in?" → No
    try:
        page.wait_for_selector('#idBtn_Back', timeout=5000)
        page.click('#idBtn_Back')
        time.sleep(2)
    except PWTimeout:
        pass

    _log("auth", "OAuth flow complete. URL: " + page.url)


def _check_ms_error(page, after: str):
    for sel in ['#idErrorText', '[role="alert"]', '.alert-error']:
        el = page.query_selector(sel)
        if el:
            txt = el.text_content().strip()
            if txt:
                raise RuntimeError(f"Microsoft login error after {after}: {txt}")


def _wait_for_app(page, PWTimeout):
    _log("browser", "Waiting for eTempo app to load …")
    try:
        page.wait_for_function(
            "() => !window.location.hostname.includes('microsoftonline.com') "
            "     && !window.location.hostname.includes('login.microsoft')",
            timeout=30000,
        )
    except PWTimeout:
        raise RuntimeError(
            "Still on Microsoft login after 30 s.\n"
            "Run with --headed to complete MFA manually, or use --api-only."
        )
    _log("browser", "App loaded. URL: " + page.url)


def _navigate_to_timesheet(page):
    _log("browser", "Looking for Timesheet navigation …")
    time.sleep(1)
    labels = [
        "Timesheet", "Time Sheet", "Timesheets",
        "Imputación", "Imputacion", "Hoja de tiempo",
        "Partes", "Parte de horas", "Marcajes",
        "WorkDay", "Jornada", "Hours",
    ]
    for label in labels:
        for sel in [
            f'a:has-text("{label}")',
            f'button:has-text("{label}")',
            f'[role="menuitem"]:has-text("{label}")',
            f'li:has-text("{label}")',
        ]:
            el = page.query_selector(sel)
            if el and not el.is_hidden():
                _log("browser", f"Clicking '{label}'")
                el.click()
                time.sleep(2)
                return
    _log("browser", "Could not auto-navigate to Timesheet. Run with --discover to inspect DOM.")


def _fill_timesheet(page, week_monday: date, total_hours: int, dry_run: bool):
    daily = total_hours // 5
    extra = total_hours % 5
    days  = [week_monday + timedelta(days=i) for i in range(5)]
    hours = [daily + (extra if i == 0 else 0) for i in range(5)]

    _log("browser", f"Week: {week_monday}  Hours: {hours}")

    # Dump DOM summary
    inputs = page.query_selector_all(
        'input[type="text"], input[type="number"], input:not([type])'
    )
    cells  = page.query_selector_all('td, th')
    _log("dom", f"Editable inputs: {len(inputs)}  Table cells: {len(cells)}")
    for inp in inputs[:10]:
        _log("dom", f"  id={inp.get_attribute('id')!r} val={inp.input_value()!r}")

    if dry_run:
        _log("browser", "DRY RUN — skipping input.")
        return

    filled = _fill_by_date_attr(page, days, hours)
    if not filled:
        filled = _fill_by_column_index(page, days, hours)
    if not filled:
        _log("browser", "WARNING: could not locate input cells. Try --headed --discover.")
        return

    _save(page)


def _fill_by_date_attr(page, days: list, hours: list) -> bool:
    filled = 0
    for day, h in zip(days, hours):
        ds = day.strftime("%Y-%m-%d")
        ds2 = day.strftime("%d/%m/%Y")
        for sel in [
            f'input[data-date="{ds}"]', f'input[data-date="{ds2}"]',
            f'input[id*="{ds}"]',       f'input[name*="{ds}"]',
            f'td[data-date="{ds}"] input', f'td[data-date="{ds2}"] input',
        ]:
            for inp in page.query_selector_all(sel):
                if not inp.is_hidden():
                    inp.triple_click()
                    inp.fill(str(h))
                    filled += 1
                    _log("browser", f"  {day} ({day.strftime('%A')}) → {h} h")
                    break
    return filled > 0


def _fill_by_column_index(page, days: list, hours: list) -> bool:
    inputs = [
        inp for inp in page.query_selector_all('input[type="text"], input[type="number"]')
        if not inp.is_hidden()
    ]
    _log("browser", f"Fallback: {len(inputs)} visible inputs in DOM order")
    if len(inputs) < 5:
        return False
    for i, (day, h) in enumerate(zip(days, hours)):
        if i < len(inputs):
            inputs[i].triple_click()
            inputs[i].fill(str(h))
            _log("browser", f"  input[{i}] → {h} h  ({day})")
    return True


def _save(page):
    for label in ["Save", "Guardar", "Submit", "Enviar", "Confirm", "Aceptar", "Apply", "OK"]:
        for sel in [f'button:has-text("{label}")', f'input[value="{label}"]',
                    f'a:has-text("{label}")',       f'[role="button"]:has-text("{label}")']:
            el = page.query_selector(sel)
            if el and not el.is_hidden():
                _log("browser", f"Clicking '{label}' …")
                el.click()
                time.sleep(2)
                _log("browser", "Saved.")
                return
    _log("browser", "WARNING: no Save button found. Please save manually.")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="eTempo timesheet automation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--week",         default=None,
                        help="Monday of target week (YYYY-MM-DD). Default: this week.")
    parser.add_argument("--hours",        type=int, default=40,
                        help="Total weekly hours (default: 40)")
    parser.add_argument("--dry-run",      action="store_true",
                        help="Navigate and inspect without saving")
    parser.add_argument("--headed",       action="store_true",
                        help="Show browser window (required for MFA)")
    parser.add_argument("--discover",     action="store_true",
                        help="Print all intercepted API calls")
    parser.add_argument("--api-only",     action="store_true",
                        help="Use REST API only, no browser")
    parser.add_argument("--browser-only", action="store_true",
                        help="Use browser only, skip REST API attempt")
    parser.add_argument("--url",     default=ETEMPO_URL,  help="Web UI base URL")
    parser.add_argument("--mob-url", default=ETEMPO_MOB,  help="Mobile API base URL")
    parser.add_argument("--user",    default=ETEMPO_USER, help="Username")
    parser.add_argument("--password",default=ETEMPO_PASS, help="Password")
    args = parser.parse_args()

    if args.week:
        target_monday = date.fromisoformat(args.week)
        if target_monday.weekday() != 0:
            target_monday -= timedelta(days=target_monday.weekday())
            print(f"Adjusted to Monday: {target_monday}")
    else:
        target_monday = this_monday()

    print("=" * 65)
    print("eTempo Timesheet Automation")
    print(f"  Week     : {target_monday}  ({args.hours} h total)")
    print(f"  User     : {args.user}")
    print(f"  Web URL  : {args.url}")
    print(f"  Mobile   : {args.mob_url}")
    print(f"  Mode     : {'DRY RUN' if args.dry_run else 'LIVE'}"
          + ("  +HEADED" if args.headed else "")
          + ("  +DISCOVER" if args.discover else ""))
    print("=" * 65)

    # ── Try mobile REST API first ─────────────────────────────────────────────
    if not args.browser_only:
        token = mobile_login(args.mob_url, args.user, args.password)
        if token:
            ts_data = mobile_get_timesheets(args.mob_url, token, target_monday)
            if ts_data is not None:
                _log("api", f"Current timesheet data: {json.dumps(ts_data)[:300]}")
            ok = mobile_fill_week(args.mob_url, token, target_monday,
                                  args.hours, args.dry_run)
            if ok:
                print("\nDone (via REST API).")
                return
            _log("api", "REST fill did not complete — falling back to browser.")
        else:
            _log("api", "Mobile API unavailable (see above). Falling back to browser.")

    if args.api_only:
        print("\n[ERROR] REST API failed and --api-only was set. Exiting.")
        sys.exit(1)

    # ── Browser automation fallback ───────────────────────────────────────────
    _log("browser", "Starting browser automation …")
    browser_run(
        web_url      = args.url,
        username     = args.user,
        password     = args.password,
        week_monday  = target_monday,
        total_hours  = args.hours,
        dry_run      = args.dry_run,
        headed       = args.headed,
        discover     = args.discover,
    )
    print("\nDone (via browser).")


if __name__ == "__main__":
    main()
