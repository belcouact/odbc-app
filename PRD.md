# PRD - Local ODBC Query Web Application

## Objective

Provide a lightweight web application that allows users to query local ODBC-connected databases through a browser interface without requiring SQL knowledge.

---

## Target Users

- Process Engineers
- Quality Engineers
- Continuous Improvement Teams
- Manufacturing Analysts

---

## Architecture

```text
Browser
  ↓
Frontend (Web UI)
  ↓
Python API
  ↓
Local ODBC Driver
  ↓
Database
```

---

## Core Requirements

### 1. Database Connection

- Connect via existing local ODBC DSN
- Support Windows Authentication
- Multiple DSNs configurable

### 2. Query Builder

Users can:

- Select Database
- Select Table/View
- Select Columns
- Apply Filters
- Set Date Range
- Limit Returned Rows

No SQL knowledge required.

### 3. Query Execution

- Generate SQL automatically
- Execute through Python backend
- Return results in tabular format
- Display execution time
- Row count indicator

### 4. Data Grid

Features:

- Sorting
- Filtering
- Search
- Pagination
- Column resize
- Copy to clipboard

### 5. Export

Supported formats:

- Excel (.xlsx)
- CSV

### 6. Saved Queries

Users can:

- Save query definitions
- Reuse saved queries
- Delete saved queries
- Share query templates

---

## Optional Analytics

### Charts

- Trend Chart
- Pareto Chart
- Histogram
- Scatter Plot

### AI Analysis

User clicks:

```text
Analyze Result
```

System:

- Summarizes findings
- Detects outliers
- Highlights trends
- Generates recommendations

---

## Non-Functional Requirements

### Performance

- Query response < 5 seconds for typical datasets
- Support > 500,000 rows returned

### Security

- Backend only can access ODBC
- No database credentials exposed to browser
- Read-only query mode by default

### Platform Support

- **Desktop only.** The application targets a single Windows PC operated with a mouse and
  keyboard, viewed on a desktop-sized screen.
- **Mobile and tablet support is explicitly out of scope.** No responsive breakpoints,
  touch-gesture handling, or small-screen layouts are required, implemented, or tested.
- Layout assumes a wide viewport. Narrow / phone-sized windows are not a supported
  configuration and may render poorly.

### Deployment

- Pure web application: the FastAPI backend serves the built frontend from a single port
- Access via browser at `http://127.0.0.1:8000` (no desktop shell, no executable packaging)
- Single PC deployment
- On-premise only
- No internet required

---

## Technology Stack

### Frontend

- React
- AG Grid
- Material UI

### Backend

- Python
- FastAPI
- pyodbc
- pandas

### Database

- Any ODBC-compatible source
  - SQL Server
  - Oracle
  - DB2
  - Access
  - MySQL

---

## Future Enhancements

- Scheduled Reports
- Multi-User Access
- AI SQL Generation
- JMP Data Export
- Power BI Integration

---

## Success Criteria

- User can retrieve data without writing SQL.
- Query results displayed within seconds.
- Export to Excel completed in one click.
- No direct database access required by end users.