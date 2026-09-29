"""Smoke tests for the SQL builder and analytics modules.

Run from the ``backend`` directory:

    .venv\\Scripts\\python.exe -m pytest
"""

import io
import json

import pandas as pd
import pytest
from fastapi import HTTPException

from app.analytics import analyze, profile_dataframe
from app.api import feedback as feedback_mod
from app.api.uploads import _iter_parse_events, _spool_pop, _spool_put
from app.db import odbc as odbc_mod
from app.db.sql_builder import MAX_LIMIT, build_select, dbms_from_hints, resolve_dbms


# ---- sql_builder.build_select -----------------------------------------------


def test_build_select_basic_limit():
    sql, params = build_select({"table": "dbo.Lots", "columns": ["lot_id", "qty"]})
    assert sql == 'SELECT lot_id, qty FROM "dbo.Lots" LIMIT 1000'
    assert params == []


def test_build_select_sqlserver_uses_top():
    sql, _ = build_select({"table": "Lots"}, dbms="Microsoft SQL Server")
    assert sql.startswith("SELECT TOP 1000 ")
    assert "LIMIT" not in sql


def test_build_select_oracle_fetch_first():
    sql, _ = build_select({"table": "LOTS"}, dbms="Oracle")
    assert sql.endswith("FETCH FIRST 1000 ROWS ONLY")


def test_build_select_access_brackets():
    sql, _ = build_select({"table": "Lot Table", "columns": ["Part No"]}, dbms="Microsoft Access")
    assert "SELECT TOP 1000 [Part No] FROM [Lot Table]" in sql


def test_build_select_filters_and_params():
    sql, params = build_select(
        {
            "table": "t",
            "filters": [
                {"column": "a", "operator": "=", "value": 1},
                {"column": "b", "operator": "contains", "value": "x"},
                {"column": "c", "operator": "in", "value": ["p", "q"]},
                {"column": "d", "operator": "is null"},
            ],
        },
        dbms="Microsoft SQL Server",
    )
    assert "a = ? AND b LIKE ? AND c IN (?, ?) AND d IS NULL" in sql
    assert params == [1, "%x%", "p", "q"]


def test_build_select_unsupported_operator_raises():
    with pytest.raises(ValueError):
        build_select({"table": "t", "filters": [{"column": "a", "operator": "~", "value": 1}]})


def test_build_select_derived_columns():
    sql, _ = build_select(
        {
            "table": "t",
            "columns": ["a"],
            "derived_columns": [{"name": "total", "expression": "a * 2"}],
        }
    )
    assert "SELECT a, a * 2 AS total FROM t LIMIT 1000" == sql


def test_build_select_limit_clamped():
    sql, _ = build_select({"table": "t", "limit": 10**9})
    assert f"LIMIT {MAX_LIMIT}" in sql


def test_build_select_date_range():
    sql, params = build_select(
        {"table": "t", "date_column": "created", "date_from": "2024-01-01", "date_to": "2024-12-31"}
    )
    assert "created BETWEEN ? AND ?" in sql
    assert params == ["2024-01-01", "2024-12-31"]


def test_resolve_dbms_prefers_user_selection():
    assert resolve_dbms({"database_type": "oracle"}, "Microsoft SQL Server") == "Oracle"
    assert resolve_dbms({"database_type": "auto"}, "Microsoft SQL Server") == "Microsoft SQL Server"
    assert resolve_dbms({}, None) is None


def test_resolve_dbms_falls_back_to_offline_driver_hint():
    # An untyped connection whose live probe is unreachable must still resolve
    # Oracle from the driver name, or its date filters degrade to a bare string
    # bind and raise ORA-01861 (see detect_dbms / dbms_from_hints).
    assert resolve_dbms({}, dbms_from_hints({"driver": "Oracle in OraClient19Home1"})) == "Oracle"
    assert resolve_dbms({}, dbms_from_hints({"connection_string": "DRIVER={SQLSRV32.dll}"})) == (
        "Microsoft SQL Server"
    )
    assert resolve_dbms({}, dbms_from_hints({"driver": "Some Unknown Driver"})) is None


# ---- odbc: packaged-exe ODBC loader state (Oracle error 1114 regression) ----


@pytest.fixture
def _reset_loader_state(monkeypatch):
    """Run each test with the one-time loader-state guard cleared."""
    monkeypatch.setattr(odbc_mod, "_ODBC_LOADER_STATE_READY", False)
    return None


def test_frozen_open_connection_resets_dll_directory(monkeypatch, _reset_loader_state):
    """When frozen, the first connect must clear SetDllDirectory before connecting.

    PyInstaller's one-file bootloader points the process DLL directory at the
    extraction temp dir; Oracle's ODBC driver then fails to initialize
    (IM003 / system error 1114). open_connection must undo that override.
    """
    calls = []

    class _FakeKernel32:
        def SetDllDirectoryW(self, path):
            calls.append(path)
            return 1

    monkeypatch.setattr("ctypes.WinDLL", lambda name: _FakeKernel32(), raising=False)
    monkeypatch.setattr(odbc_mod.sys, "frozen", True, raising=False)
    sentinel = object()
    monkeypatch.setattr(odbc_mod.pyodbc, "connect", lambda *a, **k: sentinel)

    assert odbc_mod.open_connection({"type": "dsn", "dsn": "x"}) is sentinel
    assert calls == [None]


