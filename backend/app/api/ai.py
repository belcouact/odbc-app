"""AI assistant endpoints: settings, LLM connectivity test, NL-to-SQL, summaries.

Uses only the Python standard library (``urllib.request``) so the packaged EXE
stays dependency-light. Settings are stored in ``ai_settings.json``.
"""
import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import keystore, logging_utils, storage
from app.db import odbc
from app.db.sql_builder import detect_dbms, resolve_dbms

router = APIRouter()

_AI_SETTINGS_FILE = "ai_settings.json"

_DEFAULT_SETTINGS = {
    # AI ships on by default. A value saved in ai_settings.json still wins, so
    # this only affects fresh installs and configs that never saved the switch.
    "enabled": True,
    "provider": "openai",
    "base_url": "https://api.openai.com/v1/chat/completions",
    "api_key": "",
    "model": "gpt-5.6-luna",
    "temperature": 0.2,
}

# API keys kept per "brand · model" label, alongside the key in effect. A key
# belongs to one brand and model, so filing them by label keeps the key of a
# brand the user switched away from — and stops that key from being offered back
# as if it were the current brand's.
_KEYRING_FIELD = "saved_keys"

# Snapshots of previously saved configurations (one per "brand · model" label)
# so the settings page can list them in a dropdown and re-load any of them.
_SAVED_PROFILES_FIELD = "saved_profiles"
_SAVED_PROFILES_CAP = 20

# API keys live in the OS keyring (Windows Credential Manager), never in
# ai_settings.json. One account per scope: the key in effect, one per saved
# "brand · model" key label, and one per saved configuration snapshot.
_AI_KEY_ACCOUNT = "ai:api_key"


def _key_account(label: str) -> str:
    return f"ai:key:{label}"


def _profile_account(label: str) -> str:
    return f"ai:profile:{label}"

_NOT_CONFIGURED_MSG = "AI is not configured. Set up AI in the AI Setting page."

# Some LLM gateways sit behind Cloudflare and reject the default Python
# User-Agent with HTTP 403 (error code 1010). A normal browser signature is
# sent so those endpoints accept the request.
_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
}

# The AI chat endpoints rebuild the schema summary on every turn, which opens up
# to ~11 database connections (one table listing + one per table's columns).
# Cache it briefly per connection so repeated turns (e.g. clicking Explain /
# Optimize several times, or refining a script) don't re-query the database —
# this is a major latency win over remote ODBC / Access links.
_SCHEMA_CACHE: dict[str, tuple[float, list[str]]] = {}
_SCHEMA_CACHE_TTL_S = 300.0


def _load_settings() -> dict:
    """Load AI settings, merged over the defaults (missing keys stay default).

    API keys are stored in the OS keyring; plaintext keys found in
    ``ai_settings.json`` (written by older builds) are migrated there on first
    load and scrubbed from the file. The returned dict carries the real key
    values (re-read from the keyring) for the AI calls and the settings page.
    """
    saved = storage.load_json(_AI_SETTINGS_FILE, {}) or {}
    settings = dict(_DEFAULT_SETTINGS)
    settings.update({k: saved[k] for k in _DEFAULT_SETTINGS if k in saved})
    saved_keys = saved.get(_KEYRING_FIELD)
    saved_keys = dict(saved_keys) if isinstance(saved_keys, dict) else {}
    profiles = saved.get(_SAVED_PROFILES_FIELD)
    profiles = [p for p in profiles if isinstance(p, dict)] if isinstance(profiles, list) else []

    # One-time migration: move any plaintext keys into the OS keyring.
    migrated = False
    if settings.get("api_key"):
        keystore.set_secret(_AI_KEY_ACCOUNT, str(settings["api_key"]))
        migrated = True
    for label, key in list(saved_keys.items()):
        if key:
            keystore.set_secret(_key_account(str(label)), str(key))
            migrated = True
    for profile in profiles:
        if profile.get("api_key"):
            keystore.set_secret(
                _profile_account(str(profile.get("label") or "")), str(profile["api_key"])
            )
            migrated = True

    # Swap on-disk secrets for keyring lookups.
    settings["api_key"] = keystore.get_secret(_AI_KEY_ACCOUNT) or ""
    settings[_KEYRING_FIELD] = {
        str(label): keystore.get_secret(_key_account(str(label))) or ""
        for label in saved_keys
    }
    for profile in profiles:
        profile["api_key"] = keystore.get_secret(
            _profile_account(str(profile.get("label") or ""))
        ) or ""
    settings[_SAVED_PROFILES_FIELD] = profiles

    if migrated:
        _save_settings(settings)
        logging_utils.log_info("ai.settings", "migrated stored API keys into the OS keyring")
    return settings


def _save_settings(settings: dict) -> None:
    """Persist settings; API keys go to the OS keyring, never to the JSON file.

    The JSON keeps the label structure (saved key labels, saved profiles) with
    empty key values so ordering and listing still work; an emptied key deletes
    the keyring entry. ``settings`` is not modified — the caller keeps its real
    key values.
    """
    current = str(settings.get("api_key") or "")
    if current:
        keystore.set_secret(_AI_KEY_ACCOUNT, current)
    else:
        keystore.delete_secret(_AI_KEY_ACCOUNT)
    clean_keys = {}
    for label, key in (settings.get(_KEYRING_FIELD) or {}).items():
        label = str(label)
        if key:
            keystore.set_secret(_key_account(label), str(key))
        else:
            keystore.delete_secret(_key_account(label))
        clean_keys[label] = ""
    clean_profiles = []
    for profile in settings.get(_SAVED_PROFILES_FIELD) or []:
        if not isinstance(profile, dict):
            continue
        entry = dict(profile)
        key = str(entry.get("api_key") or "")
        label = str(entry.get("label") or "")
        if key:
            keystore.set_secret(_profile_account(label), key)
        else:
            keystore.delete_secret(_profile_account(label))
        entry["api_key"] = ""
        clean_profiles.append(entry)
    storage.save_json(
        _AI_SETTINGS_FILE,
        {
            **{k: v for k, v in settings.items() if k != "api_key"},
            _KEYRING_FIELD: clean_keys,
            _SAVED_PROFILES_FIELD: clean_profiles[:_SAVED_PROFILES_CAP],
        },
    )


def _upsert_saved_profile(settings: dict, label: str, fields: dict) -> None:
    """Record a saved configuration snapshot so it can be re-loaded later.

    Profiles are keyed by ``label`` (usually "brand · model"): saving the same
    label again refreshes its snapshot instead of growing the list. Newest
    first, capped so the file cannot grow without bound.
    """
    from datetime import datetime, timezone

    profiles = [
        p for p in (settings.get(_SAVED_PROFILES_FIELD) or []) if isinstance(p, dict)
    ]
    entry = {
        "label": label or str(fields.get("model") or "saved setting"),
        "enabled": bool(settings.get("enabled")),
        "provider": str(fields.get("provider") or ""),
        "base_url": str(fields.get("base_url") or ""),
        "api_key": str(fields.get("api_key") or ""),
        "model": str(fields.get("model") or ""),
        "temperature": fields.get("temperature", settings.get("temperature", 0.2)),
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    profiles = [p for p in profiles if p.get("label") != entry["label"]]
    profiles.insert(0, entry)
    settings[_SAVED_PROFILES_FIELD] = profiles[:_SAVED_PROFILES_CAP]


def _get_connection(connection_id: str) -> dict:
    """Look up a stored connection, raising 404 when it does not exist."""
    from app.main import get_stored_connection  # deferred to avoid import cycle

    return get_stored_connection(connection_id)


def _require_configured(settings: dict) -> None:
    # An API key is not mandatory: keyless endpoints (e.g. local Ollama) work
    # without one. Only the master switch decides whether AI is on.
    if not settings.get("enabled"):
        raise HTTPException(status_code=409, detail=_NOT_CONFIGURED_MSG)


def _is_anthropic(settings: dict) -> bool:
    """True when the configured provider uses Anthropic's Messages API."""
    return str(settings.get("provider") or "").strip().lower() == "anthropic"


def _endpoint_url(settings: dict) -> str:
    """Return the configured endpoint URL exactly as entered.

    Nothing is ever appended — the user is expected to provide the complete
    endpoint (e.g. ``https://api.openai.com/v1/chat/completions`` for
    OpenAI-compatible APIs or ``https://api.anthropic.com/v1/messages``).
    """
    return str(settings.get("base_url") or "").strip().rstrip("/")


_THINK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)


