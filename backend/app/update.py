"""Application self-update: version manifest check + download + staged swap.

How it works
------------
A small JSON *manifest* (``latest.json``) is published next to the new
executable — on a company share drive today, on Supabase Storage later.  The
app checks that manifest on startup and every 6 hours; when a newer version
is listed it shows an in-app banner (or a blocking "update required" dialog
when the running version falls below ``min_version``).  Pressing *Update now*
downloads the new package — a zip of the app folder — into the local data
directory, extracts it to a staging folder, waits until no queries are in
flight, asks the server to shut down with reason ``"update"`` and the launcher
swaps the install folders and restarts the new build on the same port, which
opens a fresh app window.

Manifest format (``latest.json``)::

    {
      "version": "1.2.0",              # required — latest released version
      "min_version": "1.0.0",          # optional — below this an update is forced
      "notes": "What's new…",          # optional — shown in the update banner
      "package": "ODBCQueryApp.zip",   # required for auto-update: zip of the
                                       # app folder next to the manifest, an
                                       # absolute/UNC path, or a full http(s)
                                       # download URL
      "sha256": "abcd…"                # optional — integrity check of the zip
    }

Where the manifest is looked for (first hit wins):

1. ``ODBC_UPDATE_MANIFEST`` environment variable (path or URL).
2. First line of ``%APPDATA%\\ODBCQueryApp\\update_source.txt`` (set via the
   Settings → Updates card).
3. ``latest.json`` sitting next to the packaged ``ODBCQueryApp.exe``
   (only when running the frozen exe — handy for pure share-drive deploys
   with zero configuration).
4. :data:`DEFAULT_MANIFEST_URL` — the published Supabase manifest. This is the
   fallback for a plain copy of the exe, so a new user needs no configuration
   at all.

Releases are produced by ``release.py``, which builds the exe and writes the
matching ``latest.json``.
"""
import hashlib
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.request
import zipfile

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from app import logging_utils
from app.config import APP_DATA_DIR
from app.version import APP_VERSION

CHECK_INTERVAL_SECONDS = 3600
FIRST_CHECK_DELAY_SECONDS = 8

# Published manifest — used when neither the environment variable, the settings
# file nor a latest.json next to the exe says otherwise.  Keeping a built-in
# default means a colleague only has to run ODBCQueryApp.exe: the update check
# works with no configuration at all.
DEFAULT_MANIFEST_URL = (
    "https://llbxyhphblhplfpgyjht.supabase.co/storage/v1/object/public/"
    "odbc-app/latest.json"
)

_BUSY_STATES = {"checking", "downloading", "verifying", "waiting_idle", "restarting"}

_LOCK = threading.Lock()
_started_checker = False
_started_checker_lock = threading.Lock()

STATE = {
    "supported": bool(getattr(sys, "frozen", False)),
    "source": None,
    "current_version": APP_VERSION,
    "latest_version": None,
    "min_version": None,
    "available": False,
    "forced": False,
    "notes": "",
    "state": "idle",
    "message": "",
    "error": "",
    "checked_at": None,
    "download_percent": None,
    "download_rate": None,
    # private (filtered out of the public snapshot)
    "_package_src": None,
    "_sha256": None,
}


def _public_state() -> dict:
    with _LOCK:
        return {k: v for k, v in STATE.items() if not k.startswith("_")}


def _set(**changes) -> None:
    with _LOCK:
        STATE.update(changes)


def _busy() -> bool:
    with _LOCK:
        return STATE["state"] in _BUSY_STATES


# ---------------------------------------------------------------------------
# paths & source resolution
# ---------------------------------------------------------------------------

def _source_file() -> str:
    return os.path.join(APP_DATA_DIR, "update_source.txt")


def _pending_file() -> str:
    return os.path.join(APP_DATA_DIR, "pending_update.json")


def _staging_dir() -> str:
    return os.path.join(APP_DATA_DIR, "update_staging")


