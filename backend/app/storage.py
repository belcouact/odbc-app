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
