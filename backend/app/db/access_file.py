"""Resolve Microsoft Access (.mdb/.accdb) database files for ODBC connections.

Two sources are supported:

- a SharePoint/OneDrive ``:u:`` share link — an anonymous download is
  attempted; internal sites usually redirect to Microsoft sign-in, in which
  case a clear error tells the user to provide a local path instead;
- a local file path (OneDrive-synced folder or a manual browser download).

The resolved local path is what the Access ODBC driver connects to.
"""
import os
import re
import shutil
import urllib.error
import urllib.parse
import urllib.request

from app.config import APP_DATA_DIR

_ACCESS_DRIVER = "Microsoft Access Driver (*.mdb, *.accdb)"
_CACHE_DIR = os.path.join(APP_DATA_DIR, "files")


def build_access_connection_string(file_path: str) -> str:
    """Assemble the pyodbc connection string for a local Access database."""
    return (
        f"DRIVER={{{_ACCESS_DRIVER}}};"
        f"DBQ={file_path};"
        f"ReadOnly=1;"
    )


def to_download_url(share_url: str) -> str | None:
    """Convert a SharePoint ':u:' share link into a direct download URL.

    Handles the ``/:u:/r/`` (site-relative) and ``/:u:/s/`` (shared) forms,
    e.g.::

        https://tenant.sharepoint.com/:u:/r/sites/<site>/<path>/file.mdb?d=...
        → https://tenant.sharepoint.com/sites/<site>/<path>/file.mdb?download=1

    Non-SharePoint URLs are returned with ``?download=1`` appended.
    """
    url = share_url.strip()
    if not url:
        return None
    parsed = urllib.parse.urlsplit(url)
    match = re.search(r"/:u:/(?:r|s)/(.+)$", parsed.path)
    if match:
        return f"https://{parsed.netloc}/{match.group(1)}?download=1"
    return url + "?download=1"


def _looks_like_html(head: bytes) -> bool:
    """Heuristic: SharePoint auth/error pages return HTML, a real file does not."""
    sample = head.lstrip()[:16].lower()
    return sample.startswith(b"<") or b"<!doctype" in sample or b"<!--" in sample


def download_access_file(share_url: str) -> str:
    """Download a .mdb/.accdb from a SharePoint link into the cache directory.

    Raises a user-friendly ``RuntimeError`` when the site requires sign-in or
    the response is not a database file.
    """
    download_url = to_download_url(share_url)
    if download_url is None:
        raise RuntimeError("The SharePoint link is empty.")
    os.makedirs(_CACHE_DIR, exist_ok=True)
    filename = (
        os.path.basename(urllib.parse.unquote(urllib.parse.urlsplit(download_url).path))
        or "database.mdb"
    )
    dest = os.path.join(_CACHE_DIR, filename)
    req = urllib.request.Request(download_url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as fh:
            head = resp.read(4096)
            if _looks_like_html(head):
                raise RuntimeError(
                    "The SharePoint link requires a Microsoft sign-in. "
                    "Download the file in your browser (or sync the folder via "
                    "OneDrive), then paste the local file path instead."
                )
            fh.write(head)
            shutil.copyfileobj(resp, fh)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Could not download from SharePoint ({exc.code} {exc.reason}). "
            "Download the file in your browser and use the local path instead."
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Could not reach SharePoint ({exc.reason}). "
            "Download the file in your browser and use the local path instead."
        ) from exc
    return dest


def resolve_access_file(url: str | None, local_path: str | None) -> str:
    """Return the local .mdb/.accdb path for an access connection.

    A provided local path takes precedence (checked for existence); otherwise
    the SharePoint URL is downloaded into the cache directory.
    """
    if local_path and local_path.strip():
        path = os.path.abspath(os.path.expanduser(local_path.strip()))
        if os.path.isfile(path):
            return path
        raise RuntimeError(f"File not found: {path}")
    if url and url.strip():
        return download_access_file(url)
    raise RuntimeError("Provide either a SharePoint link or a local file path.")
