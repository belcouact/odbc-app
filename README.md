# ODBC Query App

A local web application that lets non-technical users pull data out of any ODBC-connected
database through the browser — no SQL required. Build a query with ready-made templates,
explore the results in a data grid, chart or dashboard them, and hand the data to an AI
assistant for a quick read. Everything runs on one PC: the ODBC driver, the data and the
backend stay local, and the browser is only the UI.

## Highlights

- **Connections** — connect by ODBC **DSN**, by **connection string**, or to an **Access**
  (`.mdb`/`.accdb`) file hosted on **SharePoint/OneDrive** (or a local path). Installed DSNs are
  detected automatically; Windows Authentication is supported and each connection can be tested
  before saving.
- **Template quick-searches** — FabLIMS-style **connection templates** with ready-made criteria
  fields (dates, lots, branches …), optional columns, computed columns, saved channel /
  component sets and a Wide-table pivot. Fill the form and the SQL is generated for you.
- **Query workspace** — a visual query builder for tables/views, columns, filters and date
  ranges, plus a raw-SQL editor (with formatting) for power users. Save queries with parameters,
  or reuse the built-in **predefined SQL** library.
- **Data grid** — AG Grid with sort, filter, search, pagination, column resize, retype
  (Number / Text / Boolean / Date), copy to clipboard and drill-down.
- **Upload files** — load CSV / Excel files straight into the grid (streamed parsing with live
  progress), then analyze or export them like any query result.
- **Export** — one-click export to Excel (`.xlsx`), CSV or **SAS XPT**, plus a formatted
  `.xlsx` **report** for a query.
- **Charts & dashboard** — ECharts visuals (trend, area, bar, combo, pie/doughnut, radar,
  pareto, waterfall, funnel, treemap, heatmap, histogram, scatter, bubble, box, gauge, KPI, SPC,
  sankey …), a drag-and-drop **Graphic Walker** BI view, pinned dashboards and AI-generated chart
  sets.
- **Analyze (scripting)** — run Python or JavaScript against the rows in the grid, use template
  scripts, transform the grid in place, and stream `stdout` / `stderr` live.
- **BI warehouse** — snapshot query results into a local SQLite warehouse, pin dashboard visuals
  per snapshot and define relationships (joins) between snapshots.
- **AI assistant** — a global sidebar that helps write SQL, build scripts and interpret results
  in `sql` / `script` / `chart` modes, with streamed replies. Works with any OpenAI-compatible
  endpoint; the API key is stored in the Windows Credential Manager (keyring) and multiple
  configuration profiles are supported.
- **Color-lot enrichment** — append the FabLIMS lot genealogy (Product by WOL, Raw item by Batch)
  to `Color_Data` rows in one step.
- **Tools** — FlowDiagram, Project (timeline) and ProblemSolving, embedded from their web apps
  inside the tab.
- **Saved queries, history & templates** — save, reuse, share and re-run query definitions; a
  history of recent runs; and a catalog of template scripts.
- **Feedback board** — report problems or suggest ideas from inside the app (shared board).
- **Self-update** — published builds are picked up automatically, installed and the app restarts
  itself. A browser watchdog keeps the backend alive across laptop sleep and reconnects the open
  page.

## Architecture

```text
Browser (React SPA)
      ↓  /api  (HTTP)
FastAPI backend (Python)         ← also serves the built SPA
      ↓  pyodbc
Local ODBC driver
      ↓
Database (SQL Server / Oracle / DB2 / Access / MySQL / PostgreSQL / …)
```

The FastAPI backend serves both the API and, after a frontend build, the compiled SPA from a
single port. ODBC access lives entirely in the backend. User data is stored per user under
`%APPDATA%\ODBCQueryApp`; query results only leave it when you export them or send them to a
configured AI endpoint.

## Tech stack

| Layer     | Technology |
| --------- | ---------- |
| Frontend  | React 19, TypeScript, Vite 8, Material UI 9, AG Grid 36, ECharts 6, Graphic Walker, react-markdown |
| Backend   | Python 3.11+, FastAPI, uvicorn, pyodbc, pandas, openpyxl, python-calamine |
| Packaging | PyInstaller (single-file, windowed Windows exe) |

## Project structure

```text
ODBC app/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI entrypoint, static SPA serving, browser watchdog
│   │   ├── api/             # Route modules (connections, queries, charts, ai, feedback, …)
│   │   ├── db/              # ODBC access + SQL builder
│   │   ├── data/            # Bundled reference data (connection templates, Pantone TCX, history)
│   │   ├── resources/       # Bundled ECharts asset for script-generated HTML
│   │   └── config.py        # App data directory / settings
│   ├── custom script/       # Example analysis scripts
│   ├── sql/                 # Predefined SQL library
│   ├── launcher.py          # Packaged-app entry point (server supervisor / auto-reconnect)
│   ├── release.py           # Build / publish helper (+ latest.json manifest)
│   ├── ODBCQueryApp.spec    # PyInstaller spec
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── pages/           # Query workspace, Analyze, Dashboard, Settings, Feedback, tools, …
│   │   ├── components/      # Grid, charts, dialogs, AI sidebar, guided tour
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

- **User data** — saved connections, saved queries, SQL library, history, scripts, BI warehouse
  snapshots, logs and the chosen port are stored per user under `%APPDATA%\ODBCQueryApp`.
- **Connections** — configured in **Settings → Connections**: pick a DSN, a connection string, or
  an Access file (SharePoint/OneDrive URL or local path), fill in the details and click **Test**.
- **AI assistant** — configured in **Settings → AI Assistant**: choose a provider (any
  OpenAI-compatible endpoint), base URL, model and API key; save reusable profiles and test the
  connection. The key is stored in the Windows Credential Manager.
- **Endpoint reference** — `/api/health`, `/api/connections`, `/api/schema`, `/api/queries`,
  `/api/sql`, `/api/saved-queries`, `/api/sql-queries`, `/api/charts`, `/api/ai`, `/api/report`,
  `/api/analytics`, `/api/scripts`, `/api/connection-templates`, `/api/color-lot`, `/api/uploads`,
  `/api/version-history`, `/api/update`, `/api/feedback`, `/api/heartbeat`.
  The app title in the top bar (or the brand mark on phones) opens the intro animation, which is
  built into the frontend bundle.

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

- **Desktop-first.** The app is designed for a wide viewport used with a mouse and keyboard, and
  the layout adapts down to tablet/phone widths. Mobile and tablet use is not the primary target.
- **On-premise by default.** No internet connection is required to query local ODBC data sources;
  the feedback board and the self-update check use the network only when the app is online, and the
  AI assistant uses whatever endpoint you configure.

## Documentation

- [PRD.md](PRD.md) — objectives, requirements and success criteria.
- [backend/commands.txt](backend/commands.txt) — quick start commands for local development.
