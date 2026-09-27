"""Build the bundled Pantone TCX reference database.

Regenerate whenever the source xlsx is refreshed with a new TCX season:

    python backend/tools/build_pantone_db.py

Reads  backend/templates/Pantone_TCX.xlsx  (sheet "Pantone LAB")
Writes backend/app/data/pantone_tcx.db     (SQLite, read-only at runtime)
"""
from __future__ import annotations

import os
import sqlite3
import sys

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
SRC_XLSX = os.path.join(BACKEND_DIR, "templates", "Pantone_TCX.xlsx")
OUT_DB = os.path.join(BACKEND_DIR, "app", "data", "pantone_tcx.db")

SCHEMA = """
CREATE TABLE pantone_tcx (
    code    TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    name_zh TEXT,
    hex     TEXT NOT NULL,
    l       REAL NOT NULL,
    a       REAL NOT NULL,
    b       REAL NOT NULL,
    rgb_r   INTEGER NOT NULL,
    rgb_g   INTEGER NOT NULL,
    rgb_b   INTEGER NOT NULL
);
"""

# Source header -> destination column
COLUMNS = [
    ("Pantone", "code"),
    ("Name", "name"),
    ("Chinese", "name_zh"),
    ("Hex", "hex"),
    ("L", "l"),
    ("a_star", "a"),
    ("b_star", "b"),
    ("R", "rgb_r"),
    ("G", "rgb_g"),
    ("B", "rgb_b"),
]


def _clean(value, column: str):
    if isinstance(value, str):
        value = value.strip()
    if value is None or value == "":
        if column in ("name_zh",):
            return None
        raise ValueError(f"blank value in required column {column!r}")
    if column == "hex":
        return value.lower()
    return value


def load_rows():
    wb = openpyxl.load_workbook(SRC_XLSX, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header = [str(c).strip() if c is not None else "" for c in next(rows)]
    index = {h: i for i, h in enumerate(header)}

    missing = [src for src, _ in COLUMNS if src not in index]
    if missing:
        raise ValueError(f"{SRC_XLSX} is missing column(s): {missing}")

    out = []
    seen = set()
    for line_no, row in enumerate(rows, start=2):
        if all(v is None or v == "" for v in row):
            continue
        record = {}
        for src, dest in COLUMNS:
            try:
                record[dest] = _clean(row[index[src]], dest)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{SRC_XLSX} row {line_no}: {exc}") from exc
        # LAB / RGB must be numeric
        for dest in ("l", "a", "b"):
            record[dest] = float(record[dest])
        for dest in ("rgb_r", "rgb_g", "rgb_b"):
            record[dest] = int(round(float(record[dest])))
        if record["code"] in seen:
            raise ValueError(f"{SRC_XLSX} row {line_no}: duplicate code {record['code']!r}")
        seen.add(record["code"])
        out.append(record)

    wb.close()
    return out


def build(records):
    os.makedirs(os.path.dirname(OUT_DB), exist_ok=True)
    tmp = OUT_DB + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)

    conn = sqlite3.connect(tmp)
    try:
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT INTO pantone_tcx "
            "(code, name, name_zh, hex, l, a, b, rgb_r, rgb_g, rgb_b) "
            "VALUES (:code, :name, :name_zh, :hex, :l, :a, :b, :rgb_r, :rgb_g, :rgb_b)",
            records,
        )
        conn.execute("CREATE INDEX idx_pantone_lab ON pantone_tcx (l, a, b)")
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()

    os.replace(tmp, OUT_DB)
    return OUT_DB


def main():
    records = load_rows()
    path = build(records)
    size_kb = os.path.getsize(path) / 1024
    print(f"wrote {len(records)} rows -> {path} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
