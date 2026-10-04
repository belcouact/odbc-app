"""Packaged-app entry point (PyInstaller).

Runs the FastAPI app with an embedded uvicorn server, opens the default
browser once the server is ready, and supervises the server in a restart
loop:

* user closes every tab or presses Quit  -> reason "quit"   -> process exits;
* the browser went silent (laptop sleep, frozen tab) and the watchdog
  stopped the server -> reason "watchdog" -> the server restarts on the very
  same port (persisted in the state dir) so the still-open browser tab
  reconnects by itself, without a reload;
* an unexpected crash is retried the same way, with a circuit breaker that
  gives up after a few back-to-back fast failures and shows an error box.

Built as a windowed (no-console) onedir bundle (ODBCQueryApp.exe next to an
_internal\ tree), so stdout/stderr are redirected to
``%APPDATA%\\ODBCQueryApp\\server.log`` and fatal errors are shown in a
message box instead of a console.
"""
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser


def _find_free_port(start: int = 8000, tries: int = 20) -> int:
    """Return the first free localhost port at or above ``start``.

    Lets the packaged app start even when another instance (e.g. a dev
    server) already holds port 8000.
    """
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start  # fall back; uvicorn will surface the bind error


def _state_dir() -> str:
    """Per-user state dir (logs, saved port); created on demand."""
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    path = os.path.join(base, "ODBCQueryApp")
    os.makedirs(path, exist_ok=True)
    return path


def _log_path() -> str:
    return os.path.join(_state_dir(), "server.log")


def _redirect_streams() -> None:
    """Send stdout/stderr to a log file (windowed exe has no console)."""
    log_file = open(_log_path(), "a", encoding="utf-8", buffering=1)
    sys.stdout = log_file
    sys.stderr = log_file


def _load_saved_port() -> int | None:
    try:
        with open(os.path.join(_state_dir(), "port.txt"), encoding="utf-8") as fh:
            port = int(fh.read().strip())
        if 1024 <= port <= 65535:
            return port
    except Exception:
        pass
    return None


def _save_port(port: int) -> None:
    try:
        with open(os.path.join(_state_dir(), "port.txt"), "w", encoding="utf-8") as fh:
            fh.write(str(port))
    except Exception:
        pass


# ---- Per-launch API token ----
#
# The backend rejects API calls without this token (static assets stay open so
# the page can tell the user what is wrong). A browser tab receives it via the
# ``?token=`` URL parameter, keeps it in sessionStorage and echoes it on every
# request — so other local pages (DNS-rebinding or plain cross-origin) cannot
# drive the API, which includes arbitrary Python execution. Fresh launches
# rotate the token; the updater relaunch reuses the saved one so the pre-update
# tab reconnects, and a bookmark click on a running instance reads the token
# the running instance saved.

def _token_path() -> str:
    return os.path.join(_state_dir(), "token.txt")


def _load_saved_token() -> str:
    try:
        with open(_token_path(), encoding="utf-8") as fh:
            token = fh.read().strip()
        if token:
            return token
    except Exception:
        pass
    return ""


def _prepare_token(reuse_saved: bool) -> str:
    """Return this launch's API token, persisting it for bookmark/reconnect."""
    saved = _load_saved_token()
    if reuse_saved and saved:
        return saved
    token = secrets.token_urlsafe(32)
    try:
        with open(_token_path(), "w", encoding="utf-8") as fh:
            fh.write(token)
    except Exception:
        pass  # non-fatal: this launch still works; the next one regenerates
    return token


def _app_url(port: int, token: str = "") -> str:
    """Local app URL, carrying the token when one is configured."""
    suffix = f"/?token={token}" if token else "/"
    return f"http://127.0.0.1:{port}{suffix}"


def _port_is_bindable(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port() -> int:
    """Prefer the port used by the previous run.

    An open browser tab can only heal itself (reconnect without a reload)
    while the origin stays identical, so reuse the saved port whenever it is
    free again and only drift to a neighbour when something else grabbed it.
    """
    saved = _load_saved_port()
    if saved is not None and _port_is_bindable(saved):
        return saved
    return _find_free_port()


# ---- Already-running detection / odbcapp:// protocol bookmark ----
#
# A browser cannot start a local process from a plain http:// page, so the
# bookmark holds the custom ``odbcapp://`` scheme instead: clicking it hands
# the URL to Windows, which runs this exe (registered below in HKCU), and the
# exe opens the app in a tab.  A launch that finds a server already up only
# opens the tab — it never starts a second server.

_PROTOCOL = "odbcapp"
_PORT_SCAN_TRIES = 20
_SINGLE_INSTANCE_MUTEX = r"Local\ODBCQueryApp.SingleInstance"
# Never closed on purpose: the lock must live exactly as long as this process.
_instance_mutex_handle = None


def _health(port: int) -> dict | None:
    """Health payload of an ODBCQueryApp backend on ``port``, else ``None``."""
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=0.3
        ) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
        if isinstance(payload, dict) and payload.get("status") == "ok":
            return payload
    except Exception:
        pass
    return None


