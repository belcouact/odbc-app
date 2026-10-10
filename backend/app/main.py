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
    so the in-app "Shut down server" button can stop the backend from inside
    the app instead of the console. Returns False when no embedded server is
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
    launcher.py after ``server.run()`` returns: "quit" means the user quit from
    inside the app (its native window then closes), while "update" means a
    self-update is staged and the launcher must swap the install and relaunch.
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


# Requests currently being served. app.update waits for this to drop to 0
# before restarting the app, so a long-running request (big upload, export,
# query) is never cut off mid-flight.
_INFLIGHT_REQUESTS = 0

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


def _bundle_roots() -> list[str]:
    """Candidate bundle roots that may hold ``frontend/dist``, best first.

    A frozen (PyInstaller onedir) build ships the frontend inside
    ``<exe_dir>/_internal/frontend/dist``.  A process relaunched by the update
    helper can inherit a *stale* bundle root that points at the
    ``<install>.<version>.old`` folder the helper renamed aside — trusting
    ``sys._MEIPASS`` alone then served (and 500-ed on) files that no longer
    exist.  So the exe's own folder is trusted ahead of it, and every candidate
    is validated by the caller.
    """
    roots: list[str] = []
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        roots += [os.path.join(exe_dir, "_internal"), exe_dir]
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(meipass)
    if not roots:
        roots.append(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        )
    unique: list[str] = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return unique


def frontend_dist_dir() -> str | None:
    """Return the directory containing the built frontend ``index.html``, or None.

    It lives at ``<bundle_root>/frontend/dist`` and is present only after
    ``npm run build`` (dev) or inside the PyInstaller bundle (packaged).  The
    first candidate that actually contains ``index.html`` wins, so a stale
    bundle root left over by an update cannot make the app serve a missing
    file.  Returns None when no build is found (the Vite dev server serves it).
    """
    for root in _bundle_roots():
        dist = os.path.join(root, "frontend", "dist")
        if os.path.isfile(os.path.join(dist, "index.html")):
            return dist
    return None


_DIST_DIR = frontend_dist_dir()
# Always revalidate static responses: index.html must never come from a stale
# browser cache after the exe is rebuilt (asset hashes change each build).
_NO_CACHE_HEADERS = {"Cache-Control": "no-cache, must-revalidate"}


def _live_dist_dir() -> str | None:
    """Dist dir re-resolved per request so a vanished bundle root self-heals."""
    if _DIST_DIR and os.path.isfile(os.path.join(_DIST_DIR, "index.html")):
        return _DIST_DIR
    return frontend_dist_dir()


if _DIST_DIR is not None:
    # Static frontend serving. Registered after all API routers so /api always
    # wins. The catch-all SPA route runs before the "/" mount: a "/" mount alone
    # would answer 404 for SPA paths (StaticFiles gets every request), so the
    # fallback serves real dist files as-is and index.html for everything else,
    # making deep links / refreshes work. Unknown /api paths keep returning 404.
    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str) -> FileResponse:
        dist = _live_dist_dir()
        if dist is None or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        file_path = os.path.join(dist, full_path)
        if full_path and os.path.isfile(file_path):
            return FileResponse(file_path, headers=_NO_CACHE_HEADERS)
        # no-cache: the browser must always revalidate index.html so a rebuilt
        # exe (new hashed asset names) is picked up on the next launch instead
        # of a cached page from a previous build. A missing index.html (e.g. a
        # half-applied update) surfaces as a clean 404, never a 500 traceback.
        index_path = os.path.join(dist, "index.html")
        if not os.path.isfile(index_path):
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(index_path, headers=_NO_CACHE_HEADERS)

    app.mount("/", StaticFiles(directory=_DIST_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
