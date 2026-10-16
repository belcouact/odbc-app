"""JSON persistence helpers for application data files."""
import json
import os

from app.config import APP_DATA_DIR, ensure_data_dir


def load_json(filename: str, default):
    """Load a JSON file from the app data dir, returning `default` if missing/invalid."""
    path = os.path.join(APP_DATA_DIR, filename)
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def save_json(filename: str, data) -> None:
    """Write `data` as JSON to the app data dir, creating the dir if needed."""
    ensure_data_dir()
    path = os.path.join(APP_DATA_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def save_json_atomic(filename: str, data) -> None:
    """Write `data` as JSON through a temp file + atomic replace.

    A plain ``save_json`` truncates the target before writing, so a crash (or a
    second writer) mid-write can leave a half-written file. The scheduler's
    runner thread and its API both mutate ``schedules.json``, so those writes go
    through here: the temp file is flushed and fsynced, then ``os.replace``
    swaps it in atomically on the same volume.
    """
    ensure_data_dir()
    path = os.path.join(APP_DATA_DIR, filename)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
