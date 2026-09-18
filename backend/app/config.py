"""Application configuration."""
import os

APP_NAME = "ODBCQueryApp"

# Application data directory, e.g. C:\Users\<user>\AppData\Roaming\ODBCQueryApp
APP_DATA_DIR = os.path.join(os.environ["APPDATA"], APP_NAME)


def ensure_data_dir() -> str:
    """Ensure the application data directory exists and return its path."""
    os.makedirs(APP_DATA_DIR, exist_ok=True)
    return APP_DATA_DIR
