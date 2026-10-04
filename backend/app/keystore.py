"""OS-keyring storage for secrets (connection passwords, AI API keys).

Secrets are never written to the JSON files under the app-data dir: they live
in the OS credential store (Windows Credential Manager) via the cross-platform
``keyring`` package, under the single service name ``ODBCQueryApp``. Callers
address entries with scoped account names, e.g. ``connection:<id>`` or
``ai:api_key``.

Reading is forgiving: when the backend is unavailable or an entry is missing,
``get_secret`` returns ``None`` (queries then simply fail with a login error
instead of crashing). Writing surfaces failures so a save that could not be
persisted securely is reported to the user instead of silently falling back to
plaintext on disk.
"""
import threading

_SERVICE = "ODBCQueryApp"

# ``keyring`` drags in a costly chain (jaraco.context and friends, ~0.6 s on a
# cold start) that nothing else here needs, so it is imported on first use
# instead of at module import. ``warm()`` pays that cost on a background thread
# during startup so the first secret lookup does not have to.
_keyring_module = None
_keyring_lock = threading.Lock()


def _keyring():
    """Return the ``keyring`` package, importing it on first use."""
    global _keyring_module
    if _keyring_module is None:
        with _keyring_lock:
            if _keyring_module is None:
                import keyring
                import keyring.errors

                _keyring_module = keyring
    return _keyring_module


def warm() -> None:
    """Eagerly import ``keyring`` off the startup path; best-effort."""
    try:
        _keyring()
    except Exception:  # noqa: BLE001 - warm-up must never break startup
        pass


def connection_account(connection_id: str) -> str:
    """Keyring account name for a saved connection's password."""
    return f"connection:{connection_id}"


def set_secret(account: str, value: str) -> None:
    """Store ``value`` in the OS keyring; raise when the store refuses."""
    _keyring().set_password(_SERVICE, account, value)


def get_secret(account: str) -> str | None:
    """Return the stored secret, or ``None`` when missing/unavailable."""
    try:
        keyring = _keyring()
    except Exception:  # noqa: BLE001 - keyring unavailable: report as no secret
        return None
    try:
        return keyring.get_password(_SERVICE, account)
    except keyring.errors.KeyringError:
        return None


def has_secret(account: str) -> bool:
    """True when a non-empty secret is stored under ``account``."""
    return bool(get_secret(account))


def delete_secret(account: str) -> None:
    """Remove a stored secret; a missing entry is treated as already gone."""
    try:
        keyring = _keyring()
    except Exception:  # noqa: BLE001 - keyring unavailable: nothing to delete
        return
    try:
        keyring.delete_password(_SERVICE, account)
    except keyring.errors.KeyringError:
        pass