def _health_ok(port: int) -> bool:
    """True when an ODBCQueryApp backend answers on ``port``."""
    return _health(port) is not None


def _health_version(port: int) -> str:
    """Version reported by the backend on ``port`` ("" when unknown)."""
    payload = _health(port)
    return str(payload.get("version") or "") if payload else ""


def _build_version() -> str:
    """Version of *this* build (single source: app/version.py); "" if unknown."""
    try:
        from app.version import APP_VERSION

        return str(APP_VERSION or "")
    except Exception:
        return ""


def _version_key(value: str) -> tuple:
    """Numeric tuple for comparison: '1.1' == '1.1.0', trailing zeros dropped."""
    parts: list[int] = []
    for segment in (
        str(value or "")
        .strip()
        .replace("-", ".")
        .replace("+", ".")
        .replace("_", ".")
        .split(".")
    ):
        digits = ""
        for char in segment:
            if char.isdigit():
                digits += char
            else:
                break
        if not digits:
            break
        parts.append(int(digits))
    while parts and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def _is_current_or_newer(port: int) -> bool:
    """Whether the serving instance is this build's version or newer.

    A *newer* running instance is left alone (never downgrade to this build),
    but an *older* one must not be handed the browser — otherwise a freshly
    installed build keeps showing the previous version's page.  When either
    version is unknown, fall back to the old hand-off behaviour.
    """
    build = _build_version()
    running = _health_version(port)
    if not build or not running:
        return True
    return _version_key(running) >= _version_key(build)


def _running_port() -> int | None:
    """Port of an instance that is already serving, if any.

    Reuses the saved port from the previous run first (that is where a running
    instance sits), then scans the usual range in case it was started before a
    port was ever persisted.
    """
    candidates: list[int] = []
    saved = _load_saved_port()
    if saved is not None:
        candidates.append(saved)
    candidates.extend(
        port
        for port in range(8000, 8000 + _PORT_SCAN_TRIES)
        if port not in candidates
    )
    for port in candidates:
        if _health_ok(port):
            return port
    return None


def _acquire_single_instance() -> bool:
    """Claim the "one server per session" lock; False when someone else holds it.

    Two quick clicks on the bookmark must not spin up two servers on two ports
    (which would open two tabs with separate state), so the loser just waits
    for the winner and opens a tab on it.
    """
    global _instance_mutex_handle
    if _instance_mutex_handle:
        return True
    try:
        import ctypes

        handle = ctypes.windll.kernel32.CreateMutexW(None, False, _SINGLE_INSTANCE_MUTEX)
    except Exception:  # noqa: BLE001 - not Windows / no ctypes: never block startup
        return True
    if not handle:
        return True
    if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        return False
    _instance_mutex_handle = handle
    return True


def _wait_for_running_port(seconds: float = 30.0) -> int | None:
    """Poll for a backend another instance is still starting up.

    A one-file exe needs a moment to unpack before it serves anything, so the
    second launcher waits instead of assuming nobody is coming.
    """
    deadline = time.monotonic() + seconds
    while True:
        port = _running_port()
        if port is not None:
            return port
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.5)


def _retire_stale_instance(port: int, token: str) -> None:
    """Stop an older running build so this build can serve the page.

    Called when a *different, older* version answers on ``port`` — typically an
    instance left running from before this build was installed.  Without this
    the fresh launcher would hand the browser to the old server and the page
    would keep showing the previous version.  Asks it to quit, then waits for
    it to release both the port and the single-instance lock (the lock is
    claimed here, so the caller can start right away).
    """
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/shutdown",
            method="POST",
            headers={"X-App-Token": token} if token else {},
        )
        with urllib.request.urlopen(request, timeout=2.0) as response:
            response.read()
    except Exception:  # noqa: BLE001 - fall through to the wait below
        pass

    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if not _health_ok(port) and _acquire_single_instance():
            return
        time.sleep(0.3)


# PyInstaller's onefile bootloader exports a set of private launch variables to
# every child of the running app.  The browser is started *from* here, so it
# inherits them and hands them on to whatever it launches — including the
# ``odbcapp://`` handler, which is this very exe.  The bootloader then sees a
# parent executable that does not match its own archive and aborts with
# "Security validation failure: parent process has different executable!".
# The bootloader has already consumed these by the time Python runs, so
# dropping them here keeps the browser — and anything it starts — clean.
_PYI_PRIVATE_VARS = (
    "_PYI_ARCHIVE_FILE",
    "_PYI_APPLICATION_HOME_DIR",
    "_PYI_PARENT_PROCESS_LEVEL",
    "_PYI_SPLASH_IPC",
)


def _clear_pyi_environment() -> None:
    """Stop leaking PyInstaller's private launch variables to child processes."""
    for name in _PYI_PRIVATE_VARS:
        os.environ.pop(name, None)


