"""ODBCQueryApp FastAPI backend entrypoint."""
import json
import os
import sys
import threading
import time
import traceback

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import keystore, logging_utils, storage, update
from app.version import APP_VERSION
from app.api import (
    ai,
    analytics_store,
    charts,
    color_lot,
    connection_templates,
    connections,
    feedback,
    history,
    queries,
    report,
    saved,
    schema,
    scripts,
    sql_queries,
    uploads,
)

app = FastAPI(title="ODBCQueryApp")
logging_utils.setup_logging()

# The server binds to 127.0.0.1, but that alone does not stop a browser on
# this machine from being tricked into talking to it: with DNS rebinding an
# evil page resolves its own hostname to 127.0.0.1 and the browser sends the
# request with the attacker's Host header. Restrict the accepted hosts, then
# require the per-launch token (set by launcher.py; absent in dev mode, where
# no token check is applied) on every API call — so other local pages and
# processes cannot drive the API, which includes arbitrary Python execution.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

_APP_TOKEN = os.environ.get("ODBC_APP_TOKEN", "")
# The launcher's liveness probe only reads the version banner; keep it open.
_TOKEN_EXEMPT_PATHS = {"/api/health"}


@app.middleware("http")
async def require_app_token(request: Request, call_next):
    """Reject API requests that do not carry the per-launch app token.

    The token is accepted as the ``X-App-Token`` header (all frontend calls)
    or a ``?token=`` query parameter (``navigator.sendBeacon`` cannot set
    custom headers). When no token is configured (dev server) nothing is
    enforced.
    """
    path = request.url.path
    if _APP_TOKEN and path.startswith("/api/") and path not in _TOKEN_EXEMPT_PATHS:
        supplied = request.headers.get("x-app-token") or request.query_params.get("token") or ""
        if supplied != _APP_TOKEN:
            return JSONResponse(
                status_code=403,
                content={"detail": "Invalid or missing app token"},
            )
    return await call_next(request)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Record every HTTP request (method, path, status, duration) into the log."""
    global _INFLIGHT_REQUESTS
    _INFLIGHT_REQUESTS += 1
    start = time.perf_counter()
    try:
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        status = response.status_code
        if status >= 500:
            logging_utils.log_error(
                "request",
                f"{request.method} {request.url.path}",
                details=f"status={status}, duration={duration_ms}ms",
                method=request.method,
                path=request.url.path,
                status=status,
                duration_ms=duration_ms,
            )
        elif status >= 400:
            logging_utils.log_warning(
                "request",
                f"{request.method} {request.url.path}",
                details=f"status={status}, duration={duration_ms}ms",
                method=request.method,
                path=request.url.path,
                status=status,
                duration_ms=duration_ms,
            )
        else:
            logging_utils.log_info(
                "request",
                f"{request.method} {request.url.path}",
                details=f"status={status}, duration={duration_ms}ms",
                method=request.method,
                path=request.url.path,
                status=status,
                duration_ms=duration_ms,
            )
        return response
    except Exception:
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        logging_utils.log_error(
            "request",
            f"{request.method} {request.url.path}",
            details=traceback.format_exc(),
            method=request.method,
            path=request.url.path,
            status=500,
            duration_ms=duration_ms,
        )
        raise
    finally:
        _INFLIGHT_REQUESTS -= 1


@app.get("/api/health")
def health():
    return {"status": "ok", "version": APP_VERSION}


def _bundled_data_file(name: str) -> str:
    """Absolute path of a data file shipped inside ``app/data``.

    Works both in development (backend/app/data) and inside the PyInstaller
    bundle (<_MEIPASS>/app/data), mirroring the spec's datas layout.
    """
    if getattr(sys, "_MEIPASS", None):  # PyInstaller bundle root
        return os.path.join(sys._MEIPASS, "app", "data", name)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", name)


@app.get("/api/version-history")
def version_history():
    """Release history bundled with this build (rendered in Settings → About).

    release.py records an entry for every version it ships, so installed
    clients can review which versions existed, when, and what changed.
    """
    try:
        with open(_bundled_data_file("version_history.json"), encoding="utf-8") as fh:
            history = json.load(fh)
    except (OSError, ValueError):
        history = []
    return {"current_version": APP_VERSION, "history": history}


def _request_shutdown() -> bool:
    """Signal the embedded uvicorn server to stop gracefully.

    An embedded runner may store the live ``uvicorn.Server`` on ``app.state``
    so the in-app "Shut down server" button can stop the backend from the
    browser instead of the console. Returns False when no embedded server is
    set (e.g. running under the dev reloader).
    """
    server = getattr(app.state, "uvicorn_server", None)
    if server is None:
        return False

    def _stop() -> None:
        # Give the shutdown response a moment to flush before the loop exits.
        time.sleep(0.5)
        server.should_exit = True

    threading.Thread(target=_stop, daemon=True).start()
    return True


@app.post("/api/shutdown")
def shutdown():
    """Stop the embedded backend server (used by the in-app Quit button)."""
    app.state.shutdown_reason = "quit"
    stopped = _request_shutdown()
    return {"ok": True, "stopped": stopped}


def _stop_server(reason: str) -> None:
    """Stop the server and remember why, so the launcher can react.

    ``reason`` is stored on ``app.state.shutdown_reason`` and read back by
    launcher.py after ``server.run()`` returns: "quit" means the user closed
    every tab (the launcher should exit for good), while "watchdog" means the
    browser went silent without saying goodbye (laptop sleep, frozen tab) and
    the launcher should restart on the same port and wait for the still-open
    page to reconnect — no reload needed.
    """
    app.state.shutdown_reason = reason
    if not _request_shutdown():
        os._exit(0)  # no embedded server handle (dev reloader): hard exit


def inflight_count() -> int:
    """Number of HTTP requests currently being served.

    Used by :mod:`app.update` to avoid interrupting a running query when it
    restarts the app for an update.
    """
    return _INFLIGHT_REQUESTS


# ---- Connection keep-alive / auto-shutdown bookkeeping ----
# The frontend pings /api/heartbeat (tagged with a stable per-tab id that
# survives reloads) every 15s while a tab is open, and fires a /api/tab-left
# beacon when a tab really closes. The watchdog distinguishes two silences:
#
#   * every tab said goodbye  -> user closed the app      -> reason "quit"
#   * tabs fell silent with no goodbye (sleep, frozen or
#     killed tab, browser crash)                           -> reason "watchdog"
#
# 90s of quiet tolerates Chrome background-tab throttling (hidden tabs may be
# throttled to ~1 timer per minute). The goodbye grace is long because
# `pagehide` fires on ANY navigation away — typing another address, clicking a
# link, going Back — not just on tab close. Users who wander off and return
# within the window must find the app alive: their first heartbeat on return
# cancels the pending quit. Only after the window expires is it really a quit.
_HEARTBEAT_STATE: dict = {
    "tabs": {},                # tab id -> last heartbeat time
    "last_seen": 0.0,          # last heartbeat time from any tab
    "armed": False,            # False until the first heartbeat arrives
    "all_left_since": None,    # when the last open tab sent its goodbye beacon
    "reattach_deadline": None, # after a watchdog restart: give up after this
}
_HEARTBEAT_QUIET_SECONDS = 90.0
_TAB_LEFT_GRACE_SECONDS = 120.0
_REATTACH_GRACE_SECONDS = 150.0
# Requests currently being served. The watchdog never shuts down while this
# is > 0, so a long-running request (big upload, export, query) cannot be
# killed mid-flight even if its tab stops heartbeating while waiting.
_INFLIGHT_REQUESTS = 0

_LEGACY_TAB_ID = "__legacy_tab__"


async def _tab_id_from_request(request: Request) -> str:
    """Best-effort parse of the {"tab": "..."} body.

    Heartbeats come from axios (JSON) and goodbye beacons from
    ``navigator.sendBeacon`` (Blob); both may be empty or malformed, so
    parsing is deliberately forgiving — a missing id falls back to a shared
    legacy key instead of failing the request.
    """
    try:
        payload = await request.json()
    except Exception:
        return _LEGACY_TAB_ID
    if isinstance(payload, dict):
        tab = payload.get("tab")
        if isinstance(tab, str) and tab:
            return tab[:64]
    return _LEGACY_TAB_ID


@app.post("/api/heartbeat")
async def heartbeat(request: Request):
    """Keep-alive ping from one frontend tab."""
    now = time.time()
    state = _HEARTBEAT_STATE
    tab = await _tab_id_from_request(request)
    state["tabs"][tab] = now
    state["last_seen"] = now
    state["armed"] = True
    # A beat arriving after a goodbye (refresh) or after a launcher restart
    # (sleep/wake) cancels both pending shutdown timers.
    state["all_left_since"] = None
    state["reattach_deadline"] = None
    return {"ok": True}


@app.post("/api/tab-left")
async def tab_left(request: Request):
    """Goodbye beacon from a tab that is closing for good."""
    state = _HEARTBEAT_STATE
    tab = await _tab_id_from_request(request)
    state["tabs"].pop(tab, None)
    if not state["tabs"]:
        state["all_left_since"] = time.time()
    return {"ok": True}


def arm_reattach_grace(seconds: float = _REATTACH_GRACE_SECONDS) -> None:
    """Called by the launcher before restarting after a watchdog stop.

    Clears stale tab records and gives still-open browser pages a grace
    window to reconnect (the page polls /api/health every few seconds while
    offline); if no heartbeat arrives before the deadline the process exits
    for real so it never lingers orphaned.
    """
    state = _HEARTBEAT_STATE
    state["tabs"] = {}
    state["armed"] = False
    state["all_left_since"] = None
    state["reattach_deadline"] = time.time() + seconds


def _browser_watchdog() -> None:
    """Apply the goodbye / silence rules described above, every 10 seconds."""
    while True:
        time.sleep(10)
        if _INFLIGHT_REQUESTS > 0:
            continue  # request in flight — retry on the next tick
        if getattr(app.state, "uvicorn_server", None) is None:
            # Dev entrypoint (uvicorn reload): there is no launcher to restart
            # us, so shutting down on browser silence would leave an orphaned
            # reloader holding the port and refuse every reconnect. The
            # reloader owns the lifecycle here — never self-kill.
            continue
        state = _HEARTBEAT_STATE
        now = time.time()
        deadline = state["reattach_deadline"]
        if deadline is not None and now > deadline:
            logging_utils.log_info(
                "server.watchdog",
                "no tab reconnected after restart — exiting",
            )
            _stop_server("quit")
            return
        if not state["armed"]:
            continue  # nothing has ever connected: never self-kill
        tabs = state["tabs"]
        for silent in [t for t, seen in tabs.items() if now - seen > _HEARTBEAT_QUIET_SECONDS]:
            del tabs[silent]
        if tabs:
            state["all_left_since"] = None
            continue
        goodbye = state["all_left_since"]
        if goodbye is not None:
            if now - goodbye > _TAB_LEFT_GRACE_SECONDS:
                logging_utils.log_info(
                    "server.watchdog",
                    "every browser tab said goodbye — stopping server",
                )
                _stop_server("quit")
                return
            continue
        if now - state["last_seen"] > _HEARTBEAT_QUIET_SECONDS:
            logging_utils.log_info(
                "server.watchdog",
                "browser went silent without goodbye — stopping for auto-reconnect",
            )
            _stop_server("watchdog")
            return


threading.Thread(target=_browser_watchdog, daemon=True, name="browser-watchdog").start()
update.start_background_checker()
# Pay the deferred keyring import here instead of on the first /api/connections
# request: the frontend lists connections on mount, so without this the ~0.6 s
# would just move from startup to the first page load.
threading.Thread(target=keystore.warm, daemon=True, name="keyring-warmup").start()


def get_stored_connection(connection_id: str) -> dict:
    """Read a stored connection by id; raise HTTP 404 when it is missing.

    Reused by the schema, queries, sql-queries, ai and connection-template
    routers. Passwords come from the OS keyring via the central loader, so the
    returned dict is ready for :func:`app.db.odbc.open_connection`.
    """
    from app.api.connections import load_stored_connections  # deferred: avoid import cycle

    for conn in load_stored_connections():
        if conn.get("id") == connection_id:
            return conn
    raise HTTPException(status_code=404, detail=f"Connection '{connection_id}' not found")


app.include_router(connections.router, prefix="/api", tags=["connections"])
app.include_router(schema.router, prefix="/api", tags=["schema"])
app.include_router(queries.router, prefix="/api", tags=["queries"])
app.include_router(saved.router, prefix="/api", tags=["saved-queries"])
app.include_router(sql_queries.router, prefix="/api", tags=["sql-queries"])
app.include_router(charts.router, prefix="/api", tags=["charts"])
app.include_router(history.router, prefix="/api", tags=["history"])
app.include_router(ai.router, prefix="/api", tags=["ai"])
app.include_router(report.router, prefix="/api", tags=["report"])
app.include_router(analytics_store.router, prefix="/api", tags=["analytics"])
app.include_router(scripts.router, prefix="/api", tags=["scripts"])
app.include_router(connection_templates.router, prefix="/api", tags=["connection-templates"])
app.include_router(color_lot.router, prefix="/api", tags=["color-lot"])
app.include_router(uploads.router, prefix="/api", tags=["uploads"])
app.include_router(update.router, prefix="/api", tags=["update"])
app.include_router(feedback.router, prefix="/api", tags=["feedback"])


def frontend_dist_dir() -> str | None:
    """Return the directory containing the built frontend `index.html`, or None.

    It lives at ``<project_root>/frontend/dist`` (present only after
    ``npm run build``), where project_root is the parent of the backend dir.

    Returns None in dev mode (the Vite dev server + proxy serves the frontend).
    """
    if getattr(sys, "_MEIPASS", None):  # PyInstaller bundle root
        project_root = sys._MEIPASS
    else:
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    dev_dist = os.path.join(project_root, "frontend", "dist")
    if os.path.isdir(dev_dist):
        return dev_dist
    return None


_DIST_DIR = frontend_dist_dir()
# Always revalidate static responses: index.html must never come from a stale
# browser cache after the exe is rebuilt (asset hashes change each build).
_NO_CACHE_HEADERS = {"Cache-Control": "no-cache, must-revalidate"}
if _DIST_DIR is not None:
    # Static frontend serving. Registered after all API routers so /api always
    # wins. The catch-all SPA route runs before the "/" mount: a "/" mount alone
    # would answer 404 for SPA paths (StaticFiles gets every request), so the
    # fallback serves real dist files as-is and index.html for everything else,
    # making deep links / refreshes work. Unknown /api paths keep returning 404.
    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        file_path = os.path.join(_DIST_DIR, full_path)
        if full_path and os.path.isfile(file_path):
            return FileResponse(file_path, headers=_NO_CACHE_HEADERS)
        # no-cache: the browser must always revalidate index.html so a rebuilt
        # exe (new hashed asset names) is picked up on the next launch instead
        # of a cached page from a previous build.
        return FileResponse(os.path.join(_DIST_DIR, "index.html"), headers=_NO_CACHE_HEADERS)

    app.mount("/", StaticFiles(directory=_DIST_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
