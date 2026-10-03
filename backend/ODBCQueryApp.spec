# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for ODBCQueryApp.

Build:  .venv\\Scripts\\python.exe -m PyInstaller ODBCQueryApp.spec --noconfirm

Produces a windowed (no console) ONEDIR build at
dist\\ODBCQueryApp\\ODBCQueryApp.exe (+ dist\\ODBCQueryApp\\_internal\\…).
release.py zips that folder into dist\\ODBCQueryApp.zip for the self-updater.

Why onedir instead of onefile:
* onefile unpacks the whole bundle into %TEMP% on every launch (slow start,
  ~100 MB of disk churn per run); onedir starts instantly.
* self-extracting/Packed executables are a classic antivirus false-positive
  trigger; a plain exe + DLL tree is not.

All runtime data still resolves via ``sys._MEIPASS`` (which points at
_internal\\ in this layout) and ``__file__``, so the app needs no path
changes relative to the old onefile build.

UPX IS DELIBERATELY OFF: UPX-packed binaries are one of the strongest
heuristics for antivirus false positives — far more costly (blocked exe,
support tickets) than the ~20% size saving.

BUILD WITH THE VENV PYTHON: ``.venv\\Scripts\\python.exe -m PyInstaller ...``.
PyInstaller collects from whatever ``sys.path`` the *build* interpreter sees,
so a global Python also hands it that interpreter's whole site-packages.  Doing
that pulled pandas' optional accelerators into the exe — llvmlite (84 MB),
pyarrow (77 MB), matplotlib (10 MB) — and grew a ~28 MB build to 105 MB.
release.py resolves the venv interpreter itself; run it rather than calling
PyInstaller by hand.

VERSIONINFO: every build gets a Windows VERSIONINFO resource generated from
APP_VERSION (app\\version.py) and passed to EXE(version=…), so Explorer's
Properties dialog and any inventory tooling see the real version — an exe
without version metadata is itself mildly suspicious to AV heuristics.

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


def _current_version():
    with open(VERSION_FILE, encoding="utf-8") as fh:
        match = re.search(r'APP_VERSION\s*=\s*["\']([^"\']+)["\']', fh.read())
    return match.group(1) if match else "0.0.0"


def _write_version_resource(version):
    """Write a VERSIONINFO resource file for EXE(version=…); return its path.

    Regenerated on every build from the (possibly just-bumped) APP_VERSION, so
    the exe's Properties → Details always matches the release.
    """
    nums = [int(piece) for piece in re.findall(r"\d+", version)][:4]
    nums += [0] * (4 - len(nums))
    product = ".".join(str(piece) for piece in nums[:3])
    quad = ".".join(str(piece) for piece in nums)
    resource = f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({nums[0]}, {nums[1]}, {nums[2]}, {nums[3]}),
    prodvers=({nums[0]}, {nums[1]}, {nums[2]}, {nums[3]}),
    mask=0x3F,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0),
  ),
  kids=[
    StringFileInfo([
      StringTable('040904B0', [
        StringStruct('CompanyName', 'ODBCQueryApp'),
        StringStruct('FileDescription', 'Local SQL query workbench (ODBC / Excel / XPT)'),
        StringStruct('FileVersion', '{quad}'),
        StringStruct('InternalName', 'ODBCQueryApp'),
        StringStruct('LegalCopyright', ''),
        StringStruct('OriginalFilename', 'ODBCQueryApp.exe'),
        StringStruct('ProductName', 'ODBCQueryApp'),
        StringStruct('ProductVersion', '{product}'),
      ])
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])]),
  ]
)
"""
    path = os.path.join(backend_dir, "build", "version_info.txt")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(resource)
    return path


version_resource = _write_version_resource(_current_version())

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
        # Pantone TCX reference database -> <bundle>/app/data
        # (built by tools/build_pantone_db.py from templates/Pantone_TCX.xlsx)
        (
            os.path.join(backend_dir, "app", "data", "pantone_tcx.db"),
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
        # Secret storage (Windows Credential Manager via ctypes; imported
        # lazily by app.keystore).
        "keyring",
        "keyring.backends.Windows",
        # Lazy SQL parser used by the read-only guard (app.db.odbc).
        "sqlglot",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Everything below is never imported by the app at runtime; excluding it
    # keeps the packaged folder (and its zip) much smaller.
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
        # NOTE: sqlite3 is deliberately NOT excluded -- it reads the bundled
        # Pantone TCX reference database (app/data/pantone_tcx.db).
        # Unused stdlib documentation/debug/test modules.
        "pydoc", "pydoc_data", "doctest", "unittest", "unittest.mock",
        "pdb", "cmd", "bdb", "code", "xmlrpc", "smtplib", "telnetlib",
        "nntplib", "turtledemo", "turtle", "test", "test.support",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

# ONEDIR layout: the EXE only contains the bootloader + Python bytecode;
# all binaries and data live next to it in _internal\ (see COLLECT below).
# exclude_binaries=True is what makes this an onedir build.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ODBCQueryApp",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX-packed binaries trigger antivirus false positives
    console=False,  # windowed: no console window (browser-based UI)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(backend_dir, "app_icon.ico"),
    version=version_resource,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ODBCQueryApp",
)