def _ensure_protocol_registered() -> None:
    """Point ``odbcapp://`` at this exe (HKCU — no admin rights needed).

    Best effort: the bookmark is a convenience, so any registry trouble is
    swallowed rather than reported.  The command is rewritten only when it
    differs, so an exe that was moved heals the registration on its next
    normal launch.
    """
    if not getattr(sys, "frozen", False):
        return
    try:
        import winreg

        command = f'"{sys.executable}" "%1"'
        base = rf"Software\Classes\{_PROTOCOL}"
        command_key = base + r"\shell\open\command"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, command_key) as key:
                if winreg.QueryValueEx(key, "")[0] == command:
                    return  # already registered for this very exe
        except OSError:
            pass
        with winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER, base, 0, winreg.KEY_WRITE
        ) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "URL:ODBCQueryApp")
            winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
        with winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER, command_key, 0, winreg.KEY_WRITE
        ) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, command)
    except Exception:  # noqa: BLE001 - never let a shortcut break startup
        pass


def _show_error(title: str, message: str) -> None:
    """Show a native Windows error dialog; never raises (best-effort).

    Uses user32.MessageBoxW instead of tkinter so the packaged app does not
    need to bundle the Tcl/Tk runtime just for one error dialog.
    """
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)  # MB_ICONERROR
    except Exception:
        pass


# ---- Startup splash (native Win32, no Tcl/Tk) ----
#
# The packaged build ships without the Tcl/Tk runtime (see _show_error), so
# PyInstaller's built-in Splash -- which is Tcl/Tk based -- is not an option.
# This draws a small always-on-top "Starting…" window with raw user32/gdi32
# calls instead: no extra dependency and no growth in the bundle size.  It
# gives the user instant feedback during the ~2 s the backend needs to import
# and bind its port, so a shortcut launch never looks like nothing happened.

_SPLASH_CLASS = "ODBCQueryAppSplash"
_SPLASH_W, _SPLASH_H = 360, 110