def _configured_source() -> str | None:
    """Resolve the manifest location: env var → settings file → beside exe → default."""
    env = (os.environ.get("ODBC_UPDATE_MANIFEST") or "").strip()
    if env:
        return env
    try:
        with open(_source_file(), "r", encoding="utf-8") as fh:
            first = fh.readline().strip()
        if first:
            return first
    except OSError:
        pass
    if getattr(sys, "frozen", False):
        beside = os.path.join(os.path.dirname(sys.executable), "latest.json")
        if os.path.isfile(beside):
            return beside
    return DEFAULT_MANIFEST_URL


def manifest_source() -> str | None:
    """Where the version manifest is read from (path or URL).

    Exposed so other bucket-backed data (the script-template catalog) resolves
    its location the same way, instead of hard-coding the Supabase project.
    """
    return _configured_source()


# ---------------------------------------------------------------------------
# manifest loading & version comparison
# ---------------------------------------------------------------------------

_IS_URL_RE = re.compile(r"^https?://", re.IGNORECASE)
_IS_ABS_PATH_RE = re.compile(r"^[a-zA-Z]:[\\/]|^\\\\")


# ---------------------------------------------------------------------------
# resilient URL fetching
# ---------------------------------------------------------------------------

# On some corporate networks most direct TLS handshakes to the update host are
# reset (WinError 10054 during the handshake), so a single-shot urlopen fails
# the majority of the time. Fetches therefore retry, then fall back to the
# proxy servers named in the system's auto-config (WPAD/PAC) file. Python
# cannot evaluate a PAC, but harvesting its "PROXY host:port" candidates and
# trying them explicitly turns a flaky direct route into a reliable one.

_PROXY_ROUTES: list[str | None] | None = None
_PROXY_ROUTES_LOCK = threading.Lock()


def _pac_proxy_candidates() -> list[str]:
    """Proxy URLs harvested from the Windows auto-config (WPAD/PAC) file."""
    try:
        import winreg  # noqa: PLC0415 — Windows-only, kept out of module scope

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            pac_url = winreg.QueryValueEx(key, "AutoConfigURL")[0]
    except Exception:  # noqa: BLE001 — no registry entry: direct access only
        return []
    pac_url = str(pac_url or "").strip()
    if not _IS_URL_RE.match(pac_url):
        return []
    try:
        with urllib.request.urlopen(
            urllib.request.Request(pac_url, headers={"User-Agent": "ODBCQueryApp"}),
            timeout=10,
        ) as response:
            text = response.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — unreadable PAC: direct access only
        return []
    proxies: list[str] = []
    for match in re.finditer(r"PROXY\s+([^;\"\s]+)", text, re.IGNORECASE):
        candidate = match.group(1).strip()
        # The PAC may legitimately return DIRECT for our URL, but when the
        # direct route is being reset its named proxies are the working way
        # out — try every host:port it mentions.
        if candidate and candidate.upper() != "DIRECT" and candidate not in proxies:
            proxies.append(candidate if "://" in candidate else f"http://{candidate}")
    return proxies


# A usable proxy is a dotted hostname (or bracketed IPv6) plus optional port;
# the registry can hold malformed leftovers ("Servers", "=") that must be skipped.
_PROXY_URL_RE = re.compile(
    r"^https?://(?:[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)+|\[[0-9a-fA-F:]+\])(:\d+)?$"
)


def _proxy_routes() -> list[str | None]:
    """Routes to try in order: direct first, then environment/PAC proxies."""
    global _PROXY_ROUTES
    with _PROXY_ROUTES_LOCK:
        if _PROXY_ROUTES is None:
            routes: list[str | None] = [None]
            for value in urllib.request.getproxies().values():
                proxy = value if "://" in value else f"http://{value}"
                # The registry can hold malformed leftovers ("Servers", "=");
                # only well-formed host:port proxies are worth a connection.
                if _PROXY_URL_RE.match(proxy) and proxy not in routes:
                    routes.append(proxy)
            for proxy in _pac_proxy_candidates():
                if _PROXY_URL_RE.match(proxy) and proxy not in routes:
                    routes.append(proxy)
            _PROXY_ROUTES = routes
        return list(_PROXY_ROUTES)