def _strip_think(text: str) -> str:
    """Remove inline ``<think>...</think>`` reasoning blocks some models emit.

    A leading unclosed ``<think>`` tag means only reasoning was produced (the
    budget ran out mid-thought) — drop everything from the tag onward so the
    empty-reply retry logic can kick in instead of showing raw thinking.
    """
    text = _THINK_RE.sub("", text or "")
    idx = text.lower().find("<think>")
    if idx != -1:
        text = text[:idx]
    return text.strip()


def _post_json(url: str, body: dict, headers: dict, timeout: float = 300.0) -> dict:
    """POST JSON and return the parsed response body.

    Raises HTTPException(400) with a readable message on transport or API
    errors (the failing URL is included so connection problems are debuggable).
    """
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={**_DEFAULT_HEADERS, **headers},
        method="POST",
    )
    try:
        # LLM endpoints can take a while to answer (long context, slow model);
        # a generous read timeout avoids cutting off valid responses.
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        snippet = exc.read().decode("utf-8", errors="replace")[:300]
        raise HTTPException(
            status_code=400,
            detail=(
                f"AI request failed: HTTP {exc.code} {exc.reason} (URL: {url}) "
                f"- {snippet}".strip()
            ),
        ) from exc
    except urllib.error.URLError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"AI request failed: {exc.reason} (URL: {url})",
        ) from exc
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(
            status_code=400, detail=f"AI request failed: {exc} (URL: {url})"
        ) from exc