def test_non_frozen_open_connection_skips_loader_reset(monkeypatch, _reset_loader_state):
    """Outside PyInstaller nothing should touch the DLL directory."""
    calls = []

    class _FakeKernel32:
        def SetDllDirectoryW(self, path):
            calls.append(path)
            return 1

    monkeypatch.setattr("ctypes.WinDLL", lambda name: _FakeKernel32(), raising=False)
    monkeypatch.setattr(odbc_mod.sys, "frozen", False, raising=False)
    monkeypatch.setattr(odbc_mod.pyodbc, "connect", lambda *a, **k: "cn")

    assert odbc_mod.open_connection({"type": "dsn", "dsn": "x"}) == "cn"
    assert calls == []


# ---- analytics.analyze -------------------------------------------------------


def test_analyze_empty_df():
    result = analyze(pd.DataFrame())
    assert "no rows" in result["summary"][0].lower()
    assert result["stats"] == {}
    assert result["outliers"] == []


def test_analyze_numeric_stats():
    df = pd.DataFrame({"v": [1.0, 2.0, 3.0, 4.0]})
    result = analyze(df)
    stats = result["stats"]["v"]
    assert stats["count"] == 4
    assert stats["mean"] == pytest.approx(2.5)
    assert "correlation" in result and "frequencies" in result


# ---- analytics.profile_dataframe --------------------------------------------


def test_profile_dataframe_counts_and_numeric_stats():
    df = pd.DataFrame({"num": [1.0, 2.0, 3.0, 4.0], "cat": ["x", "x", "y", None]})
    rows = profile_dataframe(df)
    by_col = {r["column"]: r for r in rows}

    assert by_col["num"]["total"] == 4
    assert by_col["num"]["non_null"] == 4
    assert by_col["num"]["mean"] == pytest.approx(2.5)
    assert by_col["num"]["min"] == 1.0 and by_col["num"]["max"] == 4.0

    assert by_col["cat"]["missing"] == 1
    assert by_col["cat"]["distinct"] == 2
    assert by_col["cat"]["top_values"][0] == {"value": "x", "count": 2}
    assert "mean" not in by_col["cat"]


def test_profile_dataframe_quality_score_and_meta():
    df = pd.DataFrame({"v": [1.0, 2.0, 3.0, 4.0]})
    rows = profile_dataframe(df, columns_meta=[{"name": "v", "type": "5"}])
    row = rows[0]
    # completeness 1.0 * 0.7 + cardinality 1.0 * 0.3 = 100.0
    assert row["quality_score"] == 100.0
    assert row["db_type"] == "5"


def test_profile_dataframe_empty():
    rows = profile_dataframe(pd.DataFrame({"a": []}))
    assert rows[0]["total"] == 0
    assert rows[0]["missing"] == 0


# ---- feedback board ---------------------------------------------------------


def test_feedback_anon_key_prefers_env(monkeypatch):
    monkeypatch.setenv("ODBC_FEEDBACK_KEY", "env-key")
    assert feedback_mod.anon_key() == "env-key"


def test_feedback_anon_key_falls_back_to_builtin(monkeypatch):
    monkeypatch.delenv("ODBC_FEEDBACK_KEY", raising=False)
    monkeypatch.setattr(feedback_mod, "APP_DATA_DIR", "Z:\\does\\not\\exist")
    assert feedback_mod.anon_key() == feedback_mod.DEFAULT_ANON_KEY


def _fake_store(monkeypatch):
    """Point the profile helpers at an in-memory store (never %APPDATA%)."""
    saved: dict = {}
    monkeypatch.setattr(
        feedback_mod.storage,
        "load_json",
        lambda name, default=None: saved.get(name, default),
    )
    monkeypatch.setattr(feedback_mod.storage, "save_json", lambda name, data: saved.__setitem__(name, data))
    return saved


def test_feedback_profile_is_created_once(monkeypatch):
    saved = _fake_store(monkeypatch)
    first = feedback_mod.load_profile()
    assert first["author_id"]
    assert first["author_id"] == saved[feedback_mod._PROFILE_FILE]["author_id"]
    assert feedback_mod.load_profile()["author_id"] == first["author_id"]


def test_feedback_text_validation():
    assert feedback_mod._text("  hi  ", "Title", max_length=10) == "hi"
    with pytest.raises(HTTPException):
        feedback_mod._text("   ", "Title", max_length=10)
    with pytest.raises(HTTPException):
        feedback_mod._text("x" * 11, "Title", max_length=10)