def _urlopen_with_fallback(
    request: urllib.request.Request, timeout: float, attempts_per_route: int = 2
):
    """Open ``request``, riding out flaky direct egress.

    Tries the direct route first (a couple of attempts — handshake resets are
    intermittent), then each proxy discovered from the environment or the
    system auto-config file. Returns an open response; raises the last error
    seen when every route fails.
    """
    last_exc: Exception = OSError(f"no route available for {request.full_url}")
    for route in _proxy_routes():
        for attempt in range(max(1, attempts_per_route)):
            try:
                handler = urllib.request.ProxyHandler(
                    {} if route is None else {"http": route, "https": route}
                )
                return urllib.request.build_opener(handler).open(request, timeout=timeout)
            except Exception as exc:  # noqa: BLE001 — retried below, then next route
                last_exc = exc
                if attempt + 1 < max(1, attempts_per_route):
                    time.sleep(1.5)
    raise last_exc


def _load_manifest(source: str) -> tuple[dict, str]:
    """Return (manifest_dict, base_location); base is used to resolve relative exes."""
    if _IS_URL_RE.match(source):
        request = urllib.request.Request(source, headers={"User-Agent": "ODBCQueryApp"})
        with _urlopen_with_fallback(request, timeout=15) as response:
            raw = response.read()
        return json.loads(raw.decode("utf-8")), source
    with open(source, "r", encoding="utf-8") as fh:
        return json.load(fh), os.path.dirname(os.path.abspath(source))


def _resolve_package_location(package: str, base: str) -> str:
    if _IS_URL_RE.match(package):
        return package
    if _IS_ABS_PATH_RE.match(package):
        return package
    if _IS_URL_RE.match(base):
        from urllib.parse import urljoin

        return urljoin(base, package)
    return os.path.normpath(os.path.join(base, package))


def _version_key(value) -> tuple:
    """Numeric tuple for comparison: '1.1' == '1.1.0', trailing zeros dropped."""
    parts = []
    for segment in re.split(r"[.\-+_]", str(value or "").strip()):
        match = re.match(r"^(\d+)", segment)
        if not match:
            break
        parts.append(int(match.group(1)))
    while parts and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


# ---------------------------------------------------------------------------
# update check
# ---------------------------------------------------------------------------

def check_now(source_override: str | None = None) -> dict:
    """Fetch the manifest and refresh the update state. Safe to call anytime."""
    with _LOCK:
        if STATE["state"] in _BUSY_STATES:
            return {k: v for k, v in STATE.items() if not k.startswith("_")}
        STATE["state"] = "checking"
        STATE["error"] = ""

    source = (source_override or "").strip() or _configured_source()
    if not source:
        _set(state="no_source", source=None, available=False, forced=False,
             latest_version=None, message="", checked_at=time.time())
        return _public_state()

    try:
        manifest, base = _load_manifest(source)
        if not isinstance(manifest, dict):
            raise ValueError("manifest is not a JSON object")
        latest = str(manifest.get("version") or "").strip()
        if not latest:
            raise ValueError("manifest has no \"version\" field")
        min_version = str(manifest.get("min_version") or "").strip() or None
        notes = str(manifest.get("notes") or "").strip()
        sha256_expected = str(manifest.get("sha256") or "").strip().lower() or None
        package_field = str(manifest.get("package") or "").strip()
    except Exception as exc:  # noqa: BLE001 — surface any manifest problem
        _set(state="error", source=source, error=f"Could not read update manifest: {exc}",
             message="", checked_at=time.time())
        logging_utils.log_warning("update", f"Manifest check failed for {source}: {exc}")
        return _public_state()

    current = APP_VERSION
    available = _version_key(current) < _version_key(latest)
    forced = bool(min_version) and _version_key(current) < _version_key(min_version)
    package_src = (_resolve_package_location(package_field, base)
                   if (package_field and available) else None)

    if available:
        _set(state="update_available", source=source, latest_version=latest,
             min_version=min_version, available=True, forced=forced, notes=notes,
             message=f"Version {latest} is available (you are on {current}).",
             checked_at=time.time(), download_percent=None, download_rate=None,
             _package_src=package_src,
             _sha256=sha256_expected)
        logging_utils.log_info(
            "update", f"Update available: v{latest} (current v{current}, "
                      f"forced={forced}, package={'yes' if package_src else 'no'})"
        )
    else:
        _set(state="up_to_date", source=source, latest_version=latest,
             min_version=min_version, available=False, forced=False, notes=notes,
             message=f"You are on the latest version ({current}).",
             checked_at=time.time(), download_percent=None, download_rate=None,
             _package_src=None,
             _sha256=None)
    return _public_state()