try:
    import ctypes as _ct
    from ctypes import wintypes as _wt

    _user32 = _ct.windll.user32
    _gdi32 = _ct.windll.gdi32
    _shell32 = _ct.windll.shell32
    _kernel32 = _ct.windll.kernel32

    # LRESULT is pointer-sized; ctypes.wintypes has no LRESULT on this Python
    # and the default int restype would truncate 64-bit handles.
    _LRESULT = _ct.c_ssize_t
    _UINT_PTR = _ct.c_size_t

    class _PAINTSTRUCT(_ct.Structure):
        _fields_ = [
            ("hdc", _wt.HDC),
            ("fErase", _wt.BOOL),
            ("rcPaint", _wt.RECT),
            ("fRestore", _wt.BOOL),
            ("fIncUpdate", _wt.BOOL),
            ("rgbReserved", _ct.c_byte * 32),
        ]

    # The HWND param arrives as an int; WINFUNCTYPE keeps it pointer-sized.
    _WNDPROC = _ct.WINFUNCTYPE(_LRESULT, _wt.HWND, _wt.UINT, _wt.WPARAM, _wt.LPARAM)

    class _WNDCLASSW(_ct.Structure):
        _fields_ = [
            ("style", _wt.UINT),
            ("lpfnWndProc", _WNDPROC),
            ("cbClsExtra", _ct.c_int),
            ("cbWndExtra", _ct.c_int),
            ("hInstance", _wt.HINSTANCE),
            ("hIcon", _wt.HICON),
            ("hCursor", _wt.HANDLE),  # wintypes.HCURSOR is absent here
            ("hbrBackground", _wt.HBRUSH),
            ("lpszMenuName", _wt.LPCWSTR),
            ("lpszClassName", _wt.LPCWSTR),
        ]

    _user32.CreateWindowExW.restype = _wt.HWND
    _user32.CreateWindowExW.argtypes = [
        _wt.DWORD, _wt.LPCWSTR, _wt.LPCWSTR, _wt.DWORD,
        _ct.c_int, _ct.c_int, _ct.c_int, _ct.c_int,
        _wt.HWND, _wt.HANDLE, _wt.HINSTANCE, _wt.LPVOID,
    ]
    _user32.RegisterClassW.restype = _wt.UINT
    _user32.RegisterClassW.argtypes = [_ct.POINTER(_WNDCLASSW)]
    _user32.DefWindowProcW.restype = _LRESULT
    _user32.DefWindowProcW.argtypes = [_wt.HWND, _wt.UINT, _wt.WPARAM, _wt.LPARAM]
    _user32.BeginPaint.restype = _wt.HDC
    _user32.BeginPaint.argtypes = [_wt.HWND, _ct.POINTER(_PAINTSTRUCT)]
    _user32.EndPaint.restype = _wt.BOOL
    _user32.EndPaint.argtypes = [_wt.HWND, _ct.POINTER(_PAINTSTRUCT)]
    _user32.GetClientRect.restype = _wt.BOOL
    _user32.GetClientRect.argtypes = [_wt.HWND, _ct.POINTER(_wt.RECT)]
    _user32.DestroyWindow.restype = _wt.BOOL
    _user32.DestroyWindow.argtypes = [_wt.HWND]
    _user32.PostMessageW.restype = _wt.BOOL
    _user32.PostMessageW.argtypes = [_wt.HWND, _wt.UINT, _wt.WPARAM, _wt.LPARAM]
    _user32.PostQuitMessage.restype = None
    _user32.PostQuitMessage.argtypes = [_ct.c_int]
    _user32.SetTimer.restype = _UINT_PTR
    _user32.SetTimer.argtypes = [_wt.HWND, _UINT_PTR, _wt.UINT, _wt.LPVOID]
    _user32.GetMessageW.restype = _wt.BOOL
    _user32.GetMessageW.argtypes = [_ct.POINTER(_wt.MSG), _wt.HWND, _wt.UINT, _wt.UINT]
    _user32.TranslateMessage.restype = _wt.BOOL
    _user32.TranslateMessage.argtypes = [_ct.POINTER(_wt.MSG)]
    _user32.DispatchMessageW.restype = _LRESULT
    _user32.DispatchMessageW.argtypes = [_ct.POINTER(_wt.MSG)]
    _user32.ShowWindow.restype = _wt.BOOL
    _user32.ShowWindow.argtypes = [_wt.HWND, _ct.c_int]
    _user32.UpdateWindow.restype = _wt.BOOL
    _user32.UpdateWindow.argtypes = [_wt.HWND]
    _user32.GetSystemMetrics.restype = _ct.c_int
    _user32.GetSystemMetrics.argtypes = [_ct.c_int]
    _user32.LoadCursorW.restype = _wt.HANDLE
    _user32.LoadCursorW.argtypes = [_wt.HINSTANCE, _ct.c_void_p]
    _user32.DrawIconEx.restype = _wt.BOOL
    _user32.DrawIconEx.argtypes = [
        _wt.HDC, _ct.c_int, _ct.c_int, _wt.HICON,
        _ct.c_int, _ct.c_int, _wt.UINT, _wt.HBRUSH, _wt.UINT,
    ]
    _user32.LoadImageW.restype = _wt.HANDLE
    _user32.LoadImageW.argtypes = [
        _wt.HINSTANCE, _wt.LPCWSTR, _wt.UINT, _ct.c_int, _ct.c_int, _wt.UINT,
    ]
    _shell32.ExtractIconExW.restype = _wt.UINT
    _shell32.ExtractIconExW.argtypes = [
        _wt.LPCWSTR, _ct.c_int, _ct.POINTER(_wt.HICON), _ct.POINTER(_wt.HICON), _wt.UINT,
    ]
    _user32.DrawTextW.restype = _ct.c_int
    _user32.DrawTextW.argtypes = [
        _wt.HDC, _wt.LPCWSTR, _ct.c_int, _ct.POINTER(_wt.RECT), _wt.UINT,
    ]
    _gdi32.CreateFontW.restype = _wt.HFONT
    # 13 int fields (height, width, escapement, ...) then the face name.
    _gdi32.CreateFontW.argtypes = [_ct.c_int] * 13 + [_wt.LPCWSTR]
    _gdi32.SelectObject.restype = _wt.HGDIOBJ
    _gdi32.SelectObject.argtypes = [_wt.HDC, _wt.HGDIOBJ]
    _gdi32.SetTextColor.restype = _wt.DWORD
    _gdi32.SetTextColor.argtypes = [_wt.HDC, _wt.DWORD]
    _gdi32.SetBkMode.restype = _ct.c_int
    _gdi32.SetBkMode.argtypes = [_wt.HDC, _ct.c_int]
    _kernel32.GetModuleHandleW.restype = _wt.HMODULE
    _kernel32.GetModuleHandleW.argtypes = [_wt.LPCWSTR]

    _SPLASH_AVAILABLE = True
except Exception:  # noqa: BLE001 - non-Windows or an unexpected ctypes layout
    _SPLASH_AVAILABLE = False


