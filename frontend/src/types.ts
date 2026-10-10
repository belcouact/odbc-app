// Shared API contract types for the ODBCQueryApp frontend.

/** Database family used for SQL dialect / type detection. */
export type DatabaseType =
  | 'auto'
  | 'sqlserver'
  | 'oracle'
  | 'mysql'
  | 'postgresql'
  | 'jet'
  | 'other'

export interface DbConnection {
  id: string
  name: string
  type: 'dsn' | 'string' | 'access' | 'databricks'
  dsn?: string
  connection_string?: string
  driver?: string
  server?: string
  database?: string
  username?: string
  password?: string
  trusted_connection?: boolean
  database_type?: DatabaseType
  /** Azure Databricks SQL warehouse host (e.g. adb-1234.5.azuredatabricks.net). */
  server_hostname?: string
  /** Databricks HTTP path (e.g. /sql/1.0/warehouses/abcdef1234567890). */
  http_path?: string
  /** Default Unity Catalog catalog opened for the session. */
  default_catalog?: string
  /** Session query tags as "tag1:value1,tag2:value2". */
  query_tags?: string
  /** Resolved server type label (e.g. "Microsoft SQL Server", "Oracle"), set
   *  by the backend on GET /connections. Empty when it could not be resolved. */
  resolved_dbms?: string
  /** Stable key linking this connection to its GUI templates / predefined
   *  scripts / channel operations: the DSN, or the Access database file name
   *  (ColorDB.mdb -> "ColorDB"). Set by the backend. */
  template_key?: string
  /** SharePoint/OneDrive link for an Access (.mdb/.accdb) file connection. */
  url?: string
  /** Local path the Access connection resolves to (file_path is authoritative). */
  local_path?: string
  /** Resolved local .mdb/.accdb path (set by the backend). */
  file_path?: string
  created_at: string
}

export interface TableInfo {
  name: string
  type: 'table' | 'view'
}

export interface ColumnInfo {
  name: string
  data_type: string
  nullable: boolean
}

export interface FilterDef {
  column: string
  operator: string
  value: string
}

/** A calculated column appended to the SELECT list: ``expression AS name``. */
export interface DerivedColumn {
  name: string
  expression: string
}

export interface QueryDef {
  connection_id: string
  table: string
  columns: string[]
  filters: FilterDef[]
  derived_columns?: DerivedColumn[]
  date_column?: string
  date_from?: string
  date_to?: string
  limit?: number
}

export interface QueryResult {
  rows: Record<string, any>[]
  columns: { name: string; type: string }[]
  row_count: number
  elapsed_ms: number
  sql: string
}

/** Calendar bucket a date column is grouped to ('none' = keep the raw value). */
export type DateGrain = 'none' | 'year' | 'quarter' | 'month' | 'day'

/**
 * One condition of a drill-through filter handed from the Summary tab to the
 * results grid: keep the rows whose value on ``column`` is one of ``values``.
 * Values are stringified, and ``grain`` lets the grid re-apply the same date
 * bucketing the summary grouped by (so "2024-03" matches every March row).
 */
export interface GridDrillFilter {
  column: string
  values: string[]
  grain: DateGrain
}

/** A promptable parameter on a saved builder query. When the saved query is
 *  run, the user is asked for a value; it becomes a filter on ``column``. */
export interface SavedQueryParameter {
  /** Unique key used as the prompt label and stored value. */
  name: string
  /** Human-friendly label shown in the prompt dialog. */
  label: string
  /** Column the parameter value filters on. */
  column: string
  /** Comparison operator applied to the column with the entered value. */
  operator: string
  /** Optional pre-filled value. */
  default?: string
}

export interface SavedQuery {
  id: string
  name: string
  description?: string
  query: QueryDef
  parameters?: SavedQueryParameter[]
  created_at: string
}

/** Chart family supported by the charts endpoint. */
export type ChartType =
  | 'trend'
  | 'stepline'
  | 'area'
  | 'stackarea'
  | 'bar'
  | 'stackbar'
  | 'combo'
  | 'pie'
  | 'doughnut'
  | 'rose'
  | 'radar'
  | 'pareto'
  | 'waterfall'
  | 'funnel'
  | 'treemap'
  | 'heatmap'
  | 'histogram'
  | 'scatter'
  | 'bubble'
  | 'trendline'
  | 'errorbar'
  | 'spc'
  | 'sankey'
  | 'box'
  | 'gauge'
  | 'kpi'

/** Aggregation applied to the Y axis when building a chart. */
export type ChartOperation =
  | 'sum'
  | 'mean'
  | 'count'
  | 'distinct'
  | 'min'
  | 'max'
  | 'median'
  | 'std'
  | 'var'
  | 'first'
  | 'last'
  | 'p25'
  | 'p75'
  | 'p90'
  | 'share'
  | 'none'

/** An ODBC DSN found in the local Windows registry. */
export interface DetectedDsn {
  dsn: string
  driver: string
  scope: 'user' | 'system'
  bits: 32 | 64
  already_saved: boolean
}

/** A user-defined raw SQL query saved by the custom SQL workspace. */
export interface SavedSqlQuery {
  id: string
  name: string
  description?: string
  sql: string
  connection_id?: string | null
  created_at: string
  updated_at: string
}

/**
 * Where charts get their data from: either the visual builder query
 * definition, the free-form SQL editor text, or a manually uploaded CSV/Excel
 * file (rows come from the grid itself).
 */
export type QuerySource =
  | { kind: 'builder'; query: QueryDef }
  | { kind: 'sql'; connectionId: string; sql: string }
  | { kind: 'upload' }

