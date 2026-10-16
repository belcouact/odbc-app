"""Trigger maths and data shapes for the in-app scheduler.

Pure logic only: no file, no network, no database access. Keeping the trigger
arithmetic in one small, importable module means it can be unit-tested without
starting the server or touching ``%APPDATA%``.

Time convention: every datetime handled here is a **naive local** datetime
(``datetime.now()``). The app runs on one machine, and "run daily at 06:30"
means 06:30 in the local clock — including after a daylight-saving shift, which
``replace(...)`` recomputes on every occurrence. Storing naive local times also
keeps the ISO strings unambiguous for the browser, which reads them back with
``new Date(...)`` as local time.
"""
from __future__ import annotations

import calendar
from datetime import datetime, timedelta
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

# An "every N seconds" schedule below this would just spin the runner thread.
MIN_INTERVAL_SECONDS = 30


def _add_months(year: int, month: int, offset: int) -> tuple[int, int]:
    """Shift a (year, month) pair by ``offset`` months, normalised."""
    index = year * 12 + (month - 1) + offset
    return index // 12, index % 12 + 1


def parse_time_of_day(value: str) -> tuple[int, int]:
    """Parse ``"HH:MM"`` into ``(hour, minute)``; raise ValueError if malformed."""
    parts = str(value).strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid time {value!r}; expected HH:MM")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise ValueError(f"Invalid time {value!r}; expected HH:MM") from exc
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"Invalid time {value!r}; expected HH:MM")
    return hour, minute


def compute_next_run(trigger: "Trigger", after: datetime) -> datetime:
    """The first fire time strictly after ``after`` for this trigger."""
    if trigger.type == "interval":
        seconds = max(trigger.interval_seconds or MIN_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS)
        return after + timedelta(seconds=seconds)

    hour, minute = parse_time_of_day(trigger.at_time or "00:00")

    if trigger.type == "daily":
        candidate = after.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= after:
            candidate += timedelta(days=1)
        return candidate

    if trigger.type == "weekly":
        days = sorted({int(day) % 7 for day in (trigger.weekdays or [])}) or [0]
        base = after.replace(hour=hour, minute=minute, second=0, microsecond=0)
        for offset in range(0, 8):
            candidate = base + timedelta(days=offset)
            if candidate <= after:
                continue
            if candidate.weekday() in days:
                return candidate
        return base + timedelta(days=7)

    if trigger.type == "monthly":
        day = trigger.day_of_month or 1
        for month_offset in range(0, 14):
            year, month = _add_months(after.year, after.month, month_offset)
            last_day = calendar.monthrange(year, month)[1]
            candidate = after.replace(
                year=year,
                month=month,
                day=min(day, last_day),
                hour=hour,
                minute=minute,
                second=0,
                microsecond=0,
            )
            if candidate > after:
                return candidate
        return after + timedelta(days=31)

    raise ValueError(f"Unknown trigger type {trigger.type!r}")


class Target(BaseModel):
    """What a schedule runs when it fires.

    ``kind`` selects which of the id/text fields is meaningful, mirroring the
    app's two separate saved-query stores (builder ``QueryDef`` vs custom SQL)
    plus one-off inline SQL, stored scripts, and the app's published script
    templates (``script_template``, resolved by name at run time).
    """

    kind: Literal["query", "sql", "sql_saved", "script", "script_template"]
    query_id: Optional[str] = None
    sql: Optional[str] = None
    sql_query_id: Optional[str] = None
    script_id: Optional[str] = None
    template_name: Optional[str] = None
    connection_id: Optional[str] = None
    timeout_seconds: int = Field(default=600, ge=1, le=7200)

    @model_validator(mode="after")
    def _require_kind_fields(self) -> "Target":
        required = {
            "query": ("query_id", self.query_id),
            "sql": ("sql", self.sql),
            "sql_saved": ("sql_query_id", self.sql_query_id),
            "script": ("script_id", self.script_id),
            "script_template": ("template_name", self.template_name),
        }[self.kind]
        if not required[1]:
            raise ValueError(f"target.{required[0]} is required when kind is '{self.kind}'")
        return self


class Trigger(BaseModel):
    """When a schedule fires."""

    type: Literal["interval", "daily", "weekly", "monthly"]
    interval_seconds: Optional[int] = Field(default=None, ge=MIN_INTERVAL_SECONDS, le=86400)
    at_time: Optional[str] = None
    weekdays: Optional[list[int]] = None
    day_of_month: Optional[int] = Field(default=None, ge=1, le=31)
    timezone: str = "local"

    @model_validator(mode="after")
    def _require_type_fields(self) -> "Trigger":
        if self.type == "interval":
            if not self.interval_seconds:
                raise ValueError("trigger.interval_seconds is required for an interval schedule")
        elif self.type == "weekly":
            if not self.at_time:
                raise ValueError("trigger.at_time is required for a weekly schedule")
            if not self.weekdays:
                raise ValueError("trigger.weekdays is required for a weekly schedule")
        elif self.type == "monthly":
            if not self.at_time:
                raise ValueError("trigger.at_time is required for a monthly schedule")
            if not self.day_of_month:
                raise ValueError("trigger.day_of_month is required for a monthly schedule")
        elif self.type == "daily":
            if not self.at_time:
                raise ValueError("trigger.at_time is required for a daily schedule")
        parse_time_of_day(self.at_time) if self.at_time else None
        return self


class OutputSpec(BaseModel):
    """What the run produces beyond its side effects."""

    mode: Literal["none", "snapshot"] = "none"
    snapshot_name: Optional[str] = None
    row_cap: int = Field(default=5000, ge=1, le=200000)


class ScheduleCreate(BaseModel):
    """Body for POST /schedules."""

    name: str = Field(min_length=1)
    description: Optional[str] = None
    enabled: bool = True
    target: Target
    trigger: Trigger
    output: OutputSpec = Field(default_factory=OutputSpec)


class ScheduleUpdate(BaseModel):
    """Body for PUT /schedules/{id} — every field optional (partial edit)."""

    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    enabled: Optional[bool] = None
    target: Optional[Target] = None
    trigger: Optional[Trigger] = None
    output: Optional[OutputSpec] = None
