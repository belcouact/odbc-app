"""API routes for chart data (trend, pareto, histogram, scatter, bar, pie, box)."""
from __future__ import annotations

import time
from typing import Literal, Optional, Union

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import logging_utils
from app.api.queries import QueryDef, fetch_rows
from app.lazy import lazy_module

# numpy/pandas load on first use (deferred so the app window appears faster).
np = lazy_module("numpy")
pd = lazy_module("pandas")

router = APIRouter()


class ChartDataRequest(BaseModel):
    """Body for POST /charts/data. Either a builder query or raw SQL is
    required, or the grid output (rows + columns) can be supplied to chart the
    already-loaded result instead of re-running the query."""

    query: Optional[QueryDef] = None
    connection_id: Optional[str] = None
    sql: Optional[str] = None
    rows: Optional[list] = None
    columns: Optional[list] = None
    chart_type: Literal[
        "trend", "pareto", "histogram", "scatter", "bar", "pie", "box", "kpi"
    ]
    x: str
    # One or more Y columns may be selected; each becomes its own series (for chart
    # types that draw several series on the same axis). Single-string values still
    # work, e.g. the dashboard tiles which store a single Y column.
    y: Union[str, list[str]]
    operation: Literal[
        "sum",
        "mean",
        "count",
        "distinct",
        "min",
        "max",
        "median",
        "std",
        "var",
        "first",
        "last",
        "p25",
        "p75",
        "p90",
        "share",
        "none",
    ] = "sum"


def _normalize_y(y: Union[str, list[str]]) -> list[str]:
    """Return the selected Y columns as a non-empty list of column names."""
    y_columns = [y] if isinstance(y, str) else list(y)
    if not y_columns or not all(isinstance(c, str) and c.strip() for c in y_columns):
        raise HTTPException(status_code=400, detail="Select at least one Y column")
    return y_columns


def _fetch_frame(payload: ChartDataRequest) -> pd.DataFrame:
    """Return the rows as a DataFrame — either the supplied grid output, or the
    result of running the embedded query (or raw SQL)."""
    if payload.rows is not None:
        rows = payload.rows
    else:
        rows, _, _ = fetch_rows(payload.query, payload.connection_id, payload.sql)
    if not rows:
        raise HTTPException(status_code=400, detail="Query returned no rows to chart")
    df = pd.DataFrame(rows)
    if payload.x and payload.x not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{payload.x}' not found in results")
    for col in _normalize_y(payload.y):
        if col not in df.columns:
            raise HTTPException(status_code=400, detail=f"Column '{col}' not found in results")
    return df


def _numeric_y(df: pd.DataFrame, y: str) -> pd.Series:
    """Coerce column ``y`` to numeric; raise 400 if it has no numeric values."""
    numeric = pd.to_numeric(df[y], errors="coerce")
    if numeric.notna().sum() == 0:
        raise HTTPException(
            status_code=400, detail=f"Column '{y}' has no numeric values to chart"
        )
    return numeric


def _clean_pairs(df: pd.DataFrame, x: str, y: str) -> tuple[list, list]:
    """Return (x_values, y_numeric) aligned on rows where both are present."""
    numeric = _numeric_y(df, y)
    mask = numeric.notna() & df[x].notna()
    x_values = df.loc[mask, x].tolist()
    y_values = [float(v) for v in numeric[mask].tolist()]
    return x_values, y_values


def _group_values(df: pd.DataFrame, x: str, y: str, operation: str) -> pd.Series:
    """Aggregate ``y`` per ``x`` group using the requested operation.

    Returns a Series indexed by x value. ``count`` counts rows per group and
    ``distinct`` counts unique ``y`` values per group; the numeric operations
    coerce ``y`` to numbers and drop non-numeric pairs. ``share`` returns each
    group's total as a percentage of the overall sum.
    """
    if operation == "count":
        return df.groupby(x).size()
    if operation == "distinct":
        return df.groupby(x)[y].nunique()
    numeric = _numeric_y(df, y)
    frame = pd.DataFrame({"x": df[x], "y": numeric}).dropna()
    grouped = frame.groupby("x")["y"]
    if operation == "mean":
        return grouped.mean()
    if operation == "sum":
        return grouped.sum()
    if operation == "min":
        return grouped.min()
    if operation == "max":
        return grouped.max()
    if operation == "median":
        return grouped.median()
    if operation == "std":
        return grouped.std()
    if operation == "var":
        return grouped.var()
    if operation == "first":
        return grouped.first()
    if operation == "last":
        return grouped.last()
    if operation == "p25":
        return grouped.quantile(0.25)
    if operation == "p75":
        return grouped.quantile(0.75)
    if operation == "p90":
        return grouped.quantile(0.9)
    if operation == "share":
        return grouped.sum() / frame["y"].sum() * 100.0
    raise HTTPException(status_code=400, detail=f"Unsupported operation '{operation}'")