# ---------------------------------------------------------------------------
# download & install
# ---------------------------------------------------------------------------

def _download_to(src: str, dst: str) -> tuple[str, int]:
    """Stream src (URL, local or UNC path) into dst. Returns (sha256_hex, bytes)."""
    hasher = hashlib.sha256()
    done = 0
    total = None
    # Sliding window of (monotonic_time, bytes_so_far) samples for the kB/s readout.
    window: list[tuple[float, int]] = []
    if _IS_URL_RE.match(src):
        request = urllib.request.Request(src, headers={"User-Agent": "ODBCQueryApp"})
        remote = _urlopen_with_fallback(request, timeout=60)
    else:
        remote = open(src, "rb")
        try:
            total = os.path.getsize(src)
        except OSError:
            total = None
    try:
        headers = getattr(remote, "headers", None)
        if total is None and headers is not None:
            try:
                total = int(headers.get("Content-Length") or 0) or None
            except (TypeError, ValueError):
                total = None
        with remote, open(dst, "wb") as out:
            while True:
                chunk = remote.read(1024 * 1024)
                if not chunk:
                    break
                hasher.update(chunk)
                out.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                window.append((now, done))
                while window and now - window[0][0] > 5.0:
                    window.pop(0)
                rate = None
                if len(window) >= 2:
                    span = window[-1][0] - window[0][0]
                    if span > 0.25:
                        rate = int((window[-1][1] - window[0][1]) / span)
                with _LOCK:
                    if rate is not None:
                        STATE["download_rate"] = rate
                    if total:
                        percent = min(99, int(done * 100 / total))
                        if percent != STATE.get("download_percent"):
                            STATE["download_percent"] = percent
    finally:
        try:
            remote.close()
        except Exception:  # noqa: BLE001
            pass
    return hasher.hexdigest(), done