/** A single entry in the query execution history. */
export interface HistoryEntry {
  id: string
  connection_id: string
  connection_name: string
  kind: 'builder' | 'sql'
  sql: string
  query?: Record<string, unknown> | null
  row_count: number
  elapsed_ms: number
  executed_at: string
}

/** AI assistant settings (stored locally by the backend). */
/** A previously saved AI configuration snapshot, listed in the load dropdown. */
export interface AiSettingsProfile {
  label: string
  enabled: boolean
  provider: string
  base_url: string
  api_key: string
  model: string
  temperature: number
  /** Privacy switch captured with this snapshot (see AiSettings). */
  share_data_stats?: boolean
  saved_at?: string
}

export interface AiSettings {
  enabled: boolean
  /** 'openai' (OpenAI-compatible chat completions) or 'anthropic' (Messages API). */
  provider: string
  base_url: string
  api_key: string
  model: string
  temperature: number
  /**
   * Privacy switch: when on, chat turns and the Insights card include a compact
   * statistical profile of the loaded grid (aggregated counts/ranges only).
   */
  share_data_stats?: boolean
  /** Keys held per "brand · model" label, so each brand keeps its own key. */
  saved_keys?: Record<string, string>
  /** Snapshots of previously saved configurations, newest first. */
  saved_profiles?: AiSettingsProfile[]
}

/** Aggregated token counters for one day / feature / model bucket. */
export interface AiUsageBucket {
  requests: number
  prompt_tokens: number
  completion_tokens: number
}

/** One recorded LLM call in the usage monitor's recent-calls list. */
export interface AiUsageEntry {
  ts: string
  feature: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  elapsed_ms: number
  ok: boolean
}

/** Response of GET /ai/usage (the token usage monitor store). */
export interface AiUsageSummary {
  daily: Record<string, AiUsageBucket>
  by_feature: Record<string, AiUsageBucket>
  by_model: Record<string, AiUsageBucket>
  /** Per-day buckets per model (same retention window as `daily`). */
  daily_by_model: Record<string, Record<string, AiUsageBucket>>
  /** Individual calls, newest last (same retention window as `daily`). */
  recent: AiUsageEntry[]
}

/** Specialty of the global AI sidebar conversation. */
export type AiMode = 'chat' | 'sql' | 'script' | 'chart'
/** Specialty of a streamed chat request — the Analyze page's follow-up chat
 *  reuses the endpoint with the 'analyze' specialty. */
export type AiChatMode = AiMode | 'analyze'

/** One column's aggregated statistics inside an AI data profile. */
export interface AiProfileColumn {
  name: string
  type?: string | null
  non_null: number
  missing: number
  missing_pct: number
  unique: number
  numeric?: Record<string, number>
  top?: { value: unknown; count: number }[]
}

/** Compact statistical profile of the loaded grid, produced by the backend. */
export interface AiDataProfile {
  row_total: number
  rows_profiled: number
  columns: AiProfileColumn[]
}

/** Result of POST /ai/insights: markdown analysis, guided questions, profile. */
export interface AiInsightResult {
  insights: string
  /** AI-suggested follow-up questions about the analysed grid (may be empty). */
  questions: string[]
  profile: AiDataProfile
}

/** Result of POST /ai/questions: guided follow-up questions only. */
export interface AiQuestionsResult {
  questions: string[]
}

export type ScriptLanguage = 'python' | 'javascript'

/** A saved pre-defined script together with its data source. */
export interface ScriptEntry {
  id: string
  name: string
  description?: string
  language: ScriptLanguage
  script: string
  connection_id?: string | null
  query?: QueryDef | null
  sql?: string | null
  created_at: string
  updated_at: string
}

/** Detail sections shown when a template row is expanded. */
export interface ScriptTemplateDetails {
  /** Input columns the script reads; without these it cannot run. */
  requires?: string[]
  /** Columns the script uses only when present (extra context). */
  optional?: string[]
  /** What the script produces when it runs. */
  outputs?: string[]
}

/** A finished sample the template produces, shown as a link in the picker. */
export interface ScriptTemplateExample {
  /** Public URL of the published sample dashboard. */
  url: string
  /** Human-readable title (the dashboard's own ``<title>``). */
  label?: string
}

/** A published script template listed in the template picker and dialog. */
export interface ScriptTemplate {
  /** Identifier used by the API (the file stem, e.g. ``analyze-mesa-yield``). */
  name: string
  /** File name as published, e.g. ``analyze-mesa-yield.py``. */
  filename: string
  /** Human-readable title from the catalog (falls back to the file name). */
  title?: string
  /** What kind of data the script is meant for (e.g. ``Mesa yield data``). */
  appliesTo?: string
  /** Short description from the catalog. */
  description?: string
  /** Required columns / outputs, shown when the row is expanded. */
  details?: ScriptTemplateDetails
  /** Published size, already formatted (e.g. ``34.1 KB``). */
  size?: string
  /** Publish timestamp, already formatted. */
  updated?: string
  /** Finished sample dashboard this template produces, when one is published. */
  example?: ScriptTemplateExample | null
}

/** A file a script wrote by relative path, returned so the frontend can save it. */
export interface ScriptOutputFile {
  filename: string
  path: string
  size: number
  data_base64: string
}

/** Result of POST /scripts/run. */
export interface ScriptRunResult {
  ok: boolean
  stdout: string
  stderr: string
  elapsed_ms: number
  row_count: number
  timed_out: boolean
  message?: string | null
  /** Files the script wrote into its staging folder (relative-path output). */
  output_files?: ScriptOutputFile[]
}
