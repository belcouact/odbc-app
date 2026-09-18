"""Locate and load the bundled ECharts library for standalone HTML output."""

import os


def _echarts_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "echarts.min.js")


def get_echarts_js() -> str:
    """Return the full ECharts JS source as a string (for inline embedding)."""
    with open(_echarts_path(), "r", encoding="utf-8") as f:
        return f.read()
