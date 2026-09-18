"""API routes for Excel report export (Data / Statistics / Analysis / Profile)."""
import io

import pandas as pd
from fastapi import APIRouter, Response
from pydantic import BaseModel

from app import analytics
from app.api.queries import QueryDef, _run_query

router = APIRouter()

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Above this row count the expensive analysis sheets (statistics / analysis /
# profile) are skipped so the export stays within the client timeout.
EXPORT_ANALYSIS_MAX_ROWS = 20_000


class ReportExportRequest(BaseModel):
    """Body for POST /report/export."""

    query: QueryDef
    title: str = "ODBC Query Report"


def _statistics_frame(analysis: dict) -> pd.DataFrame:
    """Per-column stats dict -> DataFrame with a fixed column order."""
    rows = []
    for col, s in analysis.get("stats", {}).items():
        rows.append(
            {
                "column": col,
                "count": s.get("count"),
                "mean": s.get("mean"),
                "median": s.get("median"),
                "std": s.get("std"),
                "min": s.get("min"),
                "max": s.get("max"),
                "missing": s.get("missing"),
                "unique": s.get("unique"),
            }
        )
    return pd.DataFrame(
        rows,
        columns=["column", "count", "mean", "median", "std", "min", "max", "missing", "unique"],
    )


def _analysis_frame(analysis: dict, title: str) -> pd.DataFrame:
    """Textual analysis (summary/trends/recommendations/outliers) as rows."""
    rows = [{"Section": "Report", "Text": title}]
    rows += [{"Section": "Summary", "Text": s} for s in analysis.get("summary", [])]
    rows += [{"Section": "Trend", "Text": t} for t in analysis.get("trends", [])]
    rows += [
        {"Section": "Recommendation", "Text": r}
        for r in analysis.get("recommendations", [])
    ]
    rows += [
        {
            "Section": "Outlier",
            "Text": f"{o.get('column')} at row {o.get('index')}: {o.get('value')}",
        }
        for o in analysis.get("outliers", [])
    ]
    return pd.DataFrame(rows, columns=["Section", "Text"])


@router.post("/report/export")
def export_report(payload: ReportExportRequest):
    """Run the query and return an Excel workbook with four sheets.

    Query/database errors surface as HTTP 400 (raised by ``_run_query``).
    """
    rows, columns_meta, _ = _run_query(payload.query)
    df = pd.DataFrame(rows)
    if df.empty and columns_meta:
        df = pd.DataFrame([], columns=[c["name"] for c in columns_meta])

    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Data", index=False)
        # Skip the heavy analysis sheets on very large exports so the request
        # completes within the client timeout.
        if len(df) <= EXPORT_ANALYSIS_MAX_ROWS:
            analysis = analytics.analyze(df)
            profile = analytics.profile_dataframe(df, columns_meta)
            _statistics_frame(analysis).to_excel(writer, sheet_name="Statistics", index=False)
            _analysis_frame(analysis, payload.title).to_excel(
                writer, sheet_name="Analysis", index=False
            )
            pd.DataFrame(profile).to_excel(writer, sheet_name="Profile", index=False)

    headers = {"Content-Disposition": 'attachment; filename="report.xlsx"'}
    return Response(content=buffer.getvalue(), media_type=XLSX_MEDIA_TYPE, headers=headers)