def _indexed_values(df: pd.DataFrame, x: str, y: str, operation: str) -> pd.Series:
    """Return a Series indexed by x holding the aggregated value for column ``y``.

    For ``operation == "none"`` the raw (x, y) pairs are used; repeated x values
    are averaged so the series can be aligned onto a shared category axis.
    """
    if operation == "none":
        numeric = _numeric_y(df, y)
        mask = numeric.notna() & df[x].notna()
        s = pd.Series(numeric[mask].to_numpy(), index=df.loc[mask, x].to_numpy())
        return s.groupby(level=0).mean().sort_index()
    return _group_values(df, x, y, operation).sort_index()


def _aligned_series(df: pd.DataFrame, x: str, y_columns: list[str], operation: str) -> tuple[list, list]:
    """Build a shared x index and one data series per Y column.

    A Y column with no value for a particular x group emits ``None`` so the series
    stay aligned on the same chart. Used by multi-Y trend / bar layouts.
    """
    indexed: list = []
    label_index = pd.Index([])
    for y in y_columns:
        s = _indexed_values(df, x, y, operation)
        indexed.append(s)
        label_index = label_index.union(s.index)
    if len(label_index) == 0:
        raise HTTPException(status_code=400, detail="No data to chart with the selected columns")
    labels = [str(v) for v in label_index]
    series = []
    for y, s in zip(y_columns, indexed):
        reindexed = s.reindex(label_index)
        data = [None if pd.isna(v) else float(v) for v in reindexed.to_numpy()]
        series.append({"name": y, "data": data})
    return labels, series


def _trend(df: pd.DataFrame, x: str, y_columns: list[str], operation: str) -> dict:
    if len(y_columns) == 1:
        y = y_columns[0]
        if operation == "none":
            x_values, y_values = _clean_pairs(df, x, y)
        else:
            grouped = _group_values(df, x, y, operation).sort_index()
            x_values = [str(v) for v in grouped.index]
            y_values = [float(v) for v in grouped.values]
        return {
            "labels": x_values,
            "series": [{"name": y, "data": y_values}],
        }
    labels, series = _aligned_series(df, x, y_columns, operation)
    return {"labels": labels, "series": series}


def _pareto(df: pd.DataFrame, x: str, y_columns: list[str], operation: str) -> dict:
    # A Pareto ranks a single metric; when several Y columns are selected only the
    # first is ranked (the cumulative curve is likewise drawn for that metric).
    y = y_columns[0]
    if operation == "none":
        x_values, y_values = _clean_pairs(df, x, y)
    else:
        grouped = _group_values(df, x, y, operation)
        x_values = [str(v) for v in grouped.index]
        y_values = [float(v) for v in grouped.values]
    pairs = sorted(zip(x_values, y_values), key=lambda p: p[1], reverse=True)
    labels = [str(xv) for xv, _ in pairs]
    data = [yv for _, yv in pairs]
    total = sum(data) or 1.0
    cumulative = []
    running = 0.0
    for value in data:
        running += value
        cumulative.append(round(running / total * 100.0, 2))
    return {
        "labels": labels,
        "series": [{"name": y, "data": data}],
        "extra": {"cumulative_pct": cumulative},
    }