def test_feedback_choice_validation():
    assert feedback_mod._choice("", "Category", feedback_mod.CATEGORIES, "other") == "other"
    assert feedback_mod._choice("BUG", "Category", feedback_mod.CATEGORIES, "other") == "bug"
    with pytest.raises(HTTPException):
        feedback_mod._choice("nope", "Category", feedback_mod.CATEGORIES, "other")


def test_feedback_attachments_must_live_in_the_feedback_bucket():
    good = {
        "url": feedback_mod._storage_url("2026/09/shot.png", public=True),
        "name": "shot.png",
        "size": 1234,
        "type": "image/png",
    }
    assert feedback_mod._attachments_in([good])[0]["name"] == "shot.png"
    with pytest.raises(HTTPException):
        feedback_mod._attachments_in([{**good, "url": "https://example.com/shot.png"}])
    with pytest.raises(HTTPException):
        feedback_mod._attachments_in([{**good, "size": feedback_mod.MAX_ATTACHMENT_BYTES + 1}])


def test_feedback_embedded_count_and_shaping():
    assert feedback_mod._embedded_count([{"count": 3}]) == 3
    assert feedback_mod._embedded_count([]) == 0
    assert feedback_mod._embedded_count(None) == 0

    row = {
        "id": "t1",
        "title": "Broken export",
        "category": "bug",
        "author_id": "me",
        "author_name": "Alex",
        "created_at": "2026-09-14T00:00:00+00:00",
        "updated_at": "2026-09-14T00:00:00+00:00",
        "feedback_replies": [{"count": 2}],
        "feedback_likes": [{"count": 5}],
    }
    out = feedback_mod._thread_out(row, "me", {"t1"})
    assert out["mine"] is True
    assert out["liked_by_me"] is True
    assert out["reply_count"] == 2
    assert out["like_count"] == 5
    assert feedback_mod._thread_out(row, "someone-else", set())["mine"] is False


# ---- streaming upload parse -------------------------------------------------


def _stream_events(raw: bytes, filename: str) -> list[dict]:
    return [json.loads(line) for line in _iter_parse_events(raw, filename)]


def test_upload_stream_xlsx_reports_read_progress(monkeypatch):
    from openpyxl import Workbook

    import app.api.uploads as uploads_mod

    monkeypatch.setattr(uploads_mod, "_XLSX_PROGRESS_ROWS", 3)
    wb = Workbook()
    ws = wb.active
    ws.append(["a", "b"])
    for i in range(10):
        ws.append([i, f"v{i}"])
    buf = io.BytesIO()
    wb.save(buf)

    events = _stream_events(buf.getvalue(), "book.xlsx")

    types = [e["type"] for e in events]
    assert "error" not in types
    reads = [
        e["rows"] for e in events if e["type"] == "progress" and e.get("stage") == "read"
    ]
    assert reads == [3, 6, 9, 10]
    begin = next(e for e in events if e["type"] == "result_begin")
    assert begin["row_count"] == 10
    assert [c["name"] for c in begin["columns"]] == ["a", "b"]


def test_upload_stream_csv_reports_row_progress_and_batches():
    n = 25
    csv = io.BytesIO(("a,b\n" + "\n".join(f"{i},{i * 2}" for i in range(n)) + "\n").encode())
    events = _stream_events(csv.getvalue(), "data.csv")

    types = [e["type"] for e in events]
    assert types.count("result_begin") == 1
    assert types.count("result_end") == 1
    assert "error" not in types

    begin = next(e for e in events if e["type"] == "result_begin")
    assert begin["row_count"] == n
    assert [c["name"] for c in begin["columns"]] == ["a", "b"]

    row_events = [e for e in events if e["type"] == "result_rows"]
    total_rows = sum(len(e["rows"]) for e in row_events)
    assert total_rows == n
    assert row_events[0]["rows"][0] == {"a": 0, "b": 0}

    # Read progress reported cumulative counts, import progress matches batches.
    read_progress = [e for e in events if e["type"] == "progress" and e.get("stage") == "read"]
    assert read_progress[-1]["rows"] == n
    import_progress = [e for e in events if e["type"] == "progress" and e.get("stage") == "import"]
    assert import_progress[-1]["rows"] == n
    assert "elapsed_ms" in events[-1]


def test_upload_stream_empty_csv_yields_error_event():
    events = _stream_events(b"a,b\n", "empty.csv")
    assert events[-1]["type"] == "error"
    assert "no rows" in events[-1]["detail"]


def test_upload_stream_unsupported_type_yields_error_event():
    events = _stream_events(b"whatever", "data.txt")
    assert events[-1]["type"] == "error"
    assert "Unsupported file type" in events[-1]["detail"]


def test_upload_spool_roundtrip_and_missing_id():
    upload_id = _spool_put(b"a,b\n1,2\n", "t.csv")
    raw, filename = _spool_pop(upload_id)
    assert raw == b"a,b\n1,2\n"
    assert filename == "t.csv"
    # Popped entries are gone — a second parse of the same id must 404.
    with pytest.raises(HTTPException) as exc_info:
        _spool_pop(upload_id)
    assert exc_info.value.status_code == 404
