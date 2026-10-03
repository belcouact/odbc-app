"""One-command release: frontend -> onedir build -> zip -> latest.json -> Supabase.

Usage (from the backend directory):

    .venv\\Scripts\\python.exe release.py                 # full release + upload
    .venv\\Scripts\\python.exe release.py --skip-frontend  # package only
    .venv\\Scripts\\python.exe release.py --no-upload      # build, keep it local

Steps:
  1. build the React frontend into ../frontend/dist
  2. ask whether APP_VERSION should be incremented (the same prompt the spec
     used to ask mid-build — moved here so the version is final before
     packaging, which the bundled version history needs)
  3. record {version, date, notes} in app/data/version_history.json — the
     release history shown in Settings → About — then run PyInstaller
     (ODBCQueryApp.spec), producing dist\ODBCQueryApp\ (exe + _internal)
  4. zip that folder (contents at the zip root), hash the zip, and drop any
     leftover single-exe artefacts, then compile the Inno Setup installer
     (ODBCQueryApp-Setup-<version>.exe) when Inno Setup is installed
  5. write latest.json (backend) for the self-updater
  6. upload the zip, the installer and latest.json to the Supabase bucket and
     read them back through the public URL
  7. delete leftover ODBCQueryApp-*.exe files from the bucket (from the former
     single-exe scheme) so the storage quota does not fill up — versioned
     installers are kept, so a download link survives future releases

UPLOAD: the service-role key comes from a single line in
``%APPDATA%\\ODBCQueryApp\\supabase_key`` (preferred — this project folder is
synced, so keep secrets out of it) or ``backend\\.supabase_key``.  A shell
environment variable is deliberately ignored, so a leftover key for a different
Supabase project can never be picked up by accident.  Without a key the run
prints the equivalent curl commands instead of uploading.  The zip is
uploaded *before* the manifest, so a client can never see a manifest pointing at
a file that is not there yet.

The release notes shown in the update banner come from release_notes.txt; raise
MIN_VERSION only when old clients must be forced to update.

The published package keeps a fixed name (``ODBCQueryApp.zip``) so users never
have to reason about version-numbered files — the version lives only in
latest.json.  Because the object name is reused, the zip is uploaded with a
short cache TTL and the client appends a cache-buster when it downloads, so a
fresh release can never be masked by a cached copy of the previous build.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent          # backend/
APP_ROOT = ROOT.parent                          # project root
FRONTEND = APP_ROOT / "frontend"
DIST = ROOT / "dist"
SPEC = ROOT / "ODBCQueryApp.spec"
PACKAGE_DIR = DIST / "ODBCQueryApp"             # PyInstaller onedir output
PACKAGE_NAME = "ODBCQueryApp.zip"               # fixed published name
PACKAGE_ZIP = DIST / PACKAGE_NAME
NOTES_FILE = ROOT / "release_notes.txt"
MANIFEST = ROOT / "latest.json"
HISTORY_FILE = ROOT / "app" / "data" / "version_history.json"

# Clients older than this are forced to update (blocking dialog).  Raise it
# only for releases that really cannot be skipped.
MIN_VERSION = "1.0.0"

# Releases kept in app/data/version_history.json.  The file ships inside the
# exe, so it is capped to the most recent entries (Settings → About lists the
# same number) instead of growing with every release.
HISTORY_LIMIT = 5


def read_app_version() -> str:
    text = (ROOT / "app" / "version.py").read_text(encoding="utf-8")
    match = re.search(r'APP_VERSION\s*=\s*["\']([^"\']+)["\']', text)
    if not match:
        raise SystemExit("Could not find APP_VERSION in app/version.py")
    return match.group(1).strip()


def _bump_version(version: str, part: str) -> str:
    """Return ``version`` with ``part`` (patch/minor/major) incremented."""
    parts = [int(piece) for piece in version.split(".")]
    while len(parts) < 3:
        parts.append(0)
    index = {"major": 0, "minor": 1, "patch": 2}[part]
    parts[index] += 1
    for later in range(index + 1, 3):
        parts[later] = 0
    return ".".join(str(piece) for piece in parts[:3])


def ask_version_bump() -> None:
    """Ask once per release whether APP_VERSION should be incremented.

    Same prompt ODBCQueryApp.spec used to ask mid-build; it is skipped when
    stdin is not a terminal (scripted builds keep the current version). The
    spec is then run with ODBC_SKIP_VERSION_PROMPT=1: the version must be
    final *before* packaging so the bundled version history can include this
    very release.
    """
    if not sys.stdin.isatty():
        return
    current = read_app_version()
    print(f"\nCurrent APP_VERSION = {current}")
    try:
        answer = input(
            "Increment the version before building? "
            f"[p]atch / [m]inor / [M]ajor / Enter = keep {current} > "
        ).strip()
    except (EOFError, OSError):
        # Piped/closed stdin (scripted run): keep the current version.
        print(f"Keeping APP_VERSION = {current}")
        return
    part = {"p": "patch", "patch": "patch", "m": "minor", "minor": "minor",
            "M": "major", "major": "major"}.get(answer)
    if not part:
        print(f"Keeping APP_VERSION = {current}")
        return
    version_file = ROOT / "app" / "version.py"
    new_version = _bump_version(current, part)
    updated = re.sub(
        r'(APP_VERSION\s*=\s*)["\'][^"\']+["\']',
        lambda m: f'{m.group(1)}"{new_version}"',
        version_file.read_text(encoding="utf-8"),
        count=1,
    )
    version_file.write_text(updated, encoding="utf-8")
    print(f"APP_VERSION bumped: {current} -> {new_version}")


def _version_key(version: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", version)
    return tuple(int(piece) for piece in parts[:3]) or (0,)


def update_version_history(version: str) -> None:
    """Record this release in app/data/version_history.json.

    The file is bundled into the exe and rendered in Settings → About, giving
    every installed client a trail of past releases for traceability. Runs
    before the PyInstaller build so the entry ships inside the very exe it
    describes. Re-running the same version replaces its entry (idempotent) and
    the list is capped at the ``HISTORY_LIMIT`` most recent releases, so the
    bundled file cannot grow without bound.
    """
    notes = ""
    if NOTES_FILE.is_file():
        notes = NOTES_FILE.read_text(encoding="utf-8").strip()
    else:
        print(f"WARNING: {NOTES_FILE.name} is missing — this release will have no notes.")
    entry = {"version": version, "date": time.strftime("%Y-%m-%d"), "notes": notes}
    history: list[dict] = []
    if HISTORY_FILE.is_file():
        try:
            parsed = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            if isinstance(parsed, list):
                history = [item for item in parsed if isinstance(item, dict)]
        except (OSError, ValueError):
            print(f"WARNING: {HISTORY_FILE.name} is malformed — starting a fresh history.")
    history = [item for item in history if item.get("version") != version]
    history.append(entry)
    history.sort(key=lambda item: _version_key(str(item.get("version", ""))), reverse=True)
    dropped = max(0, len(history) - HISTORY_LIMIT)
    if dropped:
        history = history[:HISTORY_LIMIT]
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(
        json.dumps(history, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Version history: {len(history)} release(s) recorded in {HISTORY_FILE.name}"
          + (f" ({dropped} older release(s) dropped)" if dropped else ""))


def read_manifest_url() -> str:
    try:
        sys.path.insert(0, str(ROOT))
        from app.update import DEFAULT_MANIFEST_URL  # noqa: PLC0415

        return DEFAULT_MANIFEST_URL
    except Exception:  # noqa: BLE001 - the URL is only used for printing
        return ""


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    print(f"\n$ {' '.join(cmd)}\n   (cwd: {cwd})", flush=True)
    result = subprocess.run(cmd, cwd=str(cwd), env=env)
    if result.returncode != 0:
        raise SystemExit(f"Command failed with exit code {result.returncode}: {cmd[0]}")


def sha256_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def build_python() -> str:
    """Interpreter PyInstaller must run under: the project venv when present.

    PyInstaller collects from whatever ``sys.path`` the *build* interpreter can
    see, so running it under a global Python also hands it that interpreter's
    entire site-packages.  That is how llvmlite (84 MB), pyarrow (77 MB) and
    matplotlib (10 MB) ended up inside a ~28 MB exe, taking it to 105 MB.  The
    venv (``include-system-site-packages = false``) makes that impossible.
    """
    venv = ROOT / ".venv" / "Scripts" / "python.exe"
    if venv.is_file():
        return str(venv)
    if sys.prefix == sys.base_prefix:
        print(f"WARNING: {venv} is missing and this is a global Python — the exe "
              f"will bundle everything installed system-wide and be far larger than usual.")
    return sys.executable


def package_zip() -> Path:
    """Zip dist\\ODBCQueryApp into dist\\ODBCQueryApp.zip.

    Contents sit at the zip root (no top-level folder) because the updater
    extracts the archive straight into a fresh staging folder and then swaps
    that folder with the install directory.
    """
    exe = PACKAGE_DIR / "ODBCQueryApp.exe"
    if not exe.is_file():
        raise SystemExit(f"Build did not produce {PACKAGE_DIR} (missing {exe.name})")
    PACKAGE_ZIP.unlink(missing_ok=True)
    with zipfile.ZipFile(PACKAGE_ZIP, "w", zipfile.ZIP_DEFLATED,
                         compresslevel=9) as archive:
        for path in sorted(PACKAGE_DIR.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(PACKAGE_DIR))
    return PACKAGE_ZIP


def dir_size(path: Path) -> int:
    """Total bytes of every file below ``path``."""
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
    return total


def find_iscc() -> Path | None:
    """Locate the Inno Setup compiler (ISCC.exe), if installed."""
    hits: list[Path] = []
    for base, pattern in (
        (os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
         "Inno Setup */ISCC.exe"),
        (os.environ.get("ProgramFiles", r"C:\Program Files"),
         "Inno Setup */ISCC.exe"),
        # winget's per-user install lands in %LOCALAPPDATA%\Programs\Inno Setup 6.
        (os.environ.get("LocalAppData", ""), "Programs/Inno Setup */ISCC.exe"),
    ):
        if base:
            hits += sorted(Path(base).glob(pattern))
    found = shutil.which("ISCC")
    if found:
        hits.append(Path(found))
    return hits[-1] if hits else None


def build_installer() -> Path | None:
    """Compile dist\\ODBCQueryApp into the shareable per-user setup exe.

    Returns None (with a hint) when Inno Setup is not installed — the plain
    zip remains fully functional without it.
    """
    iscc = find_iscc()
    if not iscc:
        print("\nInno Setup not found — skipping the installer build.")
        print("  Install it once (`winget install JRSoftware.InnoSetup` or")
        print("  https://jrsoftware.org/isdl.php) and rerun to also get")
        print("  ODBCQueryApp-Setup-<version>.exe, the file to share.")
        return None
    print(f"\nBuilding installer with {iscc}…", flush=True)
    run([str(iscc), str(ROOT / "ODBCQueryApp.iss")], cwd=ROOT)
    candidates = sorted(DIST.glob("ODBCQueryApp-Setup-*.exe"))
    if not candidates:
        raise SystemExit("Inno Setup did not produce the expected installer")
    return candidates[0]


# ---- Supabase upload -------------------------------------------------------


def _file_key(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip() if path.is_file() else ""


def _jwt_ref(key: str) -> str | None:
    """Project ``ref`` claim of a legacy Supabase JWT key (None if not a JWT)."""
    if not key.startswith("eyJ"):
        return None
    try:
        payload = key.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claim = json.loads(base64.urlsafe_b64decode(payload)).get("ref")
    except Exception:  # noqa: BLE001 - malformed key: treat it as opaque
        return None
    return str(claim) if claim else None


def expected_project_ref(manifest_url: str) -> str | None:
    """``<ref>`` of a ``https://<ref>.supabase.co/...`` manifest URL."""
    match = re.search(r"https://([^.]+)\.supabase\.", manifest_url)
    return match.group(1) if match else None


