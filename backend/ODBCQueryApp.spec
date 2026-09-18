# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for ODBCQueryApp.

Build:  .venv\\Scripts\\python.exe -m PyInstaller ODBCQueryApp.spec --noconfirm

Produces a single windowed (no console) exe at dist\\ODBCQueryApp.exe.
All runtime data is resolved relative to ``__file__`` inside the bundle, so
the extra data is laid out at the same relative paths the app expects.

BUILD WITH THE VENV PYTHON: ``.venv\\Scripts\\python.exe -m PyInstaller ...``.
PyInstaller collects from whatever ``sys.path`` the *build* interpreter sees,
so a global Python also hands it that interpreter's whole site-packages.  Doing
that pulled pandas' optional accelerators into the exe — llvmlite (84 MB),
pyarrow (77 MB), matplotlib (10 MB) — and grew a ~28 MB build to 105 MB.
release.py resolves the venv interpreter itself; run it rather than calling
PyInstaller by hand.

NOTE: ``upx=True`` below does nothing unless upx.exe is reachable. A portable
copy lives in ``tools\\upx\\upx-4.2.4-win64\\`` *next to this spec file* (i.e.
``backend\\tools\\...``); release.py passes it via --upx-dir.  If you build by
hand instead, either add --upx-dir "<that folder>" or run from a shell whose
PATH contains it — setting PATH from inside this spec is too late, PyInstaller
resolves UPX beforehand.

VERSION PROMPT: every build asks whether APP_VERSION (app\\version.py) should be
incremented, so a released exe can never be published under a version that
clients already have.  Set ODBC_SKIP_VERSION_PROMPT=1 (or build with stdin
redirected) to answer with the current version automatically.  release.py
asks the same question before the build and sets this variable itself, so the
bundled version history can include the release being built.
"""
import os
import re
import sys

# SPECPATH is the directory holding this spec file (the backend dir).
backend_dir = os.path.abspath(SPECPATH)
app_root = os.path.dirname(backend_dir)  # project root (parent of backend)

VERSION_FILE = os.path.join(backend_dir, "app", "version.py")


def _bump_version(version, part):
    """Return ``version`` with ``part`` (patch/minor/major) incremented."""
    parts = [int(piece) for piece in version.split(".")]
    while len(parts) < 3:
        parts.append(0)
    index = {"major": 0, "minor": 1, "patch": 2}[part]
    parts[index] += 1
    for later in range(index + 1, 3):
        parts[later] = 0
    return ".".join(str(piece) for piece in parts[:3])


def _ask_version_bump():
    """Ask once per build whether APP_VERSION should be incremented.

    Runs only on an interactive terminal, so a scripted/CI build simply keeps
    the current version instead of hanging on ``input()``.
    """
    if os.environ.get("ODBC_SKIP_VERSION_PROMPT") == "1" or not sys.stdin.isatty():
        return
    try:
        with open(VERSION_FILE, encoding="utf-8", newline="") as fh:
            text = fh.read()
    except OSError as exc:
        print("WARNING: could not read %s: %s" % (VERSION_FILE, exc))
        return
    match = re.search(r'APP_VERSION\s*=\s*["\']([^"\']+)["\']', text)
    if not match:
        print("WARNING: no APP_VERSION found in %s" % VERSION_FILE)
        return
    current = match.group(1)
    print("\nCurrent APP_VERSION = %s" % current)
    answer = input(
        "Increment the version before building? "
        "[p]atch / [m]inor / [M]ajor / Enter = keep %s > " % current
    ).strip()
    part = {"p": "patch", "patch": "patch", "m": "minor", "minor": "minor",
            "M": "major", "major": "major"}.get(answer)
    if not part:
        print("Keeping APP_VERSION = %s\n" % current)
        return
    new_version = _bump_version(current, part)
    updated = re.sub(
        r'(APP_VERSION\s*=\s*)["\'][^"\']+["\']',
        lambda m: '%s"%s"' % (m.group(1), new_version),
        text,
        count=1,
    )
    with open(VERSION_FILE, "w", encoding="utf-8", newline="") as fh:
        fh.write(updated)
    print("APP_VERSION bumped: %s -> %s\n" % (current, new_version))


_ask_version_bump()

a = Analysis(
    [os.path.join(backend_dir, "launcher.py")],
    pathex=[backend_dir],
    binaries=[],
    datas=[
        # Built React frontend, served by the backend at <bundle>/frontend/dist
        (os.path.join(app_root, "frontend", "dist"), "frontend/dist"),
        # Custom script templates -> <bundle>/custom script
        (os.path.join(backend_dir, "custom script"), "custom script"),
        # Connection template config -> <bundle>/app/data
        (
            os.path.join(backend_dir, "app", "data", "connection_templates.json"),
            "app/data",
        ),
        # Release history shown in Settings -> About -> <bundle>/app/data
        # (release.py rewrites it before every build so it includes this release)
        (
            os.path.join(backend_dir, "app", "data", "version_history.json"),
            "app/data",
        ),
        # ECharts library for script-generated HTML -> <bundle>/app/resources
        (
            os.path.join(backend_dir, "app", "resources", "echarts.min.js"),
            "app/resources",
        ),
        # Predefined SQL files -> <bundle>/sql
        (os.path.join(backend_dir, "sql"), "sql"),
    ],
    hiddenimports=[
        # Imported at runtime by custom scripts (not at app startup).
        "app.resources.echarts",
        # Imported lazily: xlsx export (pandas), fast xlsx upload parsing
        # (python-calamine) and multipart form uploads.
        "openpyxl",
        "python_calamine",
        "multipart",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Everything below is never imported by the app at runtime; excluding it
    # keeps the single-file exe much smaller.
    excludes=[
        # Optional pandas dependency (never imported by the app or scripts).
        "scipy",
        # Optional pandas accelerators: `import pandas` never needs them, but
        # PyInstaller still collects them when they are importable.  llvmlite
        # (84 MB), pyarrow (77 MB) and matplotlib (10 MB) alone accounted for
        # most of a 105 MB build.  Belt and braces: the venv interpreter above
        # cannot even see them.
        "numba", "llvmlite", "pyarrow",
        "matplotlib", "mpl_toolkits", "kiwisolver", "contourpy", "cycler",
        "fontTools",
        # Interactive shells / editors: never used at runtime.
        "jedi", "parso", "IPython", "IPython.lib",
        # win32 COM automation: the app talks to databases through pyodbc.
        "win32com", "pythoncom", "pywintypes", "Pythonwin",
        # TLS for the update check uses the stdlib ssl module, not this.
        "cryptography",
        # Test frameworks pulled in via pandas/numpy test modules.
        "pytest", "_pytest", "pluggy", "iniconfig", "py", "pygments",
        # PIL: only used by openpyxl image support (unused by the app).
        "PIL", "Pillow",
        # tkinter: replaced by a native ctypes MessageBox in launcher.py
        # (also drops the bundled Tcl/Tk DLLs and data tree).
        "tkinter", "Tkinter", "_tkinter", "tcl", "tk",
        # sqlite3: reachable only via lazy pandas.io.sql paths; app uses ODBC.
        "sqlite3",
        # Unused stdlib documentation/debug/test modules.
        "pydoc", "pydoc_data", "doctest", "unittest", "unittest.mock",
        "pdb", "cmd", "bdb", "code", "xmlrpc", "smtplib", "telnetlib",
        "nntplib", "turtledemo", "turtle", "test", "test.support",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="ODBCQueryApp",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # windowed: no console window (browser-based UI)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(backend_dir, "app_icon.ico"),
)
