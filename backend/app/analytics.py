"""Analytics engine: summaries, outliers, trends, recommendations.

Fully offline statistical analysis built on pandas. :func:`analyze` returns
exactly::

    {
        "summary": [str, ...],
        "outliers": [{"column", "index", "value"}, ...],
        "trends": [str, ...],
        "recommendations": [str, ...],
        "stats": {col: {"count", "mean", "median", "std", "min", "max",
                        "missing", "unique"}},
        "correlation": {"columns": [str, ...], "matrix": [[float|None, ...], ...]},
        "frequencies": {col: [{"value", "count", "pct"}, ...], ...},
    }
"""
from __future__ import annotations

import math
from datetime import datetime

from app.lazy import lazy_module

# numpy/pandas load on first use (deferred so the app window appears faster).
np = lazy_module("numpy")
pd = lazy_module("pandas")

MAX_OUTLIERS_PER_COLUMN = 10
TREND_RELATIVE_THRESHOLD = 0.05
MISSING_HIGH_THRESHOLD = 0.30
MAX_FREQUENCY_VALUES = 10
MAX_FREQUENCY_DISTINCT = 50
TOP_VALUES_LIMIT = 10


def analyze(df: pd.DataFrame) -> dict:
    """Compute descriptive stats, outliers, trends and recommendations."""
    if df is None or df.empty:
        return {
            "summary": ["The dataset contains no rows."],
            "outliers": [],
            "trends": [],
            "recommendations": ["The dataset is empty; nothing to analyze."],
            "stats": {},
            "correlation": {"columns": [], "matrix": []},
            "frequencies": {},
        }

    numeric_cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    stats = {col: _column_stats(df[col]) for col in numeric_cols}
    outliers = _find_outliers(df, numeric_cols)
    trends = _find_trends(df, numeric_cols)
    summary = _build_summary(df, numeric_cols, outliers, stats)
    recommendations = _build_recommendations(df, numeric_cols, outliers, trends, stats)

    return {
        "summary": summary,
        "outliers": outliers,
        "trends": trends,
        "recommendations": recommendations,
        "stats": stats,
        "correlation": _correlation(df, numeric_cols),
        "frequencies": _frequencies(df),
    }


def _column_stats(series: pd.Series) -> dict:
    """Per-column descriptive statistics (NaN -> None so JSON stays valid)."""
    numeric = pd.to_numeric(series, errors="coerce")
    count = int(numeric.notna().sum())
    missing = int(numeric.isna().sum())
    if count == 0:
        return {
            "count": 0,
            "mean": None,
            "median": None,
            "std": None,
            "min": None,
            "max": None,
            "missing": missing,
            "unique": int(series.nunique()),
        }
    values = numeric.dropna()
    return {
        "count": count,
        "mean": _float_or_none(values.mean()),
        "median": _float_or_none(values.median()),
        "std": _float_or_none(values.std(ddof=1)),
        "min": _float_or_none(values.min()),
        "max": _float_or_none(values.max()),
        "missing": missing,
        "unique": int(series.nunique()),
    }


def _find_outliers(df: pd.DataFrame, numeric_cols: list) -> list[dict]:
    """IQR-based outliers (Q1-1.5*IQR / Q3+1.5*IQR), capped per column."""
    outliers: list[dict] = []
    for col in numeric_cols:
        numeric = pd.to_numeric(df[col], errors="coerce").dropna()
        if len(numeric) < 4:
            continue
        q1 = float(numeric.quantile(0.25))
        q3 = float(numeric.quantile(0.75))
        iqr = q3 - q1
        lower = q1 - 1.5 * iqr
        upper = q3 + 1.5 * iqr
        mask = (numeric < lower) | (numeric > upper)
        hits = numeric[mask]
        for idx, value in hits.head(MAX_OUTLIERS_PER_COLUMN).items():
            outliers.append(
                {"column": str(col), "index": int(idx), "value": _float_or_none(value)}
            )
    return outliers


def _find_trends(df: pd.DataFrame, numeric_cols: list) -> list[str]:
    """Linear-regression slope on each numeric column vs row order."""
    trends: list[str] = []
    for col in numeric_cols:
        numeric = pd.to_numeric(df[col], errors="coerce").dropna()
        if len(numeric) < 3:
            continue
        n = len(numeric)
        slope = float(np.polyfit(np.arange(n), numeric.to_numpy(dtype=float), 1)[0])
        span = float(numeric.max()) - float(numeric.min())
        if span <= 0 or abs(slope) * (n - 1) < span * TREND_RELATIVE_THRESHOLD:
            direction = "no clear trend"
        else:
            direction = "increasing" if slope > 0 else "decreasing"
        trends.append(f"{col}: {direction} over the selected rows")
    return trends


def _build_summary(df, numeric_cols, outliers, stats) -> list[str]:
    summary = [
        f"Dataset contains {len(df)} rows and {len(df.columns)} columns "
        f"({len(numeric_cols)} numeric)."
    ]
    if numeric_cols:
        summary.append(
            "Numeric columns analyzed: " + ", ".join(str(c) for c in numeric_cols) + "."
        )
        for col in numeric_cols:
            s = stats[col]
            summary.append(
                f"{col}: mean {_fmt(s['mean'])}, median {_fmt(s['median'])}, "
                f"min {_fmt(s['min'])}, max {_fmt(s['max'])} "
                f"(missing {s['missing']} of {s['count'] + s['missing']})."
            )
    outlier_cols = {o["column"] for o in outliers}
    if outlier_cols:
        summary.append(
            f"Potential outliers were detected in {len(outlier_cols)} "
            f"column(s): {', '.join(sorted(outlier_cols))}."
        )
    missing_cols = [c for c in numeric_cols if stats[c]["missing"] > 0]
    if missing_cols:
        summary.append(f"Missing values were found in {len(missing_cols)} numeric column(s).")
    return summary