def upload_key(expected_ref: str | None = None) -> str | None:
    """Service-role key for THIS project, read from the key files.

    The two fixed key files are the only sources on purpose: a shell variable
    such as ``SUPABASE_SERVICE_ROLE_KEY`` is ignored, so a stale key left in the
    environment can never be used.  A candidate that is a Supabase JWT for a
    *different* project ref is skipped with a warning — posting with it fails
    with "signature verification failed".
    """
    candidates: list[tuple[str, str]] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        path = Path(appdata) / "ODBCQueryApp" / "supabase_key"
        if path.is_file():
            candidates.append((str(path), _file_key(path)))
    path = ROOT / ".supabase_key"
    if path.is_file():
        candidates.append((str(path), _file_key(path)))

    for source, key in candidates:
        if not key:
            continue
        ref = _jwt_ref(key)
        if expected_ref and ref and ref != expected_ref:
            print(f"WARNING: {source} belongs to project {ref!r}, not "
                  f"{expected_ref!r} — skipped.")
            continue
        return key
    return None


def bucket_base(manifest_url: str) -> str:
    """Public manifest URL -> ``.../storage/v1/object/<bucket>`` (write/delete base)."""
    return manifest_url.replace("/object/public/", "/object/").rsplit("/", 1)[0]


def object_url(manifest_url: str, name: str) -> str:
    """Public manifest URL -> write URL for one file in the same bucket."""
    return bucket_base(manifest_url) + "/" + name