def _install_worker() -> None:
    with _LOCK:
        package_src = STATE.get("_package_src")
        version = STATE.get("latest_version")
        sha_expected = STATE.get("_sha256")
    zip_path = None
    staged_dir = None
    try:
        if not package_src:
            raise RuntimeError(
                "The update manifest does not specify a downloadable package."
            )
        # The published zip keeps a fixed name and is overwritten each release,
        # so bypass any CDN copy with a cache-busting query; local and UNC paths
        # are left untouched.
        if _IS_URL_RE.match(package_src):
            separator = "&" if "?" in package_src else "?"
            package_src = f"{package_src}{separator}v={int(time.time())}"
        os.makedirs(_staging_dir(), exist_ok=True)
        zip_path = os.path.join(_staging_dir(), f"ODBCQueryApp.{version}.zip")
        part = zip_path + ".part"
        _set(state="downloading", download_percent=0, download_rate=None,
             message=f"Downloading version {version}…")
        sha_hex, size = _download_to(package_src, part)
        os.replace(part, zip_path)

        _set(state="verifying", download_percent=100, message="Verifying download…")
        if sha_expected and sha_hex.lower() != sha_expected:
            raise RuntimeError(
                "Checksum mismatch — the downloaded package may be corrupted "
                "(share drive still syncing?)."
            )

        _set(state="verifying", message="Extracting the new build…")
        staged_dir = os.path.join(_staging_dir(), f"ODBCQueryApp-{version}")
        if os.path.isdir(staged_dir):
            shutil.rmtree(staged_dir, ignore_errors=True)
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(staged_dir)
        if not os.path.isfile(os.path.join(staged_dir, os.path.basename(sys.executable))):
            raise RuntimeError("The downloaded package does not contain the app.")

        target = os.path.dirname(sys.executable)
        pending = {"package": staged_dir, "target": target, "version": version}
        with open(_pending_file(), "w", encoding="utf-8") as fh:
            json.dump(pending, fh)
        logging_utils.log_info("update", f"Update v{version} staged ({size} bytes); waiting for idle")

        _set(state="waiting_idle", message="Waiting for running queries to finish…")
        # Lazy import: app.main imports this module at startup, so importing it
        # back at module level would be circular.
        from app import main as _main_module

        while _main_module.inflight_count() > 0:
            time.sleep(2)

        _set(state="restarting", message="Installing update and restarting…")
        logging_utils.log_info("update", f"Restarting to install v{version}")
        _main_module._stop_server("update")
        # The launcher swaps the install folders and spawns the new build; this
        # process exits below. Nothing else to do here.
    except Exception as exc:  # noqa: BLE001
        _set(state="error", error=str(exc), download_percent=None, download_rate=None,
             message="Update could not be installed.")
        logging_utils.log_error("update", f"Install failed: {exc}")
        try:
            if zip_path:
                for leftover in (zip_path, zip_path + ".part"):
                    if os.path.isfile(leftover):
                        os.remove(leftover)
            if staged_dir:
                shutil.rmtree(staged_dir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass


def start_install() -> dict:
    """Kick off the download/install thread. Raises HTTPException when not possible."""
    with _LOCK:
        if not STATE["available"]:
            raise HTTPException(status_code=400, detail="No update available.")
        if not STATE["supported"]:
            raise HTTPException(
                status_code=400,
                detail="Automatic update is only available in the packaged exe.",
            )
        if not STATE.get("_package_src"):
            raise HTTPException(
                status_code=400,
                detail="The update manifest does not include a downloadable package.",
            )
        if STATE["state"] in _BUSY_STATES:
            raise HTTPException(status_code=409, detail="An update is already in progress.")
        STATE["state"] = "downloading"  # claim before spawning to avoid races
        STATE["error"] = ""
    threading.Thread(target=_install_worker, daemon=True, name="update-install").start()
    return _public_state()


# ---------------------------------------------------------------------------
# background checker
# ---------------------------------------------------------------------------

def start_background_checker() -> None:
    """One daemon thread: first check shortly after boot, then every 6 hours."""
    global _started_checker
    with _started_checker_lock:
        if _started_checker:
            return
        _started_checker = True

    def _loop() -> None:
        time.sleep(FIRST_CHECK_DELAY_SECONDS)
        while True:
            try:
                if not _busy():
                    check_now()
            except Exception:  # noqa: BLE001 — never kill the checker
                pass
            time.sleep(CHECK_INTERVAL_SECONDS)

    threading.Thread(target=_loop, daemon=True, name="update-checker").start()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

router = APIRouter()


class SourceRequest(BaseModel):
    source: str = ""


@router.get("/update/status")
def get_update_status() -> dict:
    return _public_state()


@router.post("/update/check")
def post_update_check(payload: dict | None = Body(default=None)) -> dict:
    override = str((payload or {}).get("source") or "").strip() or None
    return check_now(source_override=override)


@router.post("/update/source")
def post_update_source(payload: SourceRequest) -> dict:
    source = (payload.source or "").strip()
    os.makedirs(APP_DATA_DIR, exist_ok=True)
    if source:
        with open(_source_file(), "w", encoding="utf-8") as fh:
            fh.write(source + "\n")
    else:
        try:
            os.remove(_source_file())
        except OSError:
            pass
    return check_now(source_override=source or None)


@router.post("/update/start")
def post_update_start() -> dict:
    return start_install()
