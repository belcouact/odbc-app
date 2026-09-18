"""API routes for the in-app feedback board.

The board is stored in the Supabase project that also serves app updates
(``llbxyhphblhplfpgyjht``), in the tables created by ``feedback_schema.sql``.
There is no sign-in: the backend talks to PostgREST with the project's *anon*
key and the board is open to everyone, so this module is a thin, validating
proxy rather than an authentication layer.

Identity is per machine: ``%APPDATA%\\ODBCQueryApp\\feedback_profile.json``
holds a random ``author_id`` plus the display nickname.  Because that id never
leaves the machine, edit/delete calls are scoped by it here, which keeps the
"only your own posts" rule in one place instead of trusting a value sent by
the browser.

The anon key is public by design (it is the same key Supabase hands to browser
clients) and resolves as: ``ODBC_FEEDBACK_KEY`` env var ->
``%APPDATA%\\ODBCQueryApp\\feedback_anon_key`` -> the built-in default below.
"""
import json
import mimetypes
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app import logging_utils, storage
from app.config import APP_DATA_DIR
from app.version import APP_VERSION

router = APIRouter()

PROJECT_URL = "https://llbxyhphblhplfpgyjht.supabase.co"
DEFAULT_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsYnh5aHBoYmxocGxmcGd5amh0Iiwicm9sZSI6ImFub24i"
    "LCJpYXQiOjE3NzY0OTI5ODIsImV4cCI6MjA5MjA2ODk4Mn0."
    "O7STzbSk7upedAOSVpGH8SkP8u-W7EaBeT9V0sgl2tg"
)
ATTACHMENT_BUCKET = "feedback-attachments"

REQUEST_TIMEOUT_SECONDS = 15
UPLOAD_TIMEOUT_SECONDS = 60
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENTS = 5
MAX_TITLE_LENGTH = 200
MAX_BODY_LENGTH = 8000
MAX_NICKNAME_LENGTH = 40
THREAD_PAGE_LIMIT = 200

CATEGORIES = ("bug", "idea", "question", "other")
STATUSES = ("open", "resolved")
SORTS = ("recent", "newest", "top")

# Object-store extensions the board accepts, and the MIME type used when the
# browser did not supply one (mimetypes.guess_type is tried first).
ATTACHMENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".zip": "application/zip",
}

_PROFILE_FILE = "feedback_profile.json"
_KEY_FILE = "feedback_anon_key"

_THREAD_COLUMNS = (
    "id,title,body,category,status,author_id,author_name,app_version,attachments,"
    "created_at,updated_at,feedback_replies(count),feedback_likes(count)"
)
_REPLY_COLUMNS = (
    "id,thread_id,body,author_id,author_name,app_version,attachments,created_at"
)


# ---------------------------------------------------------------------------
# key & profile resolution
# ---------------------------------------------------------------------------

def anon_key() -> str:
    """The Supabase anon key: env var -> key file -> built-in default."""
    env = (os.environ.get("ODBC_FEEDBACK_KEY") or "").strip()
    if env:
        return env
    try:
        with open(os.path.join(APP_DATA_DIR, _KEY_FILE), encoding="utf-8") as fh:
            value = fh.read().strip()
    except OSError:
        value = ""
    return value or DEFAULT_ANON_KEY


def _default_nickname() -> str:
    """Windows account name, used as the initial (editable) display name."""
    return (os.environ.get("USERNAME") or os.environ.get("USER") or "").strip()