def _build_recommendations(df, numeric_cols, outliers, trends, stats) -> list[str]:
    recommendations: list[str] = []
    total_rows = len(df)

    for col in numeric_cols:
        s = stats[col]
        missing_share = s["missing"] / total_rows if total_rows else 0.0
        if missing_share >= MISSING_HIGH_THRESHOLD:
            recommendations.append(
                f"Column '{col}' is missing {s['missing']} of {total_rows} "
                f"values ({missing_share:.0%}); consider whether it should be "
                "filled or excluded from analysis."
            )

    duplicate_rows = int(df.duplicated().sum()) if len(df) > 1 else 0
    if duplicate_rows:
        recommendations.append(
            f"The dataset contains {duplicate_rows} duplicate row(s); "
            "consider removing them before analysis."
        )

    for col in numeric_cols:
        s = stats[col]
        if s["count"] > 0 and s["min"] == s["max"] and s["count"] > 1:
            recommendations.append(
                f"Column '{col}' is constant (all values equal "
                f"{_fmt(s['min'])}); it provides no analytical signal."
            )

    outlier_counts: dict[str, int] = {}
    for o in outliers:
        outlier_counts[o["column"]] = outlier_counts.get(o["column"], 0) + 1
    for col, n in sorted(outlier_counts.items()):
        recommendations.append(
            f"Column '{col}' has {n} potential outlier(s); review those rows "
            "before modeling or aggregating."
        )

    for trend in trends:
        if "no clear trend" not in trend:
            col = trend.split(":")[0]
            recommendations.append(
                f"Column '{col}' shows a {trend.split(': ', 1)[1]}; "
                "investigate the drivers behind the change over time."
            )

    if not numeric_cols:
        recommendations.append(
            "No numeric columns detected; statistical analysis is limited "
            "to data-quality checks."
        )
    return recommendations


def _float_or_none(value):
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _safe_value(value):
    """Convert a pandas/numpy value to a JSON-serializable Python value."""
    if value is None:
        return None
    if isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, (float, np.floating)):
        f = float(value)
        # NaN / Infinity are not JSON-compliant (Starlette uses allow_nan=False).
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return _float_or_none(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return str(value)
    return str(value)


def _correlation(df: pd.DataFrame, numeric_cols: list) -> dict:
    """Pearson correlation matrix over the numeric columns."""
    if len(numeric_cols) < 2:
        return {"columns": [], "matrix": []}
    matrix = df[numeric_cols].corr(numeric_only=True)
    columns = [str(c) for c in matrix.columns]
    data = []
    for _, row in matrix.iterrows():
        data.append([_float_or_none(v) for v in row.values])
    return {"columns": columns, "matrix": data}


def _frequencies(df: pd.DataFrame) -> dict:
    """Top-N value counts per column (only columns with few categories)."""
    frequencies: dict[str, list[dict]] = {}
    for col in df.columns:
        series = df[col].dropna()
        if len(series) == 0:
            continue
        if series.nunique() > MAX_FREQUENCY_DISTINCT:
            continue  # too many categories to be useful
        counts = series.value_counts().head(MAX_FREQUENCY_VALUES)
        total = len(series)
        frequencies[str(col)] = [
            {
                "value": _safe_value(k),
                "count": int(v),
                "pct": round(float(v) / total * 100, 2),
            }
            for k, v in counts.items()
        ]
    return frequencies


def _fmt(value) -> str:
    if value is None:
        return "n/a"
    return f"{value:.4g}"


def _top_values(series: pd.Series) -> list[dict]:
    """Most frequent values for a column, capped at ``TOP_VALUES_LIMIT``."""
    counts = series.value_counts().head(TOP_VALUES_LIMIT)
    return [{"value": _safe_value(k), "count": int(v)} for k, v in counts.items()]


def profile_dataframe(df: pd.DataFrame, columns_meta: list | None = None) -> list[dict]:
    """Profile every column (used for the Excel "Profile" report sheet).

    ``columns_meta`` is the optional ``[{"name", "type"}, ...]`` list returned
    by the query layer; it supplies the declared DB type per column. Returns a
    list of row dicts containing counts, numeric stats, top values and a
    0-100 quality score (completeness weighted 0.7, cardinality 0.3).
    """
    meta = {}
    for item in columns_meta or []:
        name = item.get("name")
        if name is not None:
            meta[str(name)] = item

    total = len(df)
    rows = []
    for col in df.columns:
        series = df[col]
        non_null = series.dropna()
        distinct = int(series.nunique())
        completeness = len(non_null) / total if total else 0.0
        cardinality = distinct / total if total else 0.0
        numeric = pd.to_numeric(series, errors="coerce").dropna()

        row = {
            "column": str(col),
            "db_type": str(meta.get(str(col), {}).get("type", "")),
            "total": total,
            "non_null": int(len(non_null)),
            "missing": int(total - len(non_null)),
            "distinct": distinct,
            "top_values": _top_values(non_null),
            "quality_score": round((completeness * 0.7 + cardinality * 0.3) * 100, 1),
        }
        if len(numeric):
            row.update(
                {
                    "min": _float_or_none(numeric.min()),
                    "max": _float_or_none(numeric.max()),
                    "mean": _float_or_none(numeric.mean()),
                    "median": _float_or_none(numeric.median()),
                    "std": _float_or_none(numeric.std(ddof=1)) if len(numeric) > 1 else None,
                }
            )
        rows.append(row)
    return rows