def _chat_completion(settings: dict, messages: list, max_tokens: int = 600) -> str:
    """Call the configured LLM endpoint; return the generated text.

    OpenAI-compatible endpoints use ``/chat/completions``; Anthropic uses its
    Messages API. An API key is optional for both — it is sent only when
    present, so keyless endpoints (e.g. local Ollama) also work.
    """
    url = _endpoint_url(settings)
    api_key = settings.get("api_key") or ""

    def _call(msgs: list, tokens: int) -> tuple[str, bool]:
        """POST once and return ``(reply_text, truncated)``.

        ``reply_text`` is '' when the model said nothing. ``truncated`` is True
        when the endpoint stopped because it hit the token ceiling
        (finish_reason ``length`` / Anthropic ``max_tokens``), meaning the text
        is cut off mid-answer and a larger budget should be tried.
        """
        if _is_anthropic(settings):
            headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
            if api_key:
                headers["x-api-key"] = api_key
            system = "\n".join(
                str(m.get("content", "")) for m in msgs if m.get("role") == "system"
            )
            body: dict = {
                "model": settings.get("model"),
                "max_tokens": tokens,
                "temperature": settings.get("temperature", 0.2),
                "messages": [
                    {"role": m["role"], "content": str(m["content"])}
                    for m in msgs
                    if m.get("role") != "system"
                ],
            }
            if system:
                body["system"] = system
            payload = _post_json(url, body, headers)
            try:
                # Join every text block; extended-thinking responses prepend
                # non-text (thinking) blocks that must be skipped, not used.
                text = "\n".join(
                    str(b.get("text") or "")
                    for b in payload["content"]
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            except (KeyError, IndexError, TypeError) as exc:
                raise HTTPException(
                    status_code=400, detail=f"AI response parse error: {exc}"
                ) from exc
            # Anthropic reports a token-limit stop as ``stop_reason='max_tokens'``.
            return _strip_think(text), payload.get("stop_reason") == "max_tokens"

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        body = {
            "model": settings.get("model"),
            "messages": msgs,
            "temperature": settings.get("temperature", 0.2),
            "max_tokens": tokens,
        }
        payload = _post_json(url, body, headers)
        try:
            choice = payload["choices"][0]
            message = choice.get("message") or {}
            finish = choice.get("finish_reason")
            content = message.get("content")
        except (KeyError, IndexError, TypeError) as exc:
            raise HTTPException(
                status_code=400, detail=f"AI response parse error: {exc}"
            ) from exc
        # `content` may be null (reasoning-style models) or an empty string;
        # treat both as an empty reply so the retry logic below kicks in.
        text = content.strip() if isinstance(content, str) else ""
        if not text and finish != "length":
            # Gateways for reasoning models sometimes deliver the visible
            # answer in `reasoning_content` while `content` stays null — use
            # it rather than discarding a real reply. A "length" finish means
            # the budget was exhausted mid-reasoning; that text is an
            # unfinished thought, so fall through to the (larger) retry.
            reasoning = message.get("reasoning_content") or message.get("reasoning")
            if isinstance(reasoning, str) and reasoning.strip():
                text = _strip_think(reasoning)
                logging_utils.log_warning(
                    "ai.chat_completion",
                    "empty content; used reasoning_content as reply",
                    details=f"finish_reason={finish}",
                )
        if not text:
            # Empty replies are hard to diagnose after the fact; log what the
            # endpoint said (finish_reason + usage) to the app log.
            usage = payload.get("usage") or {}
            logging_utils.log_warning(
                "ai.chat_completion",
                "empty completion from endpoint",
                details=(
                    f"model={payload.get('model')}, finish_reason={finish}, "
                    f"prompt_tokens={usage.get('prompt_tokens')}, "
                    f"completion_tokens={usage.get('completion_tokens')}"
                ),
            )
        return _strip_think(text), finish == "length"

    # The upstream endpoint occasionally returns an empty completion (empty or
    # null ``content``) or one cut off by the token ceiling. Retry twice,
    # doubling the token budget each time — reasoning-style models can spend the
    # entire budget on hidden thinking and answer with a null `content`
    # (finish_reason "length") — and append a nudge on the last attempt that
    # explicitly instructs the model to produce output.
    nudge = {
        "role": "user",
        "content": (
            "\n\nYour previous response was empty. You MUST reply now with the complete "
            "answer. If a script or SQL was requested, output it inside a single markdown "
            "code block. Never send an empty message."
        ),
    }
    tokens = int(max_tokens)
    last_reply = ""
    for attempt in range(3):
        if attempt > 0:
            time.sleep(2)
            tokens = min(tokens * 2, 16384)
        reply, truncated = _call(messages + [nudge] if attempt == 2 else messages, tokens)
        if reply:
            last_reply = reply
            if not truncated:
                return reply
            # A truncated reply is incomplete (e.g. Python code cut off
            # mid-statement). Keep it as a fallback and retry with more room.
            logging_utils.log_warning(
                "ai.chat_completion",
                "response hit the token limit; retrying with a larger budget",
                details=f"attempt={attempt + 1}, tokens={tokens}",
            )
    if last_reply:
        return last_reply
    raise HTTPException(
        status_code=502,
        detail="The AI returned an empty response. Please try again.",
    )


def _stream_chat_completion(
    settings: dict, messages: list, max_tokens: int = 600
) -> Iterator[str]:
    """Call the configured LLM endpoint with streaming enabled; yield text deltas.

    Parses server-sent events from both OpenAI-compatible endpoints
    (``choices[0].delta.content``) and Anthropic Messages streams
    (``content_block_delta``). Transport or API errors raise HTTPException.
    Callers must fall back to ``_chat_completion`` when nothing is yielded
    (some endpoints ignore ``stream: true`` and answer in one JSON body).
    """
    url = _endpoint_url(settings)
    api_key = settings.get("api_key") or ""
    anthropic = _is_anthropic(settings)

    if anthropic:
        headers = {
            "Content-Type": "application/json",
            "accept": "text/event-stream",
            "anthropic-version": "2023-06-01",
        }
        if api_key:
            headers["x-api-key"] = api_key
        system = "\n".join(
            str(m.get("content", "")) for m in messages if m.get("role") == "system"
        )
        body: dict = {
            "model": settings.get("model"),
            "max_tokens": max_tokens,
            "temperature": settings.get("temperature", 0.2),
            "stream": True,
            "messages": [
                {"role": m["role"], "content": str(m["content"])}
                for m in messages
                if m.get("role") != "system"
            ],
        }
        if system:
            body["system"] = system
    else:
        headers = {"Content-Type": "application/json", "accept": "text/event-stream"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        body = {
            "model": settings.get("model"),
            "messages": messages,
            "temperature": settings.get("temperature", 0.2),
            "max_tokens": max_tokens,
            "stream": True,
        }

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={**_DEFAULT_HEADERS, **headers},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=300.0)
    except urllib.error.HTTPError as exc:
        snippet = exc.read().decode("utf-8", errors="replace")[:300]
        raise HTTPException(
            status_code=400,
            detail=(
                f"AI request failed: HTTP {exc.code} {exc.reason} (URL: {url}) "
                f"- {snippet}".strip()
            ),
        ) from exc
    except urllib.error.URLError as exc:
        raise HTTPException(
            status_code=400, detail=f"AI request failed: {exc.reason} (URL: {url})"
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=400, detail=f"AI request failed: {exc} (URL: {url})"
        ) from exc

    reasoning_parts: list[str] = []
    produced_text = False
    finished_stop = False
    with resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if not data:
                continue
            if data == "[DONE]":
                break
            try:
                evt = json.loads(data)
            except json.JSONDecodeError:
                continue
            if anthropic:
                evt_type = evt.get("type")
                if evt_type == "content_block_delta":
                    delta = evt.get("delta") or {}
                    text = delta.get("text") or ""
                    if text:
                        produced_text = True
                        yield text
                elif evt_type == "error":
                    err = evt.get("error") or {}
                    raise HTTPException(
                        status_code=400,
                        detail=f"AI stream error: {err.get('message', evt)}",
                    )
            else:
                if evt.get("error"):
                    err = evt["error"]
                    msg = err.get("message") if isinstance(err, dict) else str(err)
                    raise HTTPException(
                        status_code=400, detail=f"AI stream error: {msg}"
                    )
                choices = evt.get("choices") or []
                if choices:
                    delta = choices[0].get("delta") or {}
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        produced_text = True
                        yield content
                    elif delta.get("reasoning_content"):
                        # Buffer hidden-reasoning deltas; only surfaced below
                        # when the model never produces visible content.
                        reasoning_parts.append(str(delta["reasoning_content"]))
                    if choices[0].get("finish_reason") == "stop":
                        finished_stop = True
    # Reasoning gateways may stream only `reasoning_content` and never emit
    # `content`; surface the buffered text so the reply is not empty. When the
    # stream ended without a clean stop (e.g. token budget exhausted), yield
    # nothing so callers fall back to the non-streaming retry path.
    if not produced_text and finished_stop:
        text = _strip_think("".join(reasoning_parts))
        if text:
            yield text


def _strip_code_fences(text: str) -> str:
    """Remove a surrounding markdown code fence (```sql ... ```) if present."""
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def _describe_schema(conn: dict) -> list[str]:
    """Summarize the first 25 tables (columns of the first 10) for prompts."""
    tables = odbc.list_tables(conn)[:25]
    parts: list[str] = []
    for table in tables[:10]:
        try:
            cols = odbc.list_columns(conn, table["name"])
            parts.append(f"{table['name']}({', '.join(c['name'] for c in cols)})")
        except Exception:  # noqa: BLE001 - keep going if one table fails
            parts.append(table["name"])
    return parts


def _cached_describe_schema(conn: dict, connection_id: Optional[str]) -> list[str]:
    """Return a schema summary, cached per connection for a few minutes.

    ``_describe_schema`` opens up to ~11 database connections per call and is
    invoked on every chat/script turn, so without a cache repeated turns keep
    re-querying the database. The live value (and a first build) still happens;
    only the re-querying across turns is avoided.
    """
    now = time.time()
    if connection_id:
        cached = _SCHEMA_CACHE.get(connection_id)
        if cached and now - cached[0] < _SCHEMA_CACHE_TTL_S:
            return cached[1]
    summary = _describe_schema(conn)
    if connection_id:
        _SCHEMA_CACHE[connection_id] = (now, summary)
    return summary


def _grid_column_names(columns: list) -> list[str]:
    """Extract column names from the grid output metadata.

    Accepts plain strings or ``{"name": ...}`` dicts so both callers work.
    """
    names: list[str] = []
    for col in columns:
        if isinstance(col, dict):
            name = col.get("name")
        else:
            name = col
        if name is not None:
            names.append(str(name))
    return names


# Shared behavior: ask before acting when key details are missing. Used by the
# SQL, script and chart assistant prompts so every AI surface clarifies first.
_CLARIFY_POLICY = (
    "CLARIFY-FIRST POLICY: If anything needed to do the task well is unclear or "
    "missing — e.g. which table or columns to use, filter conditions, date ranges, "
    "units, grouping or aggregation level, expected output shape, chart type or "
    "axes — do NOT guess. Ask 1-3 short, specific clarifying questions in plain "
    "text INSTEAD of producing SQL/code, and stop; wait for the user's answers, "
    "then produce the result. Ask only when the answers genuinely matter; if the "
    "request is reasonably clear, act immediately without questions. If the user "
    "tells you to just proceed or to assume, give a best-effort result and state "
    "your assumptions in one short line. Never reply with an empty message."
)

_GENERAL_ASSISTANT_SYSTEM_PROMPT = (
    "You are a helpful general-purpose assistant built into a desktop ODBC query "
    "tool used by quality/process engineers. Answer any question the user asks — "
    "general knowledge, explanations, data interpretation, calculations, writing, "
    "SQL/data concepts, or how to use this app. Be direct and concise: lead with "
    "the answer, then add only the detail that is needed, using short paragraphs "
    "or bullet lists. Use markdown (tables, fenced code blocks) when it makes the "
    "answer clearer. If the request is genuinely ambiguous, ask one short "
    "clarifying question instead of guessing. Never reply with an empty message."
)

_SQL_ASSISTANT_SYSTEM_PROMPT = (
    "You are a SQL expert and data-analysis assistant for quality/process engineers. "
    "When the user asks you to write or modify SQL, respond with ONLY one read-only SQL "
    "statement (SELECT/WITH) inside a single markdown code block (```sql ... ```) and "
    "nothing outside it. When the user asks you to EXPLAIN a query, describe its purpose, "
    "the main clauses, joins, filters and aggregations in concise plain text (no code block). "
    "When the user asks you to OPTIMIZE a query, briefly list the main performance issues "
    "(e.g. SELECT *, filters applied late, functions on indexed columns, redundant joins) "
    "in a few short bullets, then output ONLY the full optimized read-only query inside a "
    "single ```sql code block. You may also debug SQL errors or answer questions about the "
    "data directly and concisely in plain text. Keep every answer tight — no filler. "
    + _CLARIFY_POLICY
)

_SCRIPT_CHART_POLICY = (
    "CHARTING — when a chart, plot, graph or visualization is requested, use ECharts and "
    "deliver it as a self-contained HTML file. Never use matplotlib/plotly/seaborn (not "
    "available in this environment) and never draw ASCII charts:\n"
    "1. Write the HTML to a relative path (e.g. `chart.html`): the app saves the files a "
    "script writes and lists them in the output panel, so the user can open it in a browser. "
    "Print that path too.\n"
    "2. Python: embed the ECharts library bundled with the app — "
    "`from app.resources.echarts import get_echarts_js`, then inject `get_echarts_js()` "
    "inside a <script> tag of the generated page (replace any '</script' in it with "
    "'<\\/script' so the tag cannot close early); fall back to the jsDelivr ECharts CDN if "
    "that import fails.\n"
    "3. JavaScript: load ECharts from the jsDelivr CDN inside the generated page "
    "(https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js).\n"
    "4. Serialize the series and categories computed from `data` into the page as JSON and "
    "build a real ECharts option object there (title, tooltip, legend, axis labels, xAxis, "
    "yAxis, series) — never hard-code values copied from the sample row.\n"
    "5. The script itself only computes the data and writes the file; `echarts.init` and "
    "`setOption` are called inside the generated page, not in the script.\n"
    "6. When the request needs both numbers and a chart, print the numbers and also write "
    "the chart HTML."
)

_SCRIPT_ASSISTANT_SYSTEM_PROMPT = (
    "You are a data-scripting expert for quality/process engineers. "
    "When the user asks for a script (Python or JavaScript), respond with ONLY one complete "
    "script inside a single markdown code block and nothing outside it. The script receives "
    "the queried rows in a variable named `data` (a list of row dicts; values may be numbers, "
    "strings, dates, or None). Python: standard library only (no external packages). "
    "JavaScript: Node.js built-ins only (require is available). "
    "Print results with print(...) / console.log(...) so the output is visible. "
    "For any other question, answer directly and concisely in plain text. "
    + _SCRIPT_CHART_POLICY
    + " "
    + _CLARIFY_POLICY
)

_ECHART_ASSISTANT_SYSTEM_PROMPT = (
    "You are an ECharts expert and a data-visualization assistant for quality/process engineers. "
    "You can both build charts AND converse normally. Decide per request:\n"
    "- If the user asks to CREATE, DESCRIBE, MODIFY or ADD a chart/visualization, or asks for "
    "a chart in any form, write JavaScript code and output ONLY the code inside a single markdown "
    "code block; nothing outside it.\n"
    "- For any other question (general chat, asking about the data, explaining chart concepts, "
    "recommending a chart type, etc.), answer directly and concisely in plain text — do NOT output "
    "code.\n"
    "Chart-code rules:\n"
    "1. Assign the final option object to a variable named `option` (e.g. `option = {...}`).\n"
    "2. Do not import anything and do NOT call echarts.init or echarts.setOption — "
    "echarts is available as a global.\n"
    "3. Use valid ECharts option syntax: title, tooltip, legend, xAxis, yAxis, series.\n"
    "4. Give the chart a meaningful title, a clear legend and a pleasant color palette.\n"
    "5. The full dataset is available at runtime in a global variable named `rows` — an array of "
    "objects keyed by the column header names listed in 'Available columns'.\n"
    "6. DATA MAPPING (mandatory): build every chart value by referencing the column header names, "
    "e.g. `[...new Set(rows.map(r => r['REGION']))]` for categories or `rows.map(r => r['SALES'])` "
    "for values; group/aggregate with Array.reduce or similar when needed. NEVER embed raw data "
    "into the script: do not paste arrays of categories or numbers copied from the data. The script "
    "must stay compact regardless of how many rows exist.\n"
    "7. The sample rows are for understanding value types/format only — do NOT copy their values "
    "into the script.\n"
    "8. The user may edit the script afterwards to tweak the title, colors, axes, etc.\n"
    + _CLARIFY_POLICY
)

# Chart families and aggregations the dashboard assistant may return. Kept in
# sync with frontend/src/utils/chartCatalog.ts so a spec the model proposes can
# always be rendered by the shared buildVisualChart pipeline.
_DASHBOARD_CHART_TYPES = {
    "trend", "stepline", "area", "stackarea", "bar", "stackbar", "combo",
    "pie", "doughnut", "rose", "radar", "pareto", "waterfall", "funnel",
    "treemap", "heatmap", "histogram", "scatter", "bubble", "trendline",
    "errorbar", "spc", "sankey", "box", "gauge", "kpi",
}
_DASHBOARD_OPERATIONS = {
    "sum", "mean", "count", "distinct", "min", "max", "median", "std", "var",
    "first", "last", "p25", "p75", "p90", "share", "none",
}
_DASHBOARD_MAX_CHARTS = 6

_DASHBOARD_ASSISTANT_SYSTEM_PROMPT = (
    "You are a data-visualization expert for quality/process engineers. The user "
    "describes the dashboard they want; you design 3 to 6 charts that answer it.\n"
    "Respond with ONLY a JSON array (no markdown, no code fences, no commentary) of "
    "chart specification objects. Each object has these keys:\n"
    '  "chartType": a supported chart family key (e.g. bar, trend, area, stackbar, pie, doughnut, scatter, bubble, kpi).\n'
    '  "x": the category/axis column name, exactly as listed in Available columns.\n'
    '  "y": an array of one or more measure column names from Available columns.\n'
    '  "operation": aggregation for y (sum, mean, count, min, max, distinct, median, std, none).\n'
    '  "series": optional breakdown column for a color-by legend.\n'
    '  "title": optional short chart title.\n'
    '  "subtitle": optional one-line description.\n'
    "Rules:\n"
    "1. ONLY use column names that appear in Available columns — never invent or "
    "copy values from the sample rows.\n"
    "2. Pick chart types that suit the data (e.g. trend/area for time series, "
    "bar/stackbar for comparisons, pie/doughnut for shares, scatter/bubble for "
    "correlations, kpi for headline numbers). Use several complementary charts so "
    "the dashboard tells a complete story.\n"
    "3. Prefer aggregations (sum/mean/count/...) over raw values when a category is "
    'grouped; use operation "none" only for scatter/bubble/trendline.\n'
    "4. Give every chart a clear, specific title.\n"
    "5. Place every chart's legend at the bottom of the chart.\n"
    "6. Output valid JSON only — double quotes, no trailing commas, no extra text."
)

_STATS_ASSISTANT_SYSTEM_PROMPT = (
    "You are a data-analysis expert for quality/process engineers. Write ONE "
    "self-contained Python script that statistically analyses the provided rows and "
    "prints a clear, well-structured report.\n"
    "Rules:\n"
    "1. The rows are already available in a variable named `data` (a list of dicts "
    "keyed by the column names). Do NOT read files, access the network, or import "
    "anything outside the Python standard library (statistics, math, collections, "
    "json, datetime, itertools, functools are fine).\n"
    "2. Run the analysis directly — do not wrap it in an unused main guard.\n"
    "3. Be defensive: values may be None, strings, numbers or dates. Coerce numeric "
    "columns with float()/int() inside try/except and skip non-numeric entries. Never "
    "let a single bad value crash the script.\n"
    "4. Cover what the data supports: row/column inventory, missing-value counts, "
    "numeric descriptive statistics (count, mean, median, std, min, max, quartiles), "
    "outliers and distributions, and the most frequent categories for categorical "
    "columns. If the user states a focus, prioritise that analysis.\n"
    "5. Print a readable plain-text report with short section headers (e.g. "
    "'=== Numeric summary ===') and aligned columns. Round numbers sensibly. "
    "Do NOT print HTML or markdown code fences.\n"
    "6. Output ONLY the Python script inside a single markdown code block; nothing "
    "outside it."
)


class SettingsUpdate(BaseModel):
    """Partial update body for PUT /ai/settings."""

    enabled: Optional[bool] = None
    provider: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    # The "brand · model" the submitted api_key belongs to, so the key is filed
    # under that brand/model instead of being kept only as the last one used.
    key_label: Optional[str] = None
    # The label the saved-configuration snapshot is filed under (same
    # "brand · model" string), so the settings dropdown can re-load it later.
    profile_label: Optional[str] = None


class TestRequest(BaseModel):
    """Body for POST /ai/test (optional overrides of saved settings)."""

    provider: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None


class NlToSqlRequest(BaseModel):
    """Body for POST /ai/nl-to-sql."""

    question: str
    connection_id: str


class SummaryRequest(BaseModel):
    """Body for POST /ai/summary."""

    stats: dict
    context: str = ""


class ChatTurn(BaseModel):
    """A single user/assistant turn in the script-assistant conversation."""

    role: str
    content: str


class ScriptGenRequest(BaseModel):
    """Body for POST /ai/script."""

    messages: list[ChatTurn]
    language: str = "python"
    connection_id: Optional[str] = None
    table: Optional[str] = None
    columns: Optional[list] = None


class ChatRequest(BaseModel):
    """Body for POST /ai/chat (continuous assistant conversation).

    ``mode`` selects the assistant specialty: ``sql`` (default), ``script``
    or ``chart``. ``rows`` is a sample of the grid data used only by the
    ``chart`` mode; ``sql`` is the SQL currently in the editor (``sql`` mode).
    """

    messages: list[ChatTurn]
    connection_id: Optional[str] = None
    table: Optional[str] = None
    columns: Optional[list] = None
    rows: Optional[list] = None
    mode: str = "sql"
    sql: Optional[str] = None


class EChartRequest(BaseModel):
    """Body for POST /ai/echart (AI-generated ECharts option script)."""

    requirement: str
    columns: Optional[list] = None
    rows: Optional[list] = None


class DashboardRequest(BaseModel):
    """Body for POST /ai/dashboard (AI-designed dashboard chart specs)."""

    requirement: str
    columns: Optional[list] = None
    rows: Optional[list] = None


class StatsRequest(BaseModel):
    """Body for POST /ai/stats (AI-written Python statistical report)."""

    columns: Optional[list] = None
    rows: Optional[list] = None
    requirement: str = ""


@router.get("/ai/settings")
def get_ai_settings():
    """Return the current AI settings."""
    return _load_settings()


@router.put("/ai/settings")
@router.post("/ai/settings")
def update_ai_settings(payload: SettingsUpdate):
    """Merge and persist AI settings (all fields optional)."""
    settings = _load_settings()
    fields = payload.model_dump(exclude_unset=True)
    label = fields.pop("key_label", None)
    profile_label = fields.pop("profile_label", None)
    settings.update(fields)
    if label and "api_key" in fields:
        keyring = dict(settings.get(_KEYRING_FIELD) or {})
        key = str(settings.get("api_key") or "").strip()
        if key:
            keyring[label] = key
        else:
            # An emptied key field is a deliberate removal for that brand/model.
            keyring.pop(label, None)
        settings[_KEYRING_FIELD] = keyring
    # A full configuration was submitted — snapshot it so the settings page's
    # dropdown can list and re-load it later.
    if "base_url" in fields and "model" in fields:
        _upsert_saved_profile(settings, str(profile_label or ""), fields)
    _save_settings(settings)
    return settings


@router.delete("/ai/settings/profile")
def delete_ai_settings_profile(label: str):
    """Remove one saved configuration snapshot from the settings dropdown.

    The API key filed under the same "brand · model" label is deliberately
    kept: it still applies if the user re-creates that endpoint configuration
    and saves it again.
    """
    settings = _load_settings()
    profiles = [
        p for p in (settings.get(_SAVED_PROFILES_FIELD) or []) if isinstance(p, dict)
    ]
    kept = [p for p in profiles if p.get("label") != label]
    if len(kept) == len(profiles):
        raise HTTPException(status_code=404, detail=f'No saved setting named "{label}"')
    settings[_SAVED_PROFILES_FIELD] = kept
    _save_settings(settings)
    return settings


@router.post("/ai/test")
def test_ai(payload: TestRequest):
    """Test connectivity to the LLM endpoint (never raises on AI errors).

    Failures are written to the application log so connection problems can be
    investigated later. The API key is optional (keyless local endpoints work).
    """
    settings = _load_settings()
    settings.update(payload.model_dump(exclude_unset=True))
    messages = [{"role": "user", "content": "Reply with the single word OK"}]
    try:
        resp = _chat_completion(settings, messages)
    except HTTPException as exc:
        logging_utils.log_warning("ai.test", "AI connection test failed", details=str(exc.detail))
        return {"ok": False, "message": str(exc.detail)}
    except Exception as exc:  # noqa: BLE001 - unexpected failures are reported
        logging_utils.log_warning("ai.test", "AI connection test failed", details=str(exc))
        return {"ok": False, "message": str(exc)}
    logging_utils.log_info("ai.test", "AI connection test succeeded")
    return {"ok": True, "message": resp.strip()}


@router.post("/ai/nl-to-sql")
def nl_to_sql(payload: NlToSqlRequest):
    """Translate a natural-language question into a read-only SELECT statement."""
    settings = _load_settings()
    _require_configured(settings)
    conn = _get_connection(payload.connection_id)
    dbms = resolve_dbms(conn, detect_dbms(conn))
    schema = _describe_schema(conn)

    system_prompt = (
        "You are a SQL expert writing read-only queries for a database. "
        "Respond with ONLY the SQL statement: no markdown, no code fences, "
        "no explanations, no trailing semicolon. This is a one-shot endpoint that "
        "cannot ask follow-up questions: if key details are missing (filters, date "
        "range, units, row limit), pick the most reasonable interpretation and "
        "state each assumption as a leading SQL comment line starting with '--' "
        "before the statement."
    )
    user_prompt = (
        f"Database DBMS: {dbms}\n"
        f"Available tables: {', '.join(schema) or '(none detected)'}\n"
        f"Question: {payload.question}\n"
        "Return only a read-only SELECT or WITH statement."
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    sql = _strip_code_fences(_chat_completion(settings, messages))
    try:
        odbc.assert_read_only(sql)
    except ValueError:
        corrective = (
            "Your previous answer was rejected as not read-only. "
            "Return only a read-only SELECT/WITH statement."
        )
        retry = _strip_code_fences(
            _chat_completion(
                settings,
                messages
                + [{"role": "assistant", "content": sql}, {"role": "user", "content": corrective}],
            )
        )
        try:
            odbc.assert_read_only(retry)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail=f"Generated SQL is not read-only: {exc}"
            ) from exc
        sql = retry
    return {"sql": sql, "dbms": dbms}


@router.post("/ai/summary")
def ai_summary(payload: SummaryRequest):
    """Produce a plain-language summary from analysis statistics."""
    settings = _load_settings()
    _require_configured(settings)
    stats_json = json.dumps(payload.stats, ensure_ascii=False, default=str)
    prompt = (
        "You are a data analyst. Given these statistics (JSON): "
        f"{stats_json} {payload.context}, write a concise plain-language summary: "
        "key findings, data-quality issues, outliers, and 3-5 actionable "
        "recommendations. Use bullet points."
    )
    text = _chat_completion(settings, [{"role": "user", "content": prompt}])
    return {"summary": text.strip()}


@router.post("/ai/script")
def generate_script(payload: ScriptGenRequest):
    """Generate a data-processing script from a conversational requirement.

    The assistant writes a single script that receives the queried rows in a
    variable named ``data`` (a list of dicts). The full conversation is sent
    each time so the user can refine the script over multiple turns.
    """
    settings = _load_settings()
    _require_configured(settings)
    language_label = (
        "Python" if payload.language != "javascript" else "JavaScript (Node.js)"
    )
    schema_lines: list[str] = []
    if payload.connection_id:
        try:
            conn = _get_connection(payload.connection_id)
            schema_lines = _cached_describe_schema(conn, payload.connection_id)
        except HTTPException:
            schema_lines = []
    if payload.table:
        schema_lines = [
            line for line in schema_lines if payload.table.lower() in line.lower()
        ]

    system_prompt = (
        f"You are a data-scripting expert. Write ONE {language_label} script that processes "
        "a list of row dicts already loaded in the variable `data` (each item is one row; "
        "values may be numbers, strings, dates, or None). "
        "Rules: output ONLY the script inside a single markdown code block, no text outside it; "
        "Python: standard library only (no external packages); "
        "JavaScript: Node.js built-ins only (require is available). "
        "Print results with print(...) / console.log(...) so the output is visible. "
        + _SCRIPT_CHART_POLICY
        + " "
        "CLARIFY-FIRST: if the requirement is unclear or missing details that would change "
        "the script (columns, filters, aggregation, output format), reply with 1-3 short "
        "clarifying questions in plain text (NO code block) and wait for answers; only write "
        "the script once the requirement is clear or the user tells you to assume."
    )
    user_context = ""
    if schema_lines:
        user_context = (
            "\n\nRelevant database columns for reference:\n" + "\n".join(schema_lines)
        )
    grid_columns = _grid_column_names(payload.columns or [])
    if grid_columns:
        user_context += (
            "\n\nThe columns of the query result currently loaded in the grid are:\n"
            + ", ".join(grid_columns)
        )
    messages = [{"role": "system", "content": system_prompt}] + [
        {"role": turn.role, "content": turn.content + user_context}
        if turn.role == "user"
        else {"role": turn.role, "content": turn.content}
        for turn in payload.messages
    ]
    _start = time.perf_counter()
    reply = _chat_completion(settings, messages, max_tokens=8192)
    _elapsed_ms = int((time.perf_counter() - _start) * 1000)
    logging_utils.log_info(
        "ai.script",
        f"language={payload.language} generated {len(reply)} chars",
        details=(
            f"language={payload.language}, turns={len(payload.messages)}, "
            f"grid_columns={len(grid_columns)}, elapsed_ms={_elapsed_ms}"
        ),
    )
    return {"script": _strip_code_fences(reply)}


class GridClarifyRequest(BaseModel):
    """Body for POST /ai/grid/clarify (pre-script clarifying questions)."""

    requirement: str
    columns: Optional[list] = None
    rows_sample: Optional[list] = None


class GridScriptRequest(BaseModel):
    """Body for POST /ai/grid/script (grid-transform script generation)."""

    requirement: str
    questions: Optional[list] = None
    answers: Optional[list] = None
    columns: Optional[list] = None
    rows_sample: Optional[list] = None


def _extract_question_array(text: str) -> list[str]:
    """Extract a JSON string array from an LLM reply (best effort).

    Falls back to an empty list when the model ignored the JSON-only
    instruction, so the flow continues to script generation instead of
    getting stuck on a parsing error.
    """
    match = re.search(r"\[[\s\S]*?\]", text or "")
    if not match:
        return []
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    questions = [str(item).strip() for item in parsed if str(item).strip()]
    return questions[:3]


def _extract_chart_array(text: str) -> list:
    """Extract a JSON array of chart-spec objects from an LLM reply.

    Uses ``raw_decode`` (not a non-greedy regex) because a naive ``\\[[\\s\\S]*?\\]``
    would stop at the first ``]`` — which is the close of the *inner* ``y`` array,
    not the outer list. Returns only the dict items; an empty list on failure.
    """
    text = _strip_code_fences(text or "")
    start = text.find("[")
    if start == -1:
        return []
    try:
        parsed, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _clean_chart_specs(raw: list, columns: list[str]) -> list[dict]:
    """Validate AI chart specs against the real columns and normalise the shape.

    Drops any spec whose chart type is unknown or whose x/y reference columns
    that do not exist (they would render an empty chart), so the frontend can
    feed the survivors straight into the VisualConfig pipeline.
    """
    known = set(columns)
    specs: list[dict] = []
    for item in raw:
        chart_type = str(item.get("chartType") or item.get("chart_type") or "").strip()
        if chart_type not in _DASHBOARD_CHART_TYPES:
            continue
        x = str(item.get("x") or "").strip()
        if not x or (known and x not in known):
            continue
        y_raw = item.get("y")
        if isinstance(y_raw, str):
            y_raw = [y_raw]
        if not isinstance(y_raw, list):
            y_raw = []
        ys = [str(col).strip() for col in y_raw if str(col).strip()]
        if known:
            ys = [col for col in ys if col in known]
        if not ys:
            continue
        operation = str(item.get("operation") or "").strip().lower()
        if operation not in _DASHBOARD_OPERATIONS:
            operation = "sum"
        series = str(item.get("series") or "").strip()
        if known and series and series not in known:
            series = ""
        title = str(item.get("title") or "").strip()
        subtitle = str(item.get("subtitle") or "").strip()
        spec = {
            "chartType": chart_type,
            "x": x,
            "y": ys,
            "operation": operation,
            "title": title or None,
            "subtitle": subtitle or None,
        }
        if series:
            spec["series"] = series
        specs.append(spec)
        if len(specs) >= _DASHBOARD_MAX_CHARTS:
            break
    return specs


def _grid_sample_context(columns: Optional[list], rows_sample: Optional[list]) -> tuple[list[str], str]:
    """Common prompt context: grid column names + a small JSON row sample."""
    grid_columns = _grid_column_names(columns or [])
    sample = (rows_sample or [])[:20]
    sample_json = json.dumps(sample, ensure_ascii=False, default=str)
    return grid_columns, sample_json


@router.post("/ai/grid/clarify")
def grid_clarify(payload: GridClarifyRequest):
    """Ask the model whether the grid-transformation requirement is ambiguous.

    Returns up to 3 clarifying questions the user should answer before a
    script is written; an empty list means "no questions — go ahead".
    """
    settings = _load_settings()
    _require_configured(settings)
    grid_columns, sample_json = _grid_sample_context(payload.columns, payload.rows_sample)
    prompt = (
        "You are helping a user transform a data grid with a short Python script.\n"
        f"Grid columns: {', '.join(grid_columns) or '(unknown)'}\n"
        f"Sample rows (JSON): {sample_json}\n\n"
        f"Requirement: {payload.requirement}\n\n"
        "Decide whether the requirement is ambiguous in a way that would change "
        "the script (e.g. units, matching/join rules, handling of missing values, "
        "name of new columns, rounding/format). If so, reply with ONLY a JSON array "
        "of up to 3 short clarifying questions, e.g. [\"...\", \"...\"]. "
        "If there is nothing meaningful to ask, reply with exactly []. "
        "No other text, no markdown."
    )
    _start = time.perf_counter()
    reply = _chat_completion(settings, [{"role": "user", "content": prompt}], max_tokens=600)
    _elapsed_ms = int((time.perf_counter() - _start) * 1000)
    questions = _extract_question_array(reply)
    logging_utils.log_info(
        "ai.grid.clarify",
        f"questions={len(questions)}",
        details=f"chars={len(reply)}, elapsed_ms={_elapsed_ms}",
    )
    return {"questions": questions}


@router.post("/ai/grid/script")
def grid_script(payload: GridScriptRequest):
    """Generate a Python script that transforms the grid rows in variable ``data``.

    The script may modify rows in place or reassign ``data``; the caller runs
    it via ``POST /scripts/grid-transform`` which returns the updated rows.
    """
    settings = _load_settings()
    _require_configured(settings)
    grid_columns, sample_json = _grid_sample_context(payload.columns, payload.rows_sample)
    system_prompt = (
        "You are a Python data-transformation expert. Write ONE Python script that "
        "transforms the rows of a data grid. The rows are already loaded in the "
        "variable `data` — a list of dicts (keys are column names; values are "
        "numbers, strings, booleans or None). Rules:\n"
        "1. Modify the rows in place or reassign `data` to the transformed list.\n"
        "2. Every value must stay JSON-serializable (numbers, strings, booleans, "
        "None, lists, dicts). Convert dates to strings.\n"
        "3. Python standard library only — no imports beyond the standard library.\n"
        "4. Do not read or write files. Do not open connections.\n"
        "5. Preserve row order and row count unless the requirement says otherwise.\n"
        "6. Short print(...) progress lines are fine; never print the full data.\n"
        "Output ONLY the script inside a single markdown code block."
    )
    user_parts = [
        f"Grid columns: {', '.join(grid_columns) or '(unknown)'}",
        f"Sample rows (JSON, reference only — the real `data` has all rows): {sample_json}",
        f"Requirement: {payload.requirement}",
    ]
    questions = [str(q) for q in (payload.questions or []) if str(q).strip()]
    answers = [str(a) for a in (payload.answers or [])]
    qa_lines = [
        f"- Q: {q}  A: {answers[i].strip() or '(no answer)'}"
        for i, q in enumerate(questions)
    ]
    if qa_lines:
        user_parts.append("Clarifications from the user:\n" + "\n".join(qa_lines))
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]
    _start = time.perf_counter()
    reply = _chat_completion(settings, messages, max_tokens=8192)
    _elapsed_ms = int((time.perf_counter() - _start) * 1000)
    script = _strip_code_fences(reply)
    logging_utils.log_info(
        "ai.grid.script",
        f"generated {len(script)} chars",
        details=f"qa={len(qa_lines)}, elapsed_ms={_elapsed_ms}",
    )
    return {"script": script}


