# ODBC Query App

A local web application that lets non-technical users pull data out of any ODBC-connected
database through the browser — no SQL required. Build a query visually, explore the results in
a data grid, chart them, or hand the data to an AI assistant for a quick read.

## Highlights

- **Visual query builder** — pick a connection, database, table/view, columns, filters and a
  date range; the SQL is generated for you. A raw-SQL editor is available for power users.
- **Data grid** — sort, filter, search, paginate, resize columns, copy to clipboard, and retype
  columns (Number / Text / Boolean / Date).
- **Export** — one-click export to Excel (`.xlsx`), CSV, or SAS XPT.
- **Charts & dashboard** — bar, pie, trend, scatter, histogram, box, KPI and SPC charts, plus a
  dashboard builder and AI-generated chart sets.
- **Scripting** — run Python or JavaScript against the rows in the grid and copy the output.
- **AI assistant** — helps write SQL, build scripts, interpret results, and summarize findings.
- **Saved queries, history & templates** — save, reuse, share and re-run query definitions.
- **Feedback board** — report problems or suggest ideas from inside the app.
- **Self-update** — published builds are picked up automatically and installed without leaving
  the page.

## Architecture

```text
Browser (React SPA)
      ↓  /api  (HTTP)
FastAPI backend (Python)
      ↓  pyodbc
Local ODBC driver
      ↓
Database (SQL Server / Oracle / DB2 / Access / MySQL / …)
```

The FastAPI backend serves both the API and, after a frontend build, the compiled SPA from a
single port. ODBC access lives entirely in the backend — no database credentials reach the
browser, and queries are read-only by default.

## Tech stack

| Layer     | Technology |
| --------- | ---------- |
| Frontend  | React 19, TypeScript, Vite, Material UI, AG Grid, ECharts |
| Backend   | Python, FastAPI, uvicorn, pyodbc, pandas, openpyxl |
| Packaging | PyInstaller (single-file Windows exe) |

## Project structure

```text
ODBC app/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI entrypoint, static SPA serving, watchdog
│   │   ├── api/             # Route modules (connections, queries, charts, ai, …)
│   │   ├── db/              # ODBC access + SQL builder
│   │   ├── resources/       # Bundled ECharts assets
│   │   └── config.py        # App data directory / settings
│   ├── custom script/       # Example analysis scripts
│   ├── templates/           # Example report templates
│   ├── launcher.py          # Packaged-app entry point (server supervisor)
│   ├── release.py           # Build / publish helper
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── pages/           # Workspace, Script, BI, Settings, Feedback, …
│   │   ├── components/      # Grid, charts, dialogs, AI sidebar, tour
│   │   ├── api/             # Typed API client
│   │   └── utils/           # Chart, formula, format, column helpers
│   └── package.json
├── PRD.md                   # Product requirements
└── README.md
```

## Getting started

### Prerequisites

- Windows (the app targets a desktop browser on a single PC)
- An existing 64-bit **ODBC DSN** configured in Windows, plus its ODBC driver
- **Python 3.11+** and **Node.js 20+**

### 1. Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### 2. Frontend (development)

Run the Vite dev server with hot reload; it proxies `/api` to port 8000.

```powershell
cd frontend
npm install
npm run dev
```

### 3. Production build

Build the frontend, then let the backend serve it from `http://127.0.0.1:8000`.

```powershell
cd frontend
npm run build
```

The backend automatically serves `frontend/dist` when present, so a single command
(`uvicorn app.main:app`) is all that is needed to run the app.

## Configuration & data

- User data (saved connections, queries, history, logs, chosen port) is stored per user under
  `%APPDATA%\ODBCQueryApp`.
- Connections are configured in **Settings → Connections**: pick an ODBC driver, fill in the
  connection settings, and click **Test** to verify. Windows Authentication is supported.
- Endpoint reference: `/api/health`, `/api/connections`, `/api/schema`, `/api/queries`,
  `/api/saved`, `/api/charts`, `/api/ai`, `/api/report`, `/api/scripts`, `/api/update`.

## Packaging (Windows)

The packaged app is a single windowed exe that runs an embedded uvicorn server, opens the
browser, keeps the server alive across laptop sleep, and applies self-updates.

```powershell
cd backend
.venv\Scripts\pyinstaller.exe ODBCQueryApp.spec
```

See [release.py](backend/release.py) for the publish workflow that stages a build and refreshes
the `latest.json` update manifest.

## Notes

- **Desktop-first.** The app is designed for a wide viewport used with a mouse and keyboard.
  Mobile and tablet use is out of scope.
- **On-premise only.** No internet connection is required; the app runs against local ODBC
  data sources on a single PC.

## Documentation

- [PRD.md](PRD.md) — objectives, requirements and success criteria.
- [backend/commands.txt](backend/commands.txt) — quick start commands for local development.