class _Splash:
    """A small always-on-top 'Starting…' window shown while the app boots.

    Runs on its own daemon thread with its own message loop, because the main
    thread is about to block inside ``uvicorn``.  ``SW_SHOWNOACTIVATE`` and
    ``WS_EX_TOOLWINDOW`` keep it out of the way (never steals focus, no
    taskbar button); it is dismissed by ``close()`` once the browser has been
    opened, or by a 30-second timer as a last resort so it can never linger.
    Everything is best-effort: a failure here must not break startup.
    """

    def __init__(self, title: str, message: str) -> None:
        self._title = title
        self._message = message
        self._ready = threading.Event()
        self._done = threading.Event()
        self._hwnd = 0
        self._font = None
        self._icon = 0
        self._wndproc = None  # keep the callback alive for the window's life
        self._thread = threading.Thread(target=self._run, daemon=True, name="splash")
        self._thread.start()
        self._ready.wait(timeout=5.0)

    def close(self) -> None:
        """Ask the window to close and wait for its message loop to exit."""
        if self._done.is_set():
            return
        try:
            if self._hwnd:
                _user32.PostMessageW(self._hwnd, 0x0010, 0, 0)  # WM_CLOSE
        except Exception:
            pass
        self._done.wait(timeout=5.0)

    def _run(self) -> None:
        try:
            self._create()
            self._ready.set()
            self._pump()
        except Exception:  # noqa: BLE001 - splash is cosmetic only
            pass
        finally:
            self._ready.set()
            self._done.set()

    def _load_icon(self) -> int:
        """32x32 app icon: the exe's embedded icon when frozen, else the .ico."""
        try:
            if getattr(sys, "frozen", False):
                large = _wt.HICON()
                if _shell32.ExtractIconExW(sys.executable, 0, _ct.byref(large), None, 1) > 0:
                    return large.value or 0
                return 0
            path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app_icon.ico")
            if os.path.exists(path):
                # IMAGE_ICON, LR_LOADFROMFILE
                return _user32.LoadImageW(None, path, 1, 32, 32, 0x0010) or 0
        except Exception:
            pass
        return 0

    def _create(self) -> None:
        hinstance = _kernel32.GetModuleHandleW(None)
        self._wndproc = _WNDPROC(self._on_message)
        self._icon = self._load_icon()

        wc = _WNDCLASSW()
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = hinstance
        wc.hIcon = self._icon
        wc.hCursor = _user32.LoadCursorW(None, 32512)  # IDC_ARROW
        wc.hbrBackground = 6  # COLOR_WINDOW + 1
        wc.lpszClassName = _SPLASH_CLASS
        # Tolerate "class already registered" (e.g. a second splash this run).
        _user32.RegisterClassW(_ct.byref(wc))

        x = (_user32.GetSystemMetrics(0) - _SPLASH_W) // 2
        y = (_user32.GetSystemMetrics(1) - _SPLASH_H) // 2
        # WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE: on top, out of
        # the taskbar, and never steals focus.
        ex_style = 0x00000008 | 0x00000080 | 0x08000000
        # WS_POPUP | WS_BORDER | WS_VISIBLE.  WS_VISIBLE is set here on purpose:
        # the *first* ShowWindow() call is ignored when the launching process
        # supplies a STARTUPINFO (our case), so showing it that way is unreliable.
        style = 0x80000000 | 0x00800000 | 0x10000000
        self._hwnd = _user32.CreateWindowExW(
            ex_style, _SPLASH_CLASS, self._title, style,
            x, y, _SPLASH_W, _SPLASH_H, None, None, hinstance, None,
        )
        if not self._hwnd:
            raise OSError("splash window creation failed")

        self._font = _gdi32.CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI")
        _user32.SetTimer(self._hwnd, 1, 30000, None)  # last-resort auto-dismiss
        _user32.UpdateWindow(self._hwnd)

    def _pump(self) -> None:
        msg = _wt.MSG()
        while _user32.GetMessageW(_ct.byref(msg), None, 0, 0) > 0:
            _user32.TranslateMessage(_ct.byref(msg))
            _user32.DispatchMessageW(_ct.byref(msg))

    def _on_message(self, hwnd, msg, wparam, lparam):
        try:
            if msg == 0x000F:  # WM_PAINT
                ps = _PAINTSTRUCT()
                hdc = _user32.BeginPaint(hwnd, _ct.byref(ps))
                try:
                    _gdi32.SetBkMode(hdc, 1)  # TRANSPARENT
                    old = _gdi32.SelectObject(hdc, self._font) if self._font else None
                    if self._icon:
                        # DI_NORMAL
                        _user32.DrawIconEx(
                            hdc, 18, (_SPLASH_H - 32) // 2, self._icon, 32, 32, 0, None, 3
                        )
                    _gdi32.SetTextColor(hdc, 0x00303030)  # COLORREF
                    text_rect = _wt.RECT(62, 0, _SPLASH_W - 16, _SPLASH_H)
                    # DT_SINGLELINE | DT_VCENTER | DT_LEFT
                    _user32.DrawTextW(hdc, self._message, -1, _ct.byref(text_rect), 0x00000024)
                    if old:
                        _gdi32.SelectObject(hdc, old)
                finally:
                    _user32.EndPaint(hwnd, _ct.byref(ps))
                return 0
            if msg in (0x0010, 0x0113):  # WM_CLOSE / WM_TIMER
                _user32.DestroyWindow(hwnd)
                return 0
            if msg == 0x0002:  # WM_DESTROY
                _user32.PostQuitMessage(0)
                return 0
        except Exception:  # noqa: BLE001 - never let painting kill startup
            pass
        return _user32.DefWindowProcW(hwnd, msg, wparam, lparam)