def _histogram(df: pd.DataFrame, x: str, y_columns: list[str]) -> dict:
    # Histograms bin the numeric Y column(s); x is ignored.
    if len(y_columns) == 1:
        y = y_columns[0]
        numeric = _numeric_y(df, y).dropna()
        if len(numeric) == 0:
            raise HTTPException(status_code=400, detail=f"Column '{y}' has no numeric values")
        vmin = float(numeric.min())
        vmax = float(numeric.max())
        if vmax == vmin:
            labels = [f"[{vmin:g}, {vmax:g}]"]
            counts = [len(numeric)]
        else:
            counts, edges = np.histogram(numeric.to_numpy(dtype=float), bins=10)
            labels = []
            for i, count in enumerate(counts):
                left, right = edges[i], edges[i + 1]
                if i == len(counts) - 1:
                    labels.append(f"[{left:g}, {right:g}]")
                else:
                    labels.append(f"[{left:g}, {right:g})")
        return {
            "labels": labels,
            "series": [{"name": y, "data": [int(c) for c in counts]}],
        }

    # Multi-Y: bin every column against a shared range so the histograms align.
    numeric_list = []
    for y in y_columns:
        numeric = _numeric_y(df, y).dropna()
        if len(numeric) == 0:
            raise HTTPException(status_code=400, detail=f"Column '{y}' has no numeric values")
        numeric_list.append(numeric)
    vmin = float(min(n.min() for n in numeric_list))
    vmax = float(max(n.max() for n in numeric_list))
    series = []
    if vmax == vmin:
        labels = [f"[{vmin:g}, {vmax:g}]"]
        for y, numeric in zip(y_columns, numeric_list):
            series.append({"name": y, "data": [len(numeric)]})
    else:
        edges = np.linspace(vmin, vmax, 11)
        labels = []
        for i in range(len(edges) - 1):
            left, right = edges[i], edges[i + 1]
            if i == len(edges) - 2:
                labels.append(f"[{left:g}, {right:g}]")
            else:
                labels.append(f"[{left:g}, {right:g})")
        for y, numeric in zip(y_columns, numeric_list):
            counts, _ = np.histogram(numeric.to_numpy(dtype=float), bins=edges)
            series.append({"name": y, "data": [int(c) for c in counts]})
    return {"labels": labels, "series": series}


def _scatter(df: pd.DataFrame, x: str, y_columns: list[str], operation: str) -> dict:
    series = []
    for y in y_columns:
        if operation == "none":
            x_values, y_values = _clean_pairs(df, x, y)
            series.append({
                "name": y,
                "data": [[xv, yv] for xv, yv in zip(x_values, y_values)],
            })
        else:
            # With an aggregation operation, one point is drawn per x group.
            grouped = _group_values(df, x, y, operation).sort_index()
            points = []
            for xv, v in zip(grouped.index, grouped.values):
                try:
                    points.append([float(xv), float(v)])
                except (TypeError, ValueError):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Column '{x}' is not numeric — X must be numeric for the scatter chart",
                    )
            series.append({"name": y, "data": points})
    return {"labels": [], "series": series}


def _bar(df: pd.DataFrame, x: str, y_columns: list[str], operation: str) -> dict:
    if len(y_columns) == 1:
        y = y_columns[0]
        grouped = _group_values(df, x, y, operation).sort_index()
        return {
            "labels": [str(k) for k in grouped.index],
            "series": [{"name": y, "data": [float(v) for v in grouped.values]}],
        }
    labels, series = _aligned_series(df, x, y_columns, operation)
    return {"labels": labels, "series": series}


def _pie(df: pd.DataFrame, x: str, y_columns: list[str], operation: str) -> dict:
    # A pie draws a single series; only the first selected Y is used.
    y = y_columns[0]
    grouped = _group_values(df, x, y, operation).sort_values(ascending=False)
    labels = [str(k) for k in grouped.index]
    data = [float(v) for v in grouped.values]
    # Fold the tail into "Other" so the pie stays readable.
    if len(labels) > 12:
        head_labels, head_data = labels[:11], data[:11]
        tail_labels, tail_data = labels[11:], data[11:]
        labels = head_labels + ["Other"]
        data = head_data + [sum(tail_data)]
    return {"labels": labels, "series": [{"name": y, "data": data}]}