def list_url(manifest_url: str) -> str:
    """Public manifest URL -> the bucket's object-list endpoint."""
    return bucket_base(manifest_url).replace("/object/", "/object/list/", 1)


def http(url: str, method: str, headers: dict[str, str] | None = None, data: bytes | None = None):
    request = urllib.request.Request(url, data=data, method=method)
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        # The resilient opener rides out the corporate network's flaky direct
        # egress (handshake resets) by retrying and falling back to the
        # auto-config (WPAD) proxy servers.
        sys.path.insert(0, str(ROOT))
        from app.update import _urlopen_with_fallback  # noqa: PLC0415

        with _urlopen_with_fallback(request, timeout=900) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:400]
        raise SystemExit(f"HTTP {exc.code} on {method} {url}\n{body}") from None


def upload_release(upload_url: str, package: Path, manifest: Path, version: str, digest: str,
                   key: str, installer: Path | None = None) -> None:
    """Upload the zip + installer, then the manifest, verify, then prune."""
    auth = {"Authorization": f"Bearer {key}", "x-upsert": "true"}

    payload = package.read_bytes()
    print(f"\nUploading {package.name} ({len(payload) / 1048576:.2f} MB)…", flush=True)
    # The zip keeps a fixed name and is overwritten every release, so it must
    # NOT be cached long-lived — a stale copy would fail the client's sha256
    # check.  The client also cache-busts the download URL.
    http(object_url(upload_url, package.name), "POST",
         {**auth, "Content-Type": "application/octet-stream",
          "cache-control": "max-age=60"},
         payload)
    print("  uploaded")

    if installer is not None:
        print(f"Uploading {installer.name} "
              f"({installer.stat().st_size / 1048576:.2f} MB)…", flush=True)
        # The installer name contains the version, so one release never
        # overwrites another and a long CDN cache is fine.
        http(object_url(upload_url, installer.name), "POST",
             {**auth, "Content-Type": "application/octet-stream",
              "cache-control": "max-age=86400"},
             installer.read_bytes())
        link = f"{upload_url.rsplit('/', 1)[0]}/{installer.name}"
        print(f"  uploaded — shareable download link:\n    {link}")
        # Same bytes again under a fixed name: a link shared once (pinned in a
        # chat or a wiki) keeps pointing at the newest release. Short TTL,
        # because unlike the versioned name this object is overwritten.
        latest = "ODBCQueryApp-Setup-latest.exe"
        http(object_url(upload_url, latest), "POST",
             {**auth, "Content-Type": "application/octet-stream",
              "cache-control": "max-age=60"},
             installer.read_bytes())
        print(f"  uploaded — stable always-newest link:\n    "
              f"{upload_url.rsplit('/', 1)[0]}/{latest}")

    print(f"Uploading {manifest.name}…", flush=True)
    http(object_url(upload_url, manifest.name), "POST",
         {**auth, "Content-Type": "application/json",
          "cache-control": "max-age=60"},          # short TTL: new releases show up fast
         manifest.read_bytes())
    print("  uploaded")

    # Read back through the public URL.  The CDN can lag behind a write, so a
    # stale answer is reported as a warning instead of failing the release.
    _, body = http(f"{upload_url}?release={int(time.time())}", "GET",
                   {"Cache-Control": "no-cache"})
    published = json.loads(body.decode("utf-8"))
    if published.get("version") == version and published.get("sha256") == digest:
        print(f"Verified: the published manifest serves {version} with the expected sha256.")
    else:
        print(f"WARNING: the published manifest still reports version "
              f"{published.get('version')!r} — the CDN may need a minute to catch up; "
              f"check {upload_url} before announcing the release.")

    status, _ = http(object_url(upload_url, package.name), "HEAD")
    print(f"Verified: {package.name} is downloadable (HTTP {status}).")

    prune_old_releases(upload_url, key)