def _start_splash(title: str, message: str):
    """Show the startup splash; returns the window or None when unavailable."""
    if not _SPLASH_AVAILABLE:
        return None
    try:
        return _Splash(title, message)
    except Exception:  # noqa: BLE001 - cosmetic only, never block startup
        return None


def _open_browser_when_ready(server, port: int, token: str, splash=None) -> None:
    """Wait for the server to finish starting, then open the app URL.

    Also dismisses the startup splash: whichever happens first -- the server
    coming up or the 30 s cap below -- the splash goes away in ``finally``.
    """
    try:
        for _ in range(300):
            if server.started:  # uvicorn Server.started is a plain bool
                webbrowser.open(_app_url(port, token))
                return
            time.sleep(0.1)
    finally:
        if splash is not None:
            splash.close()


# ---- Self-update support (pairs with app/update.py) ----

def _pending_update_path() -> str:
    return os.path.join(_state_dir(), "pending_update.json")


def _cleanup_old_backups(exe_path: str) -> None:
    """Delete '<install>.<version>.old' backups left behind by successful swaps.

    The backup is a sibling of the install directory (the onedir swap renames
    the whole folder aside). Files left by the former onefile scheme —
    '<exe>.<version>.old' next to the exe — are removed too.
    """
    install_dir = os.path.dirname(os.path.abspath(exe_path)) or "."
    folder = os.path.dirname(install_dir)
    base = os.path.basename(install_dir)
    try:
        for name in os.listdir(folder):
            if not (name.startswith(base + ".") and name.endswith(".old")):
                continue
            victim = os.path.join(folder, name)
            try:
                if os.path.isdir(victim):
                    shutil.rmtree(victim, ignore_errors=True)
                else:
                    os.remove(victim)
            except OSError:
                pass
    except OSError:
        pass


# ---- Onedir folder swap (runs *outside* this process) ----
#
# Windows refuses to rename a folder while any process still has a handle
# inside it that was not opened with FILE_SHARE_DELETE.  A onedir bundle keeps
# several such handles in the install folder for its whole lifetime — Python's
# zipimport holds ``_internal\base_library.zip`` open, and the loaded
# ``python311.dll`` / ``*.pyd`` image files are locked — so the old in-process
# swap always failed with "[WinError 5] Access is denied" when it tried to
# rename the install folder.  (The former onefile build worked by accident:
# everything was unpacked to %TEMP%, leaving only the share-deletable exe.)
#
# The fix: hand the swap to a detached helper that waits for this process to
# exit, so every handle is gone before the folder is renamed.
_UPDATE_HELPER_SCRIPT = """$ErrorActionPreference = 'Continue'
$log = '@@LOG@@'
function Log([string]$m) {
  try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) } catch {}
}
$parentPid = @@PARENT_PID@@
$target = '@@TARGET@@'
$backup = '@@BACKUP@@'
$staged = '@@STAGED@@'
$pending = '@@PENDING@@'
$exeName = '@@EXE_NAME@@'
$stagingRoot = '@@STAGING_ROOT@@'
$scriptPath = '@@SCRIPT@@'

Log "waiting for the app (pid $parentPid) to exit"
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 250
}
if (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {
  Log 'the app did not exit in time; stopping it'
  Stop-Process -Id $parentPid -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

try {
  if (Test-Path -LiteralPath $backup) {
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  }
  $moved = $false
  for ($i = 0; $i -lt 20; $i++) {
    try {
      Move-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop
      $moved = $true
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $moved) { throw 'the install folder is still in use and could not be renamed' }
  Log 'renamed the old install aside'
  try {
    Move-Item -LiteralPath $staged -Destination $target -Force -ErrorAction Stop
  } catch {
    Copy-Item -LiteralPath $staged -Destination $target -Recurse -Force -ErrorAction Stop
    Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
  }
  Log 'moved the staged build into place'
  Get-ChildItem -LiteralPath $backup -Filter 'unins*' -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $_.Name) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath (Join-Path $target $exeName) -ArgumentList '--updated' -WorkingDirectory $target
  Log 'update installed; the new build is starting'
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Log ("update failed: " + $_.Exception.Message)
  if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) {
    Move-Item -LiteralPath $backup -Destination $target -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath (Join-Path $target $exeName)) {
    Start-Process -FilePath (Join-Path $target $exeName) -WorkingDirectory $target -ErrorAction SilentlyContinue
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show("The update could not be installed:`r`n" + $_.Exception.Message + "`r`n`r`nThe previous version is starting again. Details in the log:`r`n" + $log, 'ODBCQueryApp') | Out-Null
  } catch {}
}
Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
"""


def _ps_quote(value: str) -> str:
    """Escape a path for a single-quoted PowerShell string literal."""
    return value.replace("'", "''")


