"""Deferred heavy imports (pandas/numpy): loaded on first attribute use.

Importing pandas + numpy takes hundreds of milliseconds at process start.
API modules only need them inside request handlers, so they get a proxy that
performs the real ``import`` the first time an attribute is touched.  The app
window appears while pandas is still loading in the background.

Pair with ``from __future__ import annotations`` in the importing module so
``-> pd.DataFrame`` annotations stay strings at def-time instead of forcing
the import.
"""

from __future__ import annotations

import importlib


class _LazyModule:
    """Stand-in for a module that imports itself on first attribute use."""

    def __init__(self, name):
        self._name = name
        self._module = None

    def __getattr__(self, attr):
        if self._module is None:
            self._module = importlib.import_module(self._name)
        return getattr(self._module, attr)


def lazy_module(name: str) -> _LazyModule:
    """Return a proxy that imports ``name`` on first attribute access."""
    return _LazyModule(name)