def fetch_bucket_names(upload_url: str, key: str) -> list[str]:
    """Names of every object at the root of the update bucket."""
    payload = json.dumps({
        "prefix": "",
        "limit": 1000,
        "offset": 0,
        "sortBy": {"column": "name", "order": "asc"},
    }).encode("utf-8")
    _, body = http(list_url(upload_url), "POST",
                   {"Authorization": f"Bearer {key}",
                    "Content-Type": "application/json"}, payload)
    entries = json.loads(body.decode("utf-8"))
    return [str(item.get("name", "")) for item in entries if isinstance(item, dict)]


def delete_objects(upload_url: str, names: list[str], key: str) -> None:
    payload = json.dumps({"prefixes": names}).encode("utf-8")
    http(bucket_base(upload_url), "DELETE",
         {"Authorization": f"Bearer {key}",
          "Content-Type": "application/json"}, payload)


def prune_old_releases(upload_url: str, key: str) -> None:
    """Delete leftover ``ODBCQueryApp-*.exe`` builds from the bucket.

    The published package is a fixed ``ODBCQueryApp.zip`` that is overwritten in
    place each release, so there is normally nothing to prune; this only clears
    the version-numbered exes left behind by the former single-exe scheme.  It
    runs only after the new zip and manifest are published, and its pattern
    never matches the manifest or the current fixed-name zip.  A failure here is
    a warning: the release itself already succeeded.
    """
    try:
        names = fetch_bucket_names(upload_url, key)
    except SystemExit as exc:
        print(f"\nWARNING: could not list the bucket — old releases were left in place.\n{exc}")
        return

    stale = sorted(
        name for name in names
        if re.fullmatch(r"ODBCQueryApp-.+\.exe", name, re.IGNORECASE)
        # keep the versioned installers — each release's link stays valid
        and not re.fullmatch(r"ODBCQueryApp-Setup-.+\.exe", name, re.IGNORECASE)
    )
    if not stale:
        print("\nNo stale single-exe builds to remove (installers and ODBCQueryApp.zip kept).")
        return

    print(f"\nRemoving {len(stale)} superseded release exe(s): {', '.join(stale)}")
    try:
        delete_objects(upload_url, stale, key)
    except SystemExit as exc:
        print(f"WARNING: could not delete old releases — the bucket still holds them.\n{exc}")
        return
    print(f"  removed {len(stale)} file(s); installers and ODBCQueryApp.zip kept.")