def load_profile() -> dict:
    """This machine's feedback identity, created on first use."""
    profile = storage.load_json(_PROFILE_FILE, None)
    if isinstance(profile, dict) and profile.get("author_id"):
        return profile
    profile = {
        "author_id": uuid.uuid4().hex,
        "nickname": _default_nickname()[:MAX_NICKNAME_LENGTH],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    storage.save_json(_PROFILE_FILE, profile)
    return profile


# ---------------------------------------------------------------------------
# HTTP plumbing (stdlib only — the update checker uses urllib the same way)
# ---------------------------------------------------------------------------

def _rest_error_message(exc: urllib.error.HTTPError) -> str:
    """Readable message for a failed PostgREST call, with setup hints."""
    detail = ""
    try:
        raw = exc.read().decode("utf-8", "replace")
        payload = json.loads(raw)
        if isinstance(payload, dict):
            parts = [
                str(payload.get(key) or "").strip()
                for key in ("message", "details", "hint")
            ]
            detail = " ".join(part for part in parts if part)
        else:
            detail = raw.strip()
    except (ValueError, OSError):
        detail = ""
    if exc.code in (401, 403):
        return (
            "The feedback service rejected the request — the anon key may be "
            "revoked or missing permissions."
            + (f" ({detail})" if detail else "")
        )
    # PGRST205 / PGRST202: schema cache miss -> the tables were never created.
    if "schema cache" in detail.lower() or "Could not find the table" in detail:
        return (
            "The feedback tables do not exist yet. Run backend/feedback_schema.sql "
            "in the SQL editor of the Supabase project first."
        )
    if detail:
        return f"Feedback service error: {detail}"
    return f"Feedback service error (HTTP {exc.code})."


def _send(method: str, url: str, data: Optional[bytes], headers: dict, timeout: int):
    """Perform one HTTP call and decode the JSON response (None when empty)."""
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        message = _rest_error_message(exc)
        logging_utils.log_warning("feedback", f"{method} {url} failed", details=message)
        raise HTTPException(status_code=502, detail=message) from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        message = "Cannot reach the feedback service. Check the network and try again."
        logging_utils.log_warning(
            "feedback", f"{method} {url} unreachable", details=str(exc)
        )
        raise HTTPException(status_code=503, detail=message) from exc
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _rest(method: str, path: str, *, payload=None, prefer: Optional[str] = None):
    """Call PostgREST (``/rest/v1/...``) with the anon key."""
    key = anon_key()
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    return _send(
        method,
        f"{PROJECT_URL}/rest/v1/{path}",
        data,
        headers,
        REQUEST_TIMEOUT_SECONDS,
    )


def _storage_url(object_path: str, *, public: bool) -> str:
    quoted = urllib.parse.quote(object_path)
    kind = "object/public" if public else "object"
    return f"{PROJECT_URL}/storage/v1/{kind}/{ATTACHMENT_BUCKET}/{quoted}"


# ---------------------------------------------------------------------------
# validation & shaping
# ---------------------------------------------------------------------------

def _text(value, field: str, *, max_length: int, required: bool = True) -> str:
    """Trimmed text, rejected when empty (required) or too long."""
    text = str(value or "").strip()
    if required and not text:
        raise HTTPException(status_code=400, detail=f"{field} is required.")
    if len(text) > max_length:
        raise HTTPException(
            status_code=400, detail=f"{field} must be at most {max_length} characters."
        )
    return text


def _choice(value, field: str, allowed: tuple, default: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return default
    if text not in allowed:
        raise HTTPException(status_code=400, detail=f"{field} is not a valid value.")
    return text


def _attachments_in(value) -> list[dict]:
    """Validate the attachment list sent by the client (already uploaded)."""
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="Attachment payload is malformed.")
    out: list[dict] = []
    for item in value[:MAX_ATTACHMENTS]:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Attachment payload is malformed.")
        url = str(item.get("url") or "").strip()
        if not url.startswith(_storage_url("", public=True)):
            raise HTTPException(status_code=400, detail="Attachment URL is not valid.")
        try:
            size = int(item.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        if size > MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=400, detail="Attachments are limited to 10 MB each."
            )
        out.append(
            {
                "url": url,
                "name": str(item.get("name") or "").strip()[:120] or "attachment",
                "size": size,
                "type": str(item.get("type") or "").strip()[:120],
            }
        )
    return out


def _attachments_out(value) -> list[dict]:
    """Stored attachments as the UI expects them (tolerates legacy values)."""
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        try:
            size = int(item.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        out.append(
            {
                "url": url,
                "name": str(item.get("name") or "").strip() or "attachment",
                "size": size,
                "type": str(item.get("type") or "").strip(),
            }
        )
    return out


def _embedded_count(value) -> int:
    """PostgREST aggregate embedding: ``[{"count": 3}]`` -> 3."""
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        try:
            return int(value.get("count") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


def _thread_out(row: dict, me: str, liked_ids: set) -> dict:
    return {
        "id": str(row.get("id") or ""),
        "title": str(row.get("title") or ""),
        "body": str(row.get("body") or ""),
        "category": str(row.get("category") or "other"),
        "status": str(row.get("status") or "open"),
        "author_name": str(row.get("author_name") or ""),
        "app_version": str(row.get("app_version") or ""),
        "attachments": _attachments_out(row.get("attachments")),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "reply_count": _embedded_count(row.get("feedback_replies")),
        "like_count": _embedded_count(row.get("feedback_likes")),
        "liked_by_me": str(row.get("id") or "") in liked_ids,
        "mine": str(row.get("author_id") or "") == me,
    }


def _reply_out(row: dict, me: str) -> dict:
    return {
        "id": str(row.get("id") or ""),
        "thread_id": str(row.get("thread_id") or ""),
        "body": str(row.get("body") or ""),
        "author_name": str(row.get("author_name") or ""),
        "app_version": str(row.get("app_version") or ""),
        "attachments": _attachments_out(row.get("attachments")),
        "created_at": row.get("created_at"),
        "mine": str(row.get("author_id") or "") == me,
    }


def _fetch_thread(thread_id: str) -> Optional[dict]:
    rows = _rest(
        "GET",
        "feedback_threads?"
        + urllib.parse.urlencode(
            {"select": "id,author_id", "id": f"eq.{thread_id}", "limit": "1"}
        ),
    )
    return rows[0] if isinstance(rows, list) and rows else None


def _require_thread(thread_id: str) -> None:
    if _fetch_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail="This feedback no longer exists.")


# ---------------------------------------------------------------------------
# request bodies
# ---------------------------------------------------------------------------

class ProfileUpdate(BaseModel):
    nickname: str = ""


class ThreadCreate(BaseModel):
    title: str = ""
    body: str = ""
    category: str = "other"
    attachments: list = Field(default_factory=list)


class ThreadUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None


class ReplyCreate(BaseModel):
    body: str = ""
    attachments: list = Field(default_factory=list)


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@router.get("/feedback/profile")
def get_profile():
    """This machine's nickname + anonymous author id."""
    profile = load_profile()
    return {
        "author_id": profile.get("author_id"),
        "nickname": profile.get("nickname") or "",
    }


@router.put("/feedback/profile")
def update_profile(payload: ProfileUpdate):
    """Rename this machine on the board (existing posts keep their old name)."""
    nickname = _text(
        payload.nickname, "Nickname", max_length=MAX_NICKNAME_LENGTH, required=True
    )
    profile = load_profile()
    profile["nickname"] = nickname
    storage.save_json(_PROFILE_FILE, profile)
    return {"author_id": profile.get("author_id"), "nickname": nickname}


@router.get("/feedback/threads")
def list_threads(
    category: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    sort: str = Query(default="recent"),
):
    """The board: threads with reply/like counts, newest activity first."""
    me = str(load_profile().get("author_id") or "")
    sort = _choice(sort, "Sort", SORTS, "recent")
    filters = {
        "select": _THREAD_COLUMNS,
        "order": "created_at.desc" if sort == "newest" else "updated_at.desc",
        "limit": str(THREAD_PAGE_LIMIT),
    }
    if category:
        filters["category"] = f"eq.{_choice(category, 'Category', CATEGORIES, 'other')}"
    if status:
        filters["status"] = f"eq.{_choice(status, 'Status', STATUSES, 'open')}"

    rows = _rest("GET", "feedback_threads?" + urllib.parse.urlencode(filters)) or []
    if not isinstance(rows, list):
        rows = []

    liked = _rest(
        "GET",
        "feedback_likes?"
        + urllib.parse.urlencode({"select": "thread_id", "author_id": f"eq.{me}"}),
    )
    liked_ids = {
        str(item.get("thread_id") or "")
        for item in (liked if isinstance(liked, list) else [])
    }

    threads = [_thread_out(row, me, liked_ids) for row in rows if isinstance(row, dict)]
    if sort == "top":
        # Stable sort: threads with equal votes keep the server's activity order.
        threads.sort(key=lambda item: -item["like_count"])
    return {"threads": threads}


@router.get("/feedback/threads/{thread_id}")
def get_thread(thread_id: str):
    """One thread plus its replies, oldest reply first."""
    me = str(load_profile().get("author_id") or "")
    rows = _rest(
        "GET",
        "feedback_threads?"
        + urllib.parse.urlencode(
            {"select": _THREAD_COLUMNS, "id": f"eq.{thread_id}", "limit": "1"}
        ),
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=404, detail="This feedback no longer exists.")

    liked = _rest(
        "GET",
        "feedback_likes?"
        + urllib.parse.urlencode(
            {
                "select": "thread_id",
                "thread_id": f"eq.{thread_id}",
                "author_id": f"eq.{me}",
            }
        ),
    )
    liked_ids = {
        str(item.get("thread_id") or "")
        for item in (liked if isinstance(liked, list) else [])
    }

    replies = _rest(
        "GET",
        "feedback_replies?"
        + urllib.parse.urlencode(
            {
                "select": _REPLY_COLUMNS,
                "thread_id": f"eq.{thread_id}",
                "order": "created_at.asc",
            }
        ),
    )
    return {
        "thread": _thread_out(rows[0], me, liked_ids),
        "replies": [
            _reply_out(row, me)
            for row in (replies if isinstance(replies, list) else [])
            if isinstance(row, dict)
        ],
    }


@router.post("/feedback/threads")
def create_thread(payload: ThreadCreate):
    """Post a new feedback topic."""
    profile = load_profile()
    title = _text(payload.title, "Title", max_length=MAX_TITLE_LENGTH)
    body = _text(payload.body, "Body", max_length=MAX_BODY_LENGTH)
    me = str(profile.get("author_id") or "")
    rows = _rest(
        "POST",
        "feedback_threads",
        payload={
            "title": title,
            "body": body,
            "category": _choice(payload.category, "Category", CATEGORIES, "other"),
            "author_id": me,
            "author_name": str(profile.get("nickname") or "")[:MAX_NICKNAME_LENGTH],
            "app_version": APP_VERSION,
            "attachments": _attachments_in(payload.attachments),
        },
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=502, detail="Could not post the feedback. Try again.")
    return _thread_out(rows[0], me, set())


@router.put("/feedback/threads/{thread_id}")
def update_thread(thread_id: str, payload: ThreadUpdate):
    """Edit a topic (title/body/category) or flip its status — author only."""
    me = str(load_profile().get("author_id") or "")
    changes: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if payload.title is not None:
        changes["title"] = _text(payload.title, "Title", max_length=MAX_TITLE_LENGTH)
    if payload.body is not None:
        changes["body"] = _text(payload.body, "Body", max_length=MAX_BODY_LENGTH)
    if payload.category is not None:
        changes["category"] = _choice(payload.category, "Category", CATEGORIES, "other")
    if payload.status is not None:
        changes["status"] = _choice(payload.status, "Status", STATUSES, "open")
    if len(changes) == 1:  # only the timestamp -> nothing was asked for
        raise HTTPException(status_code=400, detail="Nothing to update.")

    rows = _rest(
        "PATCH",
        "feedback_threads?"
        + urllib.parse.urlencode({"id": f"eq.{thread_id}", "author_id": f"eq.{me}"}),
        payload=changes,
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        _require_thread(thread_id)
        raise HTTPException(status_code=403, detail="You can only edit your own feedback.")
    return _thread_out(rows[0], me, set())


@router.delete("/feedback/threads/{thread_id}")
def delete_thread(thread_id: str):
    """Delete a topic with its replies and votes — author only."""
    me = str(load_profile().get("author_id") or "")
    rows = _rest(
        "DELETE",
        "feedback_threads?"
        + urllib.parse.urlencode({"id": f"eq.{thread_id}", "author_id": f"eq.{me}"}),
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        _require_thread(thread_id)
        raise HTTPException(status_code=403, detail="You can only delete your own feedback.")
    return {"ok": True, "id": thread_id}


@router.post("/feedback/threads/{thread_id}/replies")
def create_reply(thread_id: str, payload: ReplyCreate):
    """Reply to a topic."""
    _require_thread(thread_id)
    profile = load_profile()
    body = _text(payload.body, "Reply", max_length=MAX_BODY_LENGTH)
    me = str(profile.get("author_id") or "")
    rows = _rest(
        "POST",
        "feedback_replies",
        payload={
            "thread_id": thread_id,
            "body": body,
            "author_id": me,
            "author_name": str(profile.get("nickname") or "")[:MAX_NICKNAME_LENGTH],
            "app_version": APP_VERSION,
            "attachments": _attachments_in(payload.attachments),
        },
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=502, detail="Could not post the reply. Try again.")
    return _reply_out(rows[0], me)


@router.delete("/feedback/replies/{reply_id}")
def delete_reply(reply_id: str):
    """Delete one reply — author only."""
    me = str(load_profile().get("author_id") or "")
    rows = _rest(
        "DELETE",
        "feedback_replies?"
        + urllib.parse.urlencode({"id": f"eq.{reply_id}", "author_id": f"eq.{me}"}),
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(
            status_code=403,
            detail="That reply does not exist, or you are not its author.",
        )
    return {"ok": True, "id": reply_id}


@router.post("/feedback/threads/{thread_id}/like")
def toggle_like(thread_id: str):
    """Toggle this machine's "same problem" vote on a topic."""
    _require_thread(thread_id)
    me = str(load_profile().get("author_id") or "")
    mine = _rest(
        "GET",
        "feedback_likes?"
        + urllib.parse.urlencode(
            {
                "select": "thread_id",
                "thread_id": f"eq.{thread_id}",
                "author_id": f"eq.{me}",
            }
        ),
    )
    if isinstance(mine, list) and mine:
        _rest(
            "DELETE",
            "feedback_likes?"
            + urllib.parse.urlencode(
                {"thread_id": f"eq.{thread_id}", "author_id": f"eq.{me}"}
            ),
        )
        liked = False
    else:
        _rest(
            "POST",
            "feedback_likes",
            payload={"thread_id": thread_id, "author_id": me},
            prefer="return=minimal",
        )
        liked = True

    all_votes = _rest(
        "GET",
        "feedback_likes?"
        + urllib.parse.urlencode({"select": "thread_id", "thread_id": f"eq.{thread_id}"}),
    )
    return {
        "liked": liked,
        "like_count": len(all_votes) if isinstance(all_votes, list) else 0,
    }


@router.post("/feedback/attachments")
async def upload_attachment(file: UploadFile = File(...)):
    """Upload one screenshot/log to the feedback bucket and return its URL."""
    filename = (file.filename or "attachment").strip()
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ATTACHMENT_TYPES:
        allowed = ", ".join(sorted(ATTACHMENT_TYPES))
        raise HTTPException(
            status_code=400, detail=f"Unsupported file type. Allowed: {allowed}"
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The file is empty.")
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=400, detail="Attachments are limited to 10 MB each.")

    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.splitext(filename)[0]).strip("-._")
    stem = (stem or "file")[:60]
    now = datetime.now(timezone.utc)
    object_path = f"{now:%Y/%m}/{uuid.uuid4().hex}-{stem}{extension}"
    supplied_type = (file.content_type or "").strip()
    content_type = (
        supplied_type
        if supplied_type
        and supplied_type != "application/octet-stream"
        and supplied_type.startswith(("image/", "text/", "application/"))
        else ""
    ) or mimetypes.guess_type(filename)[0] or ATTACHMENT_TYPES[extension]

    key = anon_key()
    _send(
        "POST",
        _storage_url(object_path, public=False),
        raw,
        {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": content_type,
            "x-upsert": "false",
        },
        UPLOAD_TIMEOUT_SECONDS,
    )
    return {
        "url": _storage_url(object_path, public=True),
        "name": filename[:120],
        "size": len(raw),
        "type": content_type,
    }