def _spawn_update_helper(target: str, backup: str, staged: str, version: str) -> str:
    """Start the detached helper that swaps the install folder once we exit.

    Writes a small PowerShell script to %TEMP% and launches it detached; the
    script waits for this process to disappear (all file handles released),
    then renames the install folder aside, moves the staged folder in, carries
    the Inno Setup uninstaller over, drops the pending file and relaunches the
    new build with ``--updated``.  Returns the helper log path.
    """
    script_path = os.path.join(
        tempfile.gettempdir(), f"ODBCQueryApp-update-{version}.ps1"
    )
    replacements = (
        ("@@LOG@@", _ps_quote(os.path.join(_state_dir(), "update_helper.log"))),
        ("@@PARENT_PID@@", str(os.getpid())),
        ("@@TARGET@@", _ps_quote(target)),
        ("@@BACKUP@@", _ps_quote(backup)),
        ("@@STAGED@@", _ps_quote(staged)),
        ("@@PENDING@@", _ps_quote(_pending_update_path())),
        ("@@EXE_NAME@@", _ps_quote(os.path.basename(sys.executable))),
        ("@@STAGING_ROOT@@", _ps_quote(os.path.dirname(staged))),
        ("@@SCRIPT@@", _ps_quote(script_path)),
    )
    script = _UPDATE_HELPER_SCRIPT
    for token, value in replacements:
        script = script.replace(token, value)
    # utf-8-sig so Windows PowerShell (which assumes ANSI without a BOM) reads
    # a non-ASCII user name in the paths correctly.
    with open(script_path, "w", encoding="utf-8-sig") as fh:
        fh.write(script)

    powershell = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )
    if not os.path.exists(powershell):
        raise OSError("PowerShell was not found; cannot apply the update")

    env = dict(os.environ)
    for name in _PYI_PRIVATE_VARS:
        env.pop(name, None)  # keep the relaunched build's environment clean
    # CREATE_NO_WINDOW (0x08000000) rather than DETACHED_PROCESS: a detached
    # process gets no console and invalid std handles, and Windows PowerShell
    # 5.1 then exits silently before running a single line of the script.  It
    # is also handed DEVNULL stdio so the helper is never attached to a closed
    # pipe when this process exits.
    flags = 0x08000000 if os.name == "nt" else 0
    log_path = os.path.join(_state_dir(), "update_helper.log")
    try:
        os.remove(log_path)  # so the poll below only sees this run's output
    except OSError:
        pass
    subprocess.Popen(
        [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            script_path,
        ],
        cwd=tempfile.gettempdir(),
        creationflags=flags,
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    # The helper's first act is to log that it is waiting for us to exit.  If
    # that line never lands, the helper did not start and letting this process
    # exit would leave the update half-applied with the app gone -- so fail
    # loudly instead and keep running.
    deadline = time.monotonic() + 8.0
    while time.monotonic() < deadline:
        if os.path.exists(log_path):
            return log_path
        time.sleep(0.2)
    raise OSError(f"the update helper did not start (log: {log_path})")


def _apply_pending_update() -> bool:
    """Hand the staged update to a detached helper and let this process exit.

    The swap cannot run in-process: Windows will not rename the install folder
    while this process still holds handles inside it (zipimport keeps
    ``_internal\\base_library.zip`` open, the loaded ``python311.dll``/``*.pyd``
    images are locked), which is exactly the ``[WinError 5] Access is denied``
    the previous in-process swap hit.  So we start a helper that waits for this
    process to exit and only then renames the current install folder aside,
    moves the staged folder into place, carries the Inno Setup uninstaller over
    and relaunches the new build with ``--updated`` (no new browser tab; it
    reuses the saved port so the already-open page reconnects by itself).

    Returns True once the helper is running — the caller must then exit so the
    handles are released and the helper can do its work.
    """
    path = _pending_update_path()
    try:
        with open(path, encoding="utf-8") as fh:
            pending = json.load(fh)
        staged = str(pending["package"])
        target = str(pending["target"])
        version = str(pending.get("version") or "new")
        if not os.path.isdir(staged):
            raise OSError("the staged update folder is missing")
        backup = f"{target}.{version}.old"
        helper_log = _spawn_update_helper(target, backup, staged, version)
    except Exception as exc:  # noqa: BLE001 - always leave the user a working app
        _show_error(
            "ODBCQueryApp",
            "The update could not be installed:\n"
            f"{exc}\n\nThe previous version will keep running. "
            f"Details in the log:\n{_log_path()}",
        )
        return False
    print(f"update v{version} handed to the install helper; exiting so it can swap")
    print(f"helper log: {helper_log}")
    return True


# Restart-loop tuning: a run shorter than this counts as a fast failure; the
# supervisor gives up (and surfaces the error) after this many in a row.
_FAST_FAILURE_SECONDS = 10.0
_MAX_FAST_FAILURES = 3


def main() -> int:
    if getattr(sys, "frozen", False):
        # Must happen before anything opens a browser: a leaked
        # ``_PYI_ARCHIVE_FILE`` makes the odbcapp:// handler abort on launch.
        _clear_pyi_environment()
        _redirect_streams()
        _cleanup_old_backups(sys.executable)
        _ensure_protocol_registered()
        # Keep the working directory out of the install folder: the update
        # helper renames that folder, and a process CWD inside it would keep
        # it locked (and would be inherited by anything this process launches).
        os.chdir(_state_dir())

    # "--updated" is passed by _apply_pending_update: a browser tab is
    # already open on the saved port, so don't spawn another one.
    from_updater = "--updated" in sys.argv

    if not from_updater:
        # Bookmark click (odbcapp://) or a second exe launch: an instance is
        # already serving, so only show its page and leave the server alone —
        # unless it is an *older* build (e.g. one left running from before this
        # version was installed).  Handing the browser to that build would keep
        # showing the previous version, so retire it and start this build
        # instead.  A running instance of this version or newer is left alone.
        running = _running_port()
        if running is not None and _is_current_or_newer(running):
            webbrowser.open(_app_url(running, _load_saved_token()))
            return 0
        if running is not None:
            _retire_stale_instance(running, _load_saved_token())
        if not _acquire_single_instance():
            # Another instance is still unpacking/starting: wait for it and
            # show its page instead of starting a rival server on a new port.
            running = _wait_for_running_port()
            if running is not None:
                webbrowser.open(_app_url(running, _load_saved_token()))
            return 0

    # Fresh launch: rotate the per-launch API token. The updater relaunch
    # keeps the saved token so the pre-update tab reconnects. Must be set
    # before app.main is imported (it reads the token from the environment).
    token = _prepare_token(reuse_saved=from_updater)
    os.environ["ODBC_APP_TOKEN"] = token

    # Show a "Starting…" window during the ~2 s of imports/bind that follow.
    # Skipped on the updater relaunch: the pre-update tab is already open and
    # a second window would look like a second launch.
    splash = None if from_updater else _start_splash("ODBCQueryApp", "Starting ODBC Query App…")

    try:
        import uvicorn

        from app.main import app, arm_reattach_grace
    except Exception as exc:  # noqa: BLE001 - report any startup failure
        if splash is not None:
            splash.close()
        _show_error("ODBCQueryApp", f"Failed to start the app:\n{exc}")
        return 1

    port = _pick_port()
    _save_port(port)

    if from_updater:
        # Nobody has a page open *yet* (no tab was launched), so give the
        # pre-update browser tab a bounded chance to reconnect; if none
        # does, the watchdog exits the app instead of lingering headless.
        arm_reattach_grace()

    first_run = not from_updater
    fast_failures = 0
    last_error = ""

    while True:
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info")
        server = uvicorn.Server(config)
        # Lets the in-app Quit button (POST /api/shutdown) stop the server.
        app.state.uvicorn_server = server
        app.state.shutdown_reason = None

        print(f"Serving ODBCQueryApp at http://127.0.0.1:{port}")
        if first_run:
            # Only open a new tab on the very first launch; restarts after a
            # watchdog stop are meant to be picked up by the already-open page.
            first_run = False
            threading.Thread(
                target=_open_browser_when_ready,
                args=(server, port, token, splash),
                daemon=True,
            ).start()

        started_at = time.monotonic()
        crashed = False
        try:
            server.run()
        except KeyboardInterrupt:
            return 0  # console/dev stop: intentional exit
        except BaseException as exc:  # noqa: BLE001 - e.g. port already in use
            crashed = True
            last_error = str(exc)
            print(f"uvicorn stopped with an error: {exc!r}")

        reason = getattr(app.state, "shutdown_reason", None)
        if reason is None:
            reason = "crash" if crashed else "quit"
        ran_for = time.monotonic() - started_at

        if reason == "update":
            if _apply_pending_update():
                return 0  # new build was spawned and owns the port now
            # Swap failed: fall through and restart the old build so the
            # open page reconnects to something that still works.

        if reason == "quit":
            if crashed and ran_for < _FAST_FAILURE_SECONDS:
                # e.g. the very first bind failed: surface it, don't loop.
                if splash is not None:
                    splash.close()
                _show_error("ODBCQueryApp", f"The server stopped unexpectedly:\n{last_error}")
                return 1
            return 0

        # "watchdog" / "crash": restart so the still-open page can reconnect.
        if ran_for < _FAST_FAILURE_SECONDS:
            fast_failures += 1
            if fast_failures >= _MAX_FAST_FAILURES:
                if splash is not None:
                    splash.close()
                _show_error(
                    "ODBCQueryApp",
                    "The server kept failing to start. See the log at\n"
                    f"{_log_path()}\n\nLast error:\n{last_error or 'unknown'}",
                )
                return 1
        else:
            fast_failures = 0

        print(f"server stopped ({reason}) — restarting on port {port} for auto-reconnect")
        # Wait for a still-open page to beat again after the restart; if none
        # does, the app exits for good instead of lingering headless.
        arm_reattach_grace()
        time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main())