def print_manual_upload(upload_url: str, package: Path, manifest: Path,
                        installer: Path | None = None) -> None:
    """Fall back to copy-paste curl commands when we have no key."""
    files = [package] + ([installer] if installer else []) + [manifest]
    print("\nUpload these files to the update bucket (manifest last):")
    for index, item in enumerate(files, 1):
        extra = ("   (upload LAST, so clients never see a manifest"
                 "\n                    pointing at a file that is not there yet)"
                 if item is manifest else "")
        print(f"  {index}. {item.name}{extra}")
    print("\nSame thing from the command line (needs your service_role key):")
    for item in files:
        content_type = "application/json" if item.suffix == ".json" else "application/octet-stream"
        print(f'  curl.exe -X POST "{object_url(upload_url, item.name)}" \\')
        print('    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \\')
        print(f'    -H "Content-Type: {content_type}" -H "x-upsert: true" \\')
        print(f'    --data-binary "@{item}"')


def main() -> None:
    if "--skip-frontend" not in sys.argv:
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        if not npm:
            raise SystemExit("npm was not found on PATH. Install Node.js, or run with "
                             "--skip-frontend to package the existing frontend/dist.")
        run([npm, "run", "build"], cwd=FRONTEND)
    else:
        print("\nSkipping frontend build (--skip-frontend)")

    # The version is decided up front (ask_version_bump mirrors the spec's old
    # mid-build prompt) and recorded in the version history, both *before*
    # packaging so the exe bundles a history that includes its own release.
    # UPX is deliberately not used: packed executables are a strong antivirus
    # false-positive heuristic, and the onedir layout already starts fast.
    ask_version_bump()
    update_version_history(read_app_version())
    run([build_python(), "-m", "PyInstaller", str(SPEC), "--noconfirm"],
        cwd=ROOT, env=dict(os.environ, ODBC_SKIP_VERSION_PROMPT="1"))

    version = read_app_version()
    print(f"\nReleasing version {version}")

    previous_version = None
    if MANIFEST.is_file():
        try:
            previous_version = json.loads(MANIFEST.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            pass
    if previous_version == version:
        print(f"WARNING: latest.json is already on {version}. Installed clients will never "
              f"see this build — re-run and answer the version prompt next time.")

    zip_path = package_zip()
    digest = sha256_of(zip_path)
    size = zip_path.stat().st_size
    folder_size = dir_size(PACKAGE_DIR)
    if size > 120 * 1024 * 1024:
        print(f"WARNING: the zip is {size / 1048576:.1f} MB — consider trimming unused "
              f"dependencies in the spec to keep downloads fast.")

    # Remove leftover artefacts of the former single-exe scheme so dist holds
    # only the onedir folder, its zip and the installer.
    for stale in [DIST / "ODBCQueryApp.exe",
                  *DIST.glob("ODBCQueryApp-Setup-*.exe")]:
        if stale.is_file():
            print(f"Removing stale build output: {stale.name}")
            stale.unlink()
    installer = build_installer()

    notes = ""
    if NOTES_FILE.is_file():
        notes = NOTES_FILE.read_text(encoding="utf-8").strip()
    else:
        print(f"WARNING: {NOTES_FILE.name} is missing — the update banner will have no notes.")

    manifest = {
        "version": version,
        "min_version": MIN_VERSION,
        "notes": notes,
        "package": PACKAGE_NAME,
        "sha256": digest,
    }
    if installer:
        # Purely informational for now — clients ignore unknown fields, and a
        # future release can offer "download the installer" from this name.
        manifest["installer"] = installer.name
    payload = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    MANIFEST.write_text(payload, encoding="utf-8")
    json.loads(MANIFEST.read_text(encoding="utf-8"))  # fail loudly if malformed

    upload_url = read_manifest_url()
    print("\n" + "=" * 70)
    print(f"Release {version} ready")
    print("=" * 70)
    print(f"  folder   : {PACKAGE_DIR}  ({folder_size / (1024 * 1024):.2f} MB installed)")
    print(f"  zip      : {zip_path}  ({size / (1024 * 1024):.2f} MB download)")
    if installer:
        print(f"  installer: {installer.name}  "
              f"({installer.stat().st_size / (1024 * 1024):.2f} MB — the file to share)")
        if upload_url:
            print(f"             published at {upload_url.rsplit('/', 1)[0]}/{installer.name}")
    print(f"  sha256   : {digest}")
    print(f"  manifest : {MANIFEST}")
    print(f"  notes    : {len(notes)} chars from {NOTES_FILE.name}")

    if not upload_url:
        print("\nNo manifest URL configured — publish the exe and latest.json by hand.")
        return

    print(f"\n  manifest URL: {upload_url}")
    if "--no-upload" in sys.argv:
        print("\nSkipping the upload (--no-upload)")
        print_manual_upload(upload_url, zip_path, MANIFEST, installer)
        return

    key = upload_key(expected_project_ref(upload_url))
    if not key:
        print("\nNo Supabase key found, so nothing was uploaded.")
        print("  Save the service-role key on a single line in")
        print(f"  {Path(os.environ.get('APPDATA', '~')) / 'ODBCQueryApp' / 'supabase_key'}")
        print_manual_upload(upload_url, zip_path, MANIFEST, installer)
        return

    upload_release(upload_url, zip_path, MANIFEST, version, digest, key, installer)


if __name__ == "__main__":
    main()