# ---- Grid script history (recent AI-generated transform scripts) ----
_GRID_HISTORY_FILE = "grid_script_history.json"
_GRID_HISTORY_CAP = 50


class GridHistoryAddRequest(BaseModel):
    """Body for POST /ai/grid/history."""

    requirement: str
    script: str


def _load_grid_history() -> list:
    return storage.load_json(_GRID_HISTORY_FILE, [])


@router.get("/ai/grid/history")
def grid_history_list():
    """Recent AI grid-transform scripts, newest first."""
    return _load_grid_history()[:_GRID_HISTORY_CAP]


@router.post("/ai/grid/history")
def grid_history_add(payload: GridHistoryAddRequest):
    """Store a generated script (deduped, newest first, capped at 50)."""
    import uuid
    from datetime import datetime, timezone

    entries = _load_grid_history()
    # Drop an identical older entry so re-using a script moves it to the top.
    entries = [
        e
        for e in entries
        if not (e.get("requirement") == payload.requirement and e.get("script") == payload.script)
    ]
    entries.insert(
        0,
        {
            "id": uuid.uuid4().hex,
            "requirement": payload.requirement,
            "script": payload.script,
            "created_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    storage.save_json(_GRID_HISTORY_FILE, entries[:_GRID_HISTORY_CAP])
    return {"ok": True}


@router.delete("/ai/grid/history/{entry_id}")
def grid_history_delete(entry_id: str):
    """Delete one stored grid script."""
    entries = _load_grid_history()
    remaining = [e for e in entries if e.get("id") != entry_id]
    if len(remaining) == len(entries):
        raise HTTPException(status_code=404, detail=f"History entry '{entry_id}' not found")
    storage.save_json(_GRID_HISTORY_FILE, remaining)
    return {"ok": True}


def _build_chat_messages(payload: ChatRequest) -> tuple[list[dict], int, str, int]:
    """Build the LLM message list for a chat request.

    ``mode`` selects the specialty: ``chat`` (general questions, no context),
    ``sql`` (default), ``script`` or ``chart``. Returns
    ``(messages, max_tokens, mode, grid_column_count)`` shared by the blocking
    and streaming chat endpoints.
    """
    mode = (payload.mode or "sql").strip().lower()
    if mode not in ("chat", "sql", "script", "chart"):
        mode = "sql"

    schema_lines: list[str] = []
    if payload.connection_id:
        try:
            conn = _get_connection(payload.connection_id)
            schema_lines = _cached_describe_schema(conn, payload.connection_id)
        except HTTPException:
            schema_lines = []
    if payload.table:
        schema_lines = [
            line for line in schema_lines if payload.table.lower() in line.lower()
        ]
    grid_columns = _grid_column_names(payload.columns or [])

    if mode == "chat":
        # General conversation: no database or grid context is injected — the
        # user may ask about anything and the editor state is irrelevant.
        messages = [
            {"role": "system", "content": _GENERAL_ASSISTANT_SYSTEM_PROMPT},
            *({"role": turn.role, "content": turn.content} for turn in payload.messages),
        ]
    elif mode == "chart":
        # Chart conversations keep the dataset context on every turn; the sample
        # rows (value-format reference only) are attached to the last user turn.
        sample = (payload.rows or [])[:5]
        columns_line = f"Available columns: {', '.join(grid_columns) or '(none)'}"
        sample_lines: list[str] = []
        if sample:
            sample_lines = [
                "",
                "Sample rows (JSON — value-format reference only, do NOT embed these values):",
                json.dumps(sample, ensure_ascii=False, default=str)[:4000],
            ]
        messages = [{"role": "system", "content": _ECHART_ASSISTANT_SYSTEM_PROMPT}]
        turns = list(payload.messages)
        for i, turn in enumerate(turns):
            if turn.role != "user":
                messages.append({"role": turn.role, "content": turn.content})
                continue
            content = f"{turn.content}\n\n{columns_line}"
            if i == len(turns) - 1 and sample_lines:
                content += "\n" + "\n".join(sample_lines)
            messages.append({"role": "user", "content": content})
    else:
        system_prompt = (
            _SCRIPT_ASSISTANT_SYSTEM_PROMPT if mode == "script" else _SQL_ASSISTANT_SYSTEM_PROMPT
        )
        user_context = ""
        if schema_lines:
            user_context = (
                "\n\nRelevant database columns for reference:\n" + "\n".join(schema_lines)
            )
        if grid_columns:
            user_context += (
                "\n\nThe columns of the query result currently loaded in the grid are:\n"
                + ", ".join(grid_columns)
            )
        if mode == "sql" and payload.sql:
            user_context += (
                "\n\nThe SQL currently in the editor (modify/debug this when asked):\n"
                + payload.sql
            )
        messages = [{"role": "system", "content": system_prompt}]
        turns = list(payload.messages)
        for i, turn in enumerate(turns):
            if turn.role != "user":
                messages.append({"role": turn.role, "content": turn.content})
                continue
            content = turn.content + user_context
            # Script mode also gets the first grid row so value types/formats
            # are clear (reference only — the script reads `rows` at runtime).
            if mode == "script" and i == len(turns) - 1 and payload.rows:
                sample = payload.rows[:1]
                content += (
                    "\n\nFirst data row (JSON — value-format reference only, "
                    "do NOT embed these values):\n"
                    + json.dumps(sample[0], ensure_ascii=False, default=str)[:4000]
                )
            messages.append({"role": "user", "content": content})
    # Scripts are long-form output; a higher cap avoids truncating the code
    # block and leaves room for reasoning models' hidden thinking tokens.
    max_tokens = 8192 if mode == "script" else 1500
    return messages, max_tokens, mode, len(grid_columns)


@router.post("/ai/chat")
def chat(payload: ChatRequest):
    """Run a continuous assistant conversation in the global AI sidebar.

    ``mode`` selects the specialty: ``chat`` answers general questions with no
    database context; ``sql`` (default) explains/debugs/writes read-only SQL;
    ``script`` writes Python/JavaScript data scripts; ``chart`` writes ECharts
    option scripts that reference the grid rows. The full message history is
    sent each turn so the conversation stays in context.
    """
    settings = _load_settings()
    _require_configured(settings)
    messages, max_tokens, mode, grid_column_count = _build_chat_messages(payload)
    _start = time.perf_counter()
    reply = _chat_completion(settings, messages, max_tokens=max_tokens)
    _elapsed_ms = int((time.perf_counter() - _start) * 1000)
    logging_utils.log_info(
        "ai.chat",
        f"mode={mode} replied with {len(reply)} chars",
        details=(
            f"mode={mode}, turns={len(payload.messages)}, grid_columns={grid_column_count}, "
            f"elapsed_ms={_elapsed_ms}"
        ),
    )
    return {"reply": reply}


@router.post("/ai/chat/stream")
def chat_stream(payload: ChatRequest):
    """Streamed variant of ``/ai/chat`` (newline-delimited JSON).

    Emits ``{"type":"delta","text":...}`` events as the model generates text,
    then ``{"type":"result","reply":...}`` — or ``{"type":"error","detail":...}``
    on failure. When the endpoint yields no streamed text (some gateways ignore
    ``stream: true``), falls back to the non-streaming call so the reply and its
    empty-response retry logic still apply.
    """
    settings = _load_settings()
    _require_configured(settings)
    messages, max_tokens, mode, grid_column_count = _build_chat_messages(payload)

    def event_stream() -> Iterator[str]:
        collected: list[str] = []
        _start = time.perf_counter()
        try:
            for chunk in _stream_chat_completion(settings, messages, max_tokens):
                collected.append(chunk)
                yield json.dumps({"type": "delta", "text": chunk}, ensure_ascii=False) + "\n"
        except HTTPException as exc:
            yield json.dumps({"type": "error", "detail": str(exc.detail)}, ensure_ascii=False) + "\n"
            return
        except Exception as exc:  # noqa: BLE001 - unexpected failures are reported
            yield json.dumps({"type": "error", "detail": str(exc)}, ensure_ascii=False) + "\n"
            return
        reply = "".join(collected).strip()
        if not reply:
            # Nothing streamed — reuse the non-streaming call (it retries
            # empty replies) and forward the text as a single delta.
            try:
                reply = _chat_completion(settings, messages, max_tokens=max_tokens)
            except HTTPException as exc:
                yield json.dumps(
                    {"type": "error", "detail": str(exc.detail)}, ensure_ascii=False
                ) + "\n"
                return
            except Exception as exc:  # noqa: BLE001
                yield json.dumps({"type": "error", "detail": str(exc)}, ensure_ascii=False) + "\n"
                return
            if reply:
                yield json.dumps({"type": "delta", "text": reply}, ensure_ascii=False) + "\n"
        _elapsed_ms = int((time.perf_counter() - _start) * 1000)
        logging_utils.log_info(
            "ai.chat",
            f"mode={mode} streamed {len(reply)} chars",
            details=(
                f"mode={mode}, turns={len(payload.messages)}, grid_columns={grid_column_count}, "
                f"elapsed_ms={_elapsed_ms}, stream=True"
            ),
        )
        yield json.dumps({"type": "result", "reply": reply}, ensure_ascii=False) + "\n"

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/ai/echart")
def generate_echart(payload: EChartRequest):
    """Generate an ECharts option script from a plain-language requirement.

    The assistant writes a self-contained JavaScript snippet that assigns the
    final ECharts option to a variable named ``option``. The frontend evaluates
    it and renders it with ECharts; the user can edit the snippet and re-apply.
    """
    settings = _load_settings()
    _require_configured(settings)
    columns = _grid_column_names(payload.columns or [])
    sample = (payload.rows or [])[:5]
    user_context = f"Available columns: {', '.join(columns) or '(none)'}"
    if sample:
        user_context += (
            "\n\nSample rows (JSON — value-format reference only, do NOT embed these values):\n"
            + json.dumps(sample, ensure_ascii=False, default=str)[:4000]
        )
    user_context += f"\n\nUser requirement: {payload.requirement}"
    messages = [
        {"role": "system", "content": _ECHART_ASSISTANT_SYSTEM_PROMPT},
        {"role": "user", "content": user_context},
    ]
    _start = time.perf_counter()
    reply = _chat_completion(settings, messages, max_tokens=2000)
    _elapsed_ms = int((time.perf_counter() - _start) * 1000)
    logging_utils.log_info(
        "ai.echart",
        f"generated {len(reply)} chars",
        details=(
            f"columns={len(columns)}, sample_rows={len(sample)}, elapsed_ms={_elapsed_ms}"
        ),
    )
    return {"script": _strip_code_fences(reply)}


@router.post("/ai/dashboard")
def generate_dashboard(payload: DashboardRequest):
    """Design several dashboard charts from a plain-language requirement.

    Returns a list of chart specs (``chartType``/``x``/``y``/``operation``/...)
    that the frontend maps onto the shared VisualConfig pipeline and pins to the
    snapshot's dashboard.
    """
    settings = _load_settings()
    _require_configured(settings)
    columns = _grid_column_names(payload.columns or [])
    sample = (payload.rows or [])[:5]
    user_context = f"Available columns: {', '.join(columns) or '(none)'}"
    if sample:
        user_context += (
            "\n\nSample rows (JSON — value-format reference only, do NOT copy these values):\n"
            + json.dumps(sample, ensure_ascii=False, default=str)[:4000]
        )
    user_context += f"\n\nUser requirement: {payload.requirement}"
    messages = [
        {"role": "system", "content": _DASHBOARD_ASSISTANT_SYSTEM_PROMPT},
        {"role": "user", "content": user_context},
    ]
    _start = time.perf_counter()
    reply = _chat_completion(settings, messages, max_tokens=2500)
    _elapsed_ms = int((time.perf_counter() - _start) * 1000)
    specs = _clean_chart_specs(_extract_chart_array(reply), columns)
    if not specs:
        raise HTTPException(
            status_code=502,
            detail="The AI did not return any usable chart definitions. Please try again.",
        )
    logging_utils.log_info(
        "ai.dashboard",
        f"generated {len(specs)} charts",
        details=f"columns={len(columns)}, sample_rows={len(sample)}, elapsed_ms={_elapsed_ms}",
    )
    return {"charts": specs}


_STATS_ROW_CAP = 1000
_STATS_TIMEOUT_SECONDS = 120


@router.post("/ai/stats")
def ai_stats(payload: StatsRequest):
    """Write a Python statistical analysis of the rows and execute it.

    The model authors a stdlib-only script that reads a ``data`` variable (the
    row dicts) and prints a report; it is then run in-process via the scripts
    executor and the captured output is returned.
    """
    settings = _load_settings()
    _require_configured(settings)
    columns = _grid_column_names(payload.columns or [])
    rows = (payload.rows or [])[:_STATS_ROW_CAP]
    sample = rows[:20]
    user_context = (
        f"Available columns: {', '.join(columns) or '(none)'}\n"
        f"Row count: {len(rows)}\n"
        "Sample rows (JSON — value-format reference only, do NOT copy these values):\n"
        + json.dumps(sample, ensure_ascii=False, default=str)[:6000]
    )
    if payload.requirement.strip():
        user_context += f"\n\nUser focus: {payload.requirement.strip()}"
    messages = [
        {"role": "system", "content": _STATS_ASSISTANT_SYSTEM_PROMPT},
        {"role": "user", "content": user_context},
    ]
    script = _strip_code_fences(_chat_completion(settings, messages, max_tokens=8192))

    # Deferred import: scripts.py must not import ai.py (cycle), and ai.py only
    # needs the executor at call time.
    from app.api.scripts import _run_python

    _start = time.perf_counter()
    stdout, stderr, timed_out = _run_python(script, rows, _STATS_TIMEOUT_SECONDS)
    elapsed_ms = int((time.perf_counter() - _start) * 1000)
    logging_utils.log_info(
        "ai.stats",
        f"ran stats script ({len(stdout)} chars stdout)",
        details=(
            f"columns={len(columns)}, rows={len(rows)}, timed_out={timed_out}, "
            f"elapsed_ms={elapsed_ms}"
        ),
    )
    return {
        "script": script,
        "stdout": stdout,
        "stderr": stderr,
        "timed_out": timed_out,
        "elapsed_ms": elapsed_ms,
    }
