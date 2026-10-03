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
import keyring
import keyring.errors

_SERVICE = "ODBCQueryApp"


def connection_account(connection_id: str) -> str:
    """Keyring account name for a saved connection's password."""
    return f"connection:{connection_id}"


def set_secret(account: str, value: str) -> None:
    """Store ``value`` in the OS keyring; raise when the store refuses."""
    keyring.set_password(_SERVICE, account, value)


def get_secret(account: str) -> str | None:
    """Return the stored secret, or ``None`` when missing/unavailable."""
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
        keyring.delete_password(_SERVICE, account)
    except keyring.errors.KeyringError:
        pass