def _box(df: pd.DataFrame, x: str, y_columns: list[str]) -> dict:
    series = []
    labels: list = []
    for y in y_columns:
        numeric = _numeric_y(df, y)
        frame = pd.DataFrame({"x": df[x], "y": numeric}).dropna()
        if frame.empty:
            raise HTTPException(status_code=400, detail=f"Column '{y}' has no numeric values")
        grouped = frame.groupby("x")["y"]
        stats = pd.DataFrame(
            {
                "min": grouped.min(),
                "q1": grouped.quantile(0.25),
                "median": grouped.median(),
                "q3": grouped.quantile(0.75),
                "max": grouped.max(),
            }
        )
        stats = stats.sort_index()
        if not labels:
            labels = [str(k) for k in stats.index]
        series.append({
            "name": y,
            "data": [
                [float(r.min), float(r.q1), float(r.median), float(r.q3), float(r.max)]
                for r in stats.itertuples()
            ],
        })
    return {"labels": labels, "series": series}


def _kpi(df: pd.DataFrame, x: str, y_columns: list[str], operation: str) -> dict:
    """Compute a single headline metric (with an optional sparkline over ``x``).

    ``operation`` chooses the whole-column aggregate (count / distinct / sum /
    mean / min / max / median). When ``x`` is set, the same aggregation is
    grouped by ``x`` to produce a mini trend line for the card. Only the first
    selected Y column is used.
    """
    y = y_columns[0]
    if operation == "count":
        value = float(len(df))
    elif operation == "distinct":
        value = float(df[y].nunique()) if y in df.columns else float(len(df))
    else:
        numeric = _numeric_y(df, y)
        if numeric.notna().sum() == 0:
            raise HTTPException(status_code=400, detail=f"Column '{y}' has no numeric values")
        operations = {
            "sum": numeric.sum(),
            "mean": numeric.mean(),
            "min": numeric.min(),
            "max": numeric.max(),
            "median": numeric.median(),
            "std": numeric.std(),
            "var": numeric.var(),
            "first": numeric.dropna().iloc[0],
            "last": numeric.dropna().iloc[-1],
            "p25": numeric.quantile(0.25),
            "p75": numeric.quantile(0.75),
            "p90": numeric.quantile(0.9),
        }
        if operation == "share":
            # A single KPI is 100% of its own total; per-group share is shown in the sparkline.
            value = 100.0
        elif operation in operations:
            value = float(operations[operation])
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported operation '{operation}'")

    spark_values: list = []
    spark_labels: list = []
    if x and x in df.columns:
        try:
            grouped = _group_values(df, x, y, operation).sort_index()
            spark_labels = [str(k) for k in grouped.index]
            spark_values = [float(v) for v in grouped.values]
        except HTTPException:
            spark_values = []
            spark_labels = []
    return {
        "labels": [],
        "series": [{"name": y, "data": [value]}],
        "extra": {"value": value, "sparkline": spark_values, "spark_labels": spark_labels},
    }


@router.post("/charts/data")
def chart_data(payload: ChartDataRequest):
    """Return chart-ready data derived from a query result."""
    start = time.perf_counter()
    df = _fetch_frame(payload)
    y_columns = _normalize_y(payload.y)
    if payload.chart_type == "trend":
        result = _trend(df, payload.x, y_columns, payload.operation)
    elif payload.chart_type == "pareto":
        result = _pareto(df, payload.x, y_columns, payload.operation)
    elif payload.chart_type == "histogram":
        # Histograms bin a numeric column; the operation is not applied.
        result = _histogram(df, payload.x, y_columns)
    elif payload.chart_type == "scatter":
        result = _scatter(df, payload.x, y_columns, payload.operation)
    elif payload.chart_type == "bar":
        result = _bar(df, payload.x, y_columns, payload.operation)
    elif payload.chart_type == "pie":
        result = _pie(df, payload.x, y_columns, payload.operation)
    elif payload.chart_type == "box":
        # Box plots already summarize the distribution; the operation is not applied.
        result = _box(df, payload.x, y_columns)
    elif payload.chart_type == "kpi":
        result = _kpi(df, payload.x, y_columns, payload.operation)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown chart_type '{payload.chart_type}'")
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    point_count = sum(len(s.get("data", [])) for s in result.get("series", []))
    logging_utils.log_info(
        "charts.data",
        f"{payload.chart_type} x={payload.x} y={y_columns} op={payload.operation}",
        details=(
            f"rows={len(df)}, chart_type={payload.chart_type}, x={payload.x}, "
            f"y={y_columns}, operation={payload.operation}, points={point_count}, "
            f"elapsed_ms={elapsed_ms}"
        ),
    )
    return result
