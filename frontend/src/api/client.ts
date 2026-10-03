import axios from 'axios'
// A pinned dashboard visual: chart choices only, no data. Type-only import, so
// there is no runtime cycle with utils/visual (which imports chart build helpers).
import type { DashboardVisual } from '../utils/visual'
import type {
  AiMode,
  AiSettings,
  ChartOperation,
  ChartType,
  ColumnInfo,
  DatabaseType,
  DbConnection,
  DetectedDsn,
  HistoryEntry,
  QueryDef,
  QueryResult,
  QuerySource,
  SavedQuery,
  SavedQueryParameter,
  SavedSqlQuery,
  ScriptEntry,
  ScriptRunResult,
  ScriptTemplate,
  TableInfo,
} from '../types'

// Re-export the chart type aliases so existing imports (e.g. ChartsPanel) keep working.
export type { ChartOperation, ChartType } from '../types'

/** Payload used when creating/updating a connection (subset of DbConnection). */
export interface ConnectionPayload {
  name: string
  type: 'dsn' | 'string' | 'access'
  dsn?: string
  connection_string?: string
  driver?: string
  server?: string
  database?: string
  username?: string
  password?: string
  trusted_connection?: boolean
  database_type?: DatabaseType
  /** SharePoint/OneDrive link for an Access (.mdb/.accdb) file connection. */
  url?: string
  /** Local path for an Access file connection (fallback when no URL download). */
  local_path?: string
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string
}

/** One step of the Color_Data → FabLIMS lot-genealogy enrichment pipeline. */
export interface ColorEnrichStep {
  step: string
  status: 'running' | 'done'
  label: string
  detail?: string
}

/** Match counts reported when the lot-genealogy enrichment finishes. */
export interface ColorEnrichSummary {
  rows: number
  wol_total: number
  wol_matched: number
  batch_total: number
  batch_matched: number
  genealogy_rows: number
  cached: boolean
}

export interface ColorEnrichResult extends QueryResult {
  summary: ColorEnrichSummary
}

export interface ChartDataResponse {
  labels: (string | number)[]
  // `null` marks empty groups (trend gaps, box categories with no data).
  series: { name: string; data: (number | null)[] | number[][] }[]
  extra?: Record<string, unknown>
}

export type ExportFormat = 'xlsx' | 'csv'

/** A single input field of a connection template option (e.g. Tautona). */
export interface ConnectionTemplateField {
  key: string
  label: string
  type: string
  /** Comparison operator: '=', 'like', 'in', '>=', '<='. Defaults to '='. */
  operator?: string
  /** Optional fields may be left blank; the condition is then omitted. */
  optional?: boolean
  /** SQL column expression (defaults to label) used when rendering the condition. */
  column?: string
  /** Pre-filled value for the field (e.g. a default branch plant). */
  default?: string
  /** Greyed-out example value shown while the field is empty (hint only). */
  placeholder?: string
}

/** A per-row derived column declared by a template (evaluated after the query). */
export interface ConnectionTemplateComputedColumn {
  name: string
  /** Formula over the result columns, e.g. REGEXEXTRACT({NAME}, '...'). */
  expression: string
}

/** A connection template option (Tautona / Package / Lot genealogy …). */
export interface ConnectionTemplateOption {
  name: string
  fields: ConnectionTemplateField[]
  /** Parameterized SELECT template (':key' placeholders) used for the live preview. */
  sql?: string
  /** Derived columns appended to every result this option returns. */
  computed_columns?: ConnectionTemplateComputedColumn[]
  /** When true the option must not run with zero criteria — at least one field
   *  or user-added parameter has to be filled in (guards full-table scans). */
  require_filter?: boolean
}

/** A user-added template parameter: a column from the base SQL plus a filter. */
export interface ExtraFilterInput {
  column: string
  operator: string
  value: string
  /** Second bound value for BETWEEN. */
  valueTo?: string
}

/** One test component (ANALYSIS row) with the RESULT_NAMEs it produces. */
export interface TestComponent {
  name: string
  description: string
  result_names: string[]
}

/** Response of GET /connection-templates/{connection_name}. */
export interface ConnectionTemplatesResponse {
  connection_name: string
  options: ConnectionTemplateOption[]
}

/** One DL_ChannelMaster row (normalized display keys). */
export interface ChannelRow {
  operation: string
  group_name: string
  description: string
  DEVICE_NBR: string
  CHAN_NBR: string
}

/** A named, pre-defined channel set associated with a single operation. */
export interface ChannelSet {
  name: string
  operation: string
  channels: ChannelRow[]
}

/** Saved channel-set payload to POST /connection-templates/channel-sets. */
export interface ChannelSetInput {
  name: string
  operation: string
  channels: ChannelRow[]
}

/** A named, pre-defined test-component set (a list of RESULT_NAMEs). */
export interface ComponentSet {
  name: string
  result_names: string[]
}

/** Granular upload progress reported by uploadData. */
export interface UploadProgress {
  /** upload = sending bytes, read = backend parsing the file, import = rows
   *  being shipped into the grid. */
  stage: 'upload' | 'read' | 'import'
  /** Byte-level percent (0-99) while stage === 'upload'. */
  percent?: number
  /** Rows read from the file (stage 'read') or imported into the grid
   *  (stage 'import') so far. */
  rows?: number
  /** Total rows — known once parsing finished (stage 'import'). */
  totalRows?: number
}

/** Result of parsing an uploaded CSV/Excel file. */
export interface UploadParseResult {
  rows: Record<string, unknown>[]
  columns: { name: string; type: string }[]
  row_count: number
  elapsed_ms: number
  truncated: boolean
}

const client = axios.create({
  baseURL: '/api',
  timeout: 120000,
})

/**
 * Per-launch API token. The launcher starts the backend with a random token
 * and opens the browser at ``/?token=...``: we keep it in sessionStorage
 * (survives reloads, per tab), strip it from the address bar, and echo it on
 * every API call. The backend rejects tokenless API requests, which blocks
 * DNS-rebinding and other local pages from driving the API. Empty in dev mode
 * (no token configured there), where nothing is enforced.
 */
const APP_TOKEN = (() => {
  try {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('token')
    if (fromUrl) {
      window.sessionStorage.setItem('odbc_app_token', fromUrl)
      params.delete('token')
      const query = params.toString()
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (query ? `?${query}` : '') + window.location.hash,
      )
      return fromUrl
    }
    return window.sessionStorage.getItem('odbc_app_token') ?? ''
  } catch {
    return ''
  }
})()

/** Default headers for API requests, including the app token when configured. */
function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (APP_TOKEN) headers['X-App-Token'] = APP_TOKEN
  return headers
}

if (APP_TOKEN) {
  client.defaults.headers.common['X-App-Token'] = APP_TOKEN
}

/**
 * Stable id for *this browser tab*. sessionStorage survives reloads but is
 * per-tab, so the backend can track each open tab separately (heartbeats vs.
 * goodbye beacons). Used by the connection watchdog / auto-reconnect logic.
 */
const TAB_ID = (() => {
  const key = 'odbc_tab_id'
  try {
    let id = window.sessionStorage.getItem(key)
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      window.sessionStorage.setItem(key, id)
    }
    return id
  } catch {
    return `tab-${Math.random().toString(36).slice(2, 10)}`
  }
})()

/**
 * Tell the backend "this tab is really closing" (pagehide / unmount).
 * sendBeacon is delivered even while the page is going away. The watchdog
 * uses it to separate a deliberate quit (every tab said goodbye -> the exe
 * exits) from a frozen/sleeping tab (no goodbye -> restart and wait for the
 * page to reconnect).
 */
export function sendTabLeftBeacon(): void {
  try {
    const blob = new Blob([JSON.stringify({ tab: TAB_ID })], { type: 'application/json' })
    // sendBeacon cannot set custom headers, so the token rides in the URL.
    const url = APP_TOKEN ? `/api/tab-left?token=${encodeURIComponent(APP_TOKEN)}` : '/api/tab-left'
    navigator.sendBeacon(url, blob)
  } catch {
    // best effort: nothing to do if the browser refuses to send
  }
}

/** Extract a readable message from an axios error or any unknown failure. */
function toErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as Record<string, unknown> | undefined
    if (data) {
      const detail = data.detail
      if (typeof detail === 'string' && detail.trim()) return detail.trim()
      // FastAPI validation error: {detail: [{loc, msg, type}, ...]}
      if (Array.isArray(detail) && detail.length > 0) {
        const messages = detail
          .map((item) => {
            if (item && typeof item === 'object') {
              const msg = (item as Record<string, unknown>).msg
              return typeof msg === 'string' ? msg : JSON.stringify(item)
            }
            return JSON.stringify(item)
          })
          .filter(Boolean)
        if (messages.length > 0) return messages.join('; ')
      }
      if (typeof data.message === 'string' && data.message.trim()) return data.message.trim()
    }
    if (error.code === 'ECONNABORTED') return 'Request timed out. The backend may be busy or unreachable.'
    if (!error.response) return 'Cannot reach the backend server. Is it running?'
    return `Request failed (HTTP ${error.response.status})`
  }
  if (error instanceof Error && error.message) return error.message
  return 'Unexpected error'
}

/** Extract a readable message from an error whose response body is a Blob. */
async function toBlobErrorMessage(error: unknown): Promise<string> {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data
    if (data instanceof Blob && data.size > 0) {
      try {
        const text = await data.text()
        try {
          const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown }
          if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
          if (typeof parsed.message === 'string' && parsed.message.trim()) {
            return parsed.message.trim()
          }
        } catch {
          // Not JSON — show the raw text when it is short and readable.
          if (text.trim().length < 500) return text.trim()
        }
      } catch {
        // Ignore blob read failures and fall through.
      }
    }
  }
  return toErrorMessage(error)
}

/** Run a request and normalize failures into a thrown Error with a readable message. */
async function apiFetch<T>(request: Promise<{ data: T }>): Promise<T> {
  try {
    const response = await request
    return response.data
  } catch (error) {
    throw new Error(toErrorMessage(error))
  }
}

/**
 * POST and consume a streaming NDJSON response from the AI chat endpoint.
 *
 * The body is a newline-delimited stream of JSON events:
 *  - `{"type":"delta","text":...}` → forwarded to `onDelta` as the model writes.
 *  - `{"type":"error","detail":...}` → thrown as an Error after the stream ends.
 *  - `{"type":"result","reply":...}` → the resolved final reply.
 *
 * Native `fetch` (not Axios) is used so chunks can be consumed as they arrive,
 * giving the sidebar a live typewriter output instead of one block at the end.
 */
async function streamChat(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
): Promise<string> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = ''
    try {
      const data = (await response.json()) as { detail?: unknown }
      if (typeof data.detail === 'string' && data.detail.trim()) detail = data.detail.trim()
      else if (data.detail !== undefined) detail = JSON.stringify(data.detail)
    } catch {
      // Non-JSON error body — fall through to the generic message.
    }
    throw new Error(detail || `Request failed (HTTP ${response.status})`)
  }
  if (!response.body) {
    throw new Error('Streaming is not supported in this browser.')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let reply = ''
  let streamError: Error | null = null
  const handleEvent = (evt: Record<string, unknown>) => {
    if (evt.type === 'delta') {
      const text = String(evt.text ?? '')
      reply += text
      onDelta(text)
    } else if (evt.type === 'error') {
      streamError = new Error(String(evt.detail ?? 'AI request failed'))
    } else if (evt.type === 'result') {
      // Surface any part of the final reply not already delivered as a delta.
      const final = String(evt.reply ?? reply)
      if (final.length > reply.length) onDelta(final.slice(reply.length))
      reply = final
    }
  }
  const processLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      handleEvent(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // Skip a malformed line (e.g. a stray newline) rather than aborting.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIdx = buffer.indexOf('\n')
    while (newlineIdx >= 0) {
      processLine(buffer.slice(0, newlineIdx))
      buffer = buffer.slice(newlineIdx + 1)
      newlineIdx = buffer.indexOf('\n')
    }
  }
  // Flush any trailing bytes still buffered inside the decoder (a multi-byte
  // character may have been split across two chunks; stream:true holds it).
  buffer += decoder.decode()
  if (buffer.trim()) processLine(buffer)
  if (streamError) throw streamError
  return reply
}

/** Thrown when a running query is cancelled via the cancel endpoint. */
export class QueryCanceledError extends Error {
  constructor() {
    super('Query canceled.')
    this.name = 'QueryCanceledError'
  }
}

/**
 * Read a streaming NDJSON response produced by the backend run endpoints.
 *
 * The body is a newline-delimited stream of JSON events:
 *  - `{"type":"progress","rows":N}` → reported to `onProgress` as rows arrive.
 *  - `{"type":"error","detail":...}` → thrown as an Error.
 *  - `{"type":"canceled"}` → thrown as a QueryCanceledError.
 *  - `{"type":"result",...}` → resolved as the final `T`.
 *
 * Native `fetch` (not Axios) is used so the stream can be consumed chunk by
 * chunk, giving the UI row-fetch progress instead of one block after completion.
 *
 * `options.onRunId` receives the ``X-Run-Id`` response header as soon as the
 * headers arrive, enabling cancellation of the in-flight run.
 * `options.onStep` receives ``{"type":"step",...}`` events from the multi-stage
 * pipelines (e.g. the Color_Data lot-genealogy enrichment).
 */
async function streamQuery<T>(
  path: string,
  body: unknown,
  onProgress?: (rows: number) => void,
  options?: { onRunId?: (runId: string) => void; onStep?: (step: ColorEnrichStep) => void },
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = ''
    try {
      const data = (await response.json()) as { detail?: unknown }
      if (typeof data.detail === 'string' && data.detail.trim()) detail = data.detail.trim()
      else if (data.detail !== undefined) detail = JSON.stringify(data.detail)
    } catch {
      // Non-JSON error body — fall through to the generic message.
    }
    throw new Error(detail || `Request failed (HTTP ${response.status})`)
  }
  options?.onRunId?.(response.headers.get('X-Run-Id') ?? '')
  if (!response.body) {
    throw new Error('Streaming is not supported in this browser.')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: T | null = null
  let streamError: Error | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIdx = buffer.indexOf('\n')
    while (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (line) {
        let evt: Record<string, unknown>
        try {
          evt = JSON.parse(line) as Record<string, unknown>
        } catch {
          // Skip a malformed line (e.g. a stray newline) rather than aborting.
          newlineIdx = buffer.indexOf('\n')
          continue
        }
        if (evt.type === 'progress') {
          onProgress?.(Number(evt.rows ?? 0))
        } else if (evt.type === 'step') {
          options?.onStep?.(evt as unknown as ColorEnrichStep)
        } else if (evt.type === 'canceled') {
          streamError = new QueryCanceledError()
        } else if (evt.type === 'error') {
          streamError = new Error(String(evt.detail ?? 'Query failed'))
        } else if (evt.type === 'result') {
          result = evt as unknown as T
        }
      }
      newlineIdx = buffer.indexOf('\n')
    }
  }
  // Flush any trailing bytes still buffered inside the decoder (a multi-byte
  // character may have been split across two chunks; stream:true holds it).
  buffer += decoder.decode()
  if (buffer.trim()) {
    const evt = JSON.parse(buffer.trim()) as Record<string, unknown>
    if (evt.type === 'error') streamError = new Error(String(evt.detail ?? 'Query failed'))
    else if (evt.type === 'canceled') streamError = new QueryCanceledError()
    else if (evt.type === 'result') result = evt as unknown as T
  }
  if (streamError) throw streamError
  if (!result) throw new Error('Query finished without a result.')
  return result
}

/**
 * Read a streaming NDJSON response produced by the script runner.
 *
 * The body is a newline-delimited stream of JSON events:
 *  - `{"type":"stdout","chunk":...}` / `{"type":"stderr","chunk":...}` →
 *    forwarded to `onChunk` as they arrive (live progress).
 *  - `{"type":"error","detail":...}` → thrown as an Error.
 *  - `{"type":"result",...}` → resolved as the final `T`.
 *
 * Native `fetch` (not Axios) is used so the stream can be consumed chunk by
 * chunk, giving the UI live output instead of one block after completion.
 */
async function streamScript<T>(
  path: string,
  body: unknown,
  onChunk?: (chunk: string, kind: 'stdout' | 'stderr') => void,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = ''
    try {
      const data = (await response.json()) as { detail?: unknown }
      if (typeof data.detail === 'string' && data.detail.trim()) detail = data.detail.trim()
      else if (data.detail !== undefined) detail = JSON.stringify(data.detail)
    } catch {
      // Non-JSON error body — fall through to the generic message.
    }
    throw new Error(detail || `Request failed (HTTP ${response.status})`)
  }
  if (!response.body) {
    throw new Error('Streaming is not supported in this browser.')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: T | null = null
  let streamError: Error | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIdx = buffer.indexOf('\n')
    while (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (line) {
        let evt: Record<string, unknown>
        try {
          evt = JSON.parse(line) as Record<string, unknown>
        } catch {
          // Skip a malformed line (e.g. a stray newline) rather than aborting.
          newlineIdx = buffer.indexOf('\n')
          continue
        }
        if (evt.type === 'stdout') {
          onChunk?.(String(evt.chunk ?? ''), 'stdout')
        } else if (evt.type === 'stderr') {
          onChunk?.(String(evt.chunk ?? ''), 'stderr')
        } else if (evt.type === 'error') {
          streamError = new Error(String(evt.detail ?? 'Script failed'))
        } else if (evt.type === 'result') {
          result = evt as unknown as T
        }
      }
      newlineIdx = buffer.indexOf('\n')
    }
  }
  // Flush any trailing bytes still buffered inside the decoder.
  buffer += decoder.decode()
  if (buffer.trim()) {
    const evt = JSON.parse(buffer.trim()) as Record<string, unknown>
    if (evt.type === 'error') streamError = new Error(String(evt.detail ?? 'Script failed'))
    else if (evt.type === 'result') result = evt as unknown as T
  }
  if (streamError) throw streamError
  if (!result) throw new Error('Script finished without a result.')
  return result
}

export const api = {
  // ---- Connections ----
  getConnections: (): Promise<DbConnection[]> => apiFetch(client.get('/connections')),

  saveConnection: (data: ConnectionPayload): Promise<DbConnection> =>
    apiFetch(client.post('/connections', data)),

  updateConnection: (id: string, data: ConnectionPayload): Promise<DbConnection> =>
    apiFetch(client.put(`/connections/${encodeURIComponent(id)}`, data)),

  deleteConnection: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/connections/${encodeURIComponent(id)}`)),

  testConnection: (data: ConnectionPayload): Promise<TestConnectionResult> =>
    apiFetch(client.post('/connections/test', data)),

  /** List ODBC DSNs registered in the local Windows registry. */
  detectDsn: (): Promise<DetectedDsn[]> => apiFetch(client.get('/connections/detect')),

  // ---- Schema ----
  listTables: (connectionId: string): Promise<TableInfo[]> =>
    apiFetch(client.get(`/schema/${encodeURIComponent(connectionId)}/tables`)),

  listColumns: (connectionId: string, table: string): Promise<ColumnInfo[]> =>
    apiFetch(
      client.get(
        `/schema/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(table)}/columns`,
      ),
    ),

  // ---- Query ----
  runQuery: (
    query: QueryDef,
    onProgress?: (rows: number) => void,
    onRunId?: (runId: string) => void,
  ): Promise<QueryResult> => streamQuery<QueryResult>('/query/run', { query }, onProgress, { onRunId }),

  /** Cancel an in-flight run (see ``X-Run-Id`` on run endpoints). */
  cancelQuery: (runId: string): Promise<{ ok: boolean }> =>
    apiFetch(client.post(`/query/cancel/${encodeURIComponent(runId)}`)),

  /** Append the FabLIMS lot genealogy (Product by WOL, Raw_item by Batch) to
   *  Color_Data rows, streaming one progress step per stage. */
  enrichColorData: (
    payload: {
      rows: Record<string, unknown>[]
      columns: { name: string; type: string }[]
      refresh?: boolean
    },
    onStep?: (step: ColorEnrichStep) => void,
  ): Promise<ColorEnrichResult> =>
    streamQuery<ColorEnrichResult>('/color-lot/enrich', payload, undefined, { onStep }),

  exportQuery: async (query: QueryDef, format: ExportFormat): Promise<Blob> => {
    try {
      const response = await client.post(
        '/query/export',
        { query, format },
        { responseType: 'blob', timeout: 300000 },
      )
      return response.data as Blob
    } catch (error) {
      throw new Error(await toBlobErrorMessage(error))
    }
  },

  /** Export the result of a raw SQL statement as CSV or XLSX. */
  exportSql: async (connectionId: string, sql: string, format: ExportFormat): Promise<Blob> => {
    try {
      const response = await client.post(
        '/sql/export',
        { connection_id: connectionId, sql, format },
        { responseType: 'blob', timeout: 300000 },
      )
      return response.data as Blob
    } catch (error) {
      throw new Error(await toBlobErrorMessage(error))
    }
  },

  /** Export the rows already loaded in the grid (e.g. uploaded files). */
  exportGrid: async (
    rows: Record<string, unknown>[],
    columns: { name: string; type: string }[],
    format: ExportFormat,
  ): Promise<Blob> => {
    try {
      const response = await client.post(
        '/export/grid',
        { rows, columns, format },
        { responseType: 'blob', timeout: 300000 },
      )
      return response.data as Blob
    } catch (error) {
      throw new Error(await toBlobErrorMessage(error))
    }
  },

  /** Parse an uploaded CSV/Excel file into grid rows + column metadata. */
  uploadData: async (
    file: File,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadParseResult> => {
    // Step 1 — send the raw bytes. Multipart upload via axios gives reliable
    // byte-level progress; fetch cannot report upload progress on HTTP/1.1.
    const form = new FormData()
    form.append('file', file)
    const spooled = await apiFetch(
      client.post<{ id: string; bytes: number }>('/upload/file', form, {
        // Big files can take several minutes to upload.
        timeout: 600000,
        onUploadProgress: (e) => {
          if (!onProgress) return
          const total = e.total ?? 0
          if (total > 0) {
            onProgress({
              stage: 'upload',
              percent: Math.min(99, Math.round((e.loaded / total) * 100)),
            })
          }
        },
      }),
    )

    // Step 2 — stream the parse: NDJSON events deliver live row counts while
    // the grid rows arrive in batches (same reader pattern as streamQuery).
    const response = await fetch('/api/upload/parse/stream', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: spooled.id }),
    })
    if (!response.ok) {
      let detail = ''
      try {
        const data = (await response.json()) as { detail?: unknown }
        if (typeof data.detail === 'string' && data.detail.trim()) detail = data.detail.trim()
        else if (data.detail !== undefined) detail = JSON.stringify(data.detail)
      } catch {
        // Non-JSON error body — fall through to the generic message.
      }
      throw new Error(detail || `Request failed (HTTP ${response.status})`)
    }
    if (!response.body) {
      throw new Error('Streaming is not supported in this browser.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const rows: Record<string, unknown>[] = []
    let columns: { name: string; type: string }[] = []
    let rowCount = 0
    let truncated = false
    let elapsedMs = 0
    let streamError: Error | null = null

    const handleEvent = (evt: Record<string, unknown>) => {
      if (evt.type === 'progress') {
        if (!onProgress) return
        const stage = String(evt.stage ?? 'read') as UploadProgress['stage']
        const rowsEvent = evt.rows
        onProgress({
          stage,
          ...(stage === 'import' ? { rows: rows.length, totalRows: rowCount } : {}),
          ...(typeof rowsEvent === 'number' && stage === 'read' ? { rows: rowsEvent } : {}),
        })
      } else if (evt.type === 'result_begin') {
        columns = (evt.columns as { name: string; type: string }[]) ?? []
        rowCount = Number(evt.row_count ?? 0)
        truncated = Boolean(evt.truncated)
        onProgress?.({ stage: 'import', rows: 0, totalRows: rowCount })
      } else if (evt.type === 'result_rows') {
        const batch = (evt.rows as Record<string, unknown>[]) ?? []
        rows.push(...batch)
        onProgress?.({ stage: 'import', rows: rows.length, totalRows: rowCount })
      } else if (evt.type === 'result_end') {
        elapsedMs = Number(evt.elapsed_ms ?? 0)
      } else if (evt.type === 'error') {
        streamError = new Error(String(evt.detail ?? 'Could not parse the file'))
      }
    }
    const processLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        handleEvent(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        // Skip a malformed line (e.g. a stray newline) rather than aborting.
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx >= 0) {
        processLine(buffer.slice(0, newlineIdx))
        buffer = buffer.slice(newlineIdx + 1)
        newlineIdx = buffer.indexOf('\n')
      }
    }
    // Flush any trailing bytes still buffered inside the decoder (a multi-byte
    // character may have been split across two chunks; stream:true holds it).
    buffer += decoder.decode()
    if (buffer.trim()) processLine(buffer)
    if (streamError) throw streamError
    return { rows, columns, row_count: rowCount, elapsed_ms: elapsedMs, truncated }
  },

  // ---- Saved queries ----
  getSavedQueries: (): Promise<SavedQuery[]> => apiFetch(client.get('/saved-queries')),

  createSavedQuery: (
    name: string,
    description: string | undefined,
    query: QueryDef,
    parameters?: SavedQueryParameter[],
  ): Promise<SavedQuery> =>
    apiFetch(
      client.post('/saved-queries', {
        name,
        description: description ?? '',
        query,
        parameters: parameters ?? [],
      }),
    ),

  updateSavedQuery: (
    id: string,
    name: string,
    description: string | undefined,
    query: QueryDef,
    parameters?: SavedQueryParameter[],
  ): Promise<SavedQuery> =>
    apiFetch(
      client.put(`/saved-queries/${encodeURIComponent(id)}`, {
        name,
        description: description ?? '',
        query,
        ...(parameters !== undefined ? { parameters } : {}),
      }),
    ),

  deleteSavedQuery: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/saved-queries/${encodeURIComponent(id)}`)),

  // ---- Custom SQL (raw SQL workspace) ----
  getSqlQueries: (): Promise<SavedSqlQuery[]> => apiFetch(client.get('/sql-queries')),

  createSqlQuery: (
    name: string,
    description: string | undefined,
    sql: string,
    connectionId?: string | null,
  ): Promise<SavedSqlQuery> =>
    apiFetch(
      client.post('/sql-queries', { name, description: description ?? '', sql, connection_id: connectionId ?? null }),
    ),

  updateSqlQuery: (
    id: string,
    name: string,
    description: string | undefined,
    sql: string,
    connectionId?: string | null,
  ): Promise<SavedSqlQuery> =>
    apiFetch(
      client.put(`/sql-queries/${encodeURIComponent(id)}`, {
        name,
        description: description ?? '',
        sql,
        // Only touch connection_id when explicitly passed (undefined = leave as-is).
        ...(connectionId !== undefined ? { connection_id: connectionId ?? null } : {}),
      }),
    ),

  deleteSqlQuery: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/sql-queries/${encodeURIComponent(id)}`)),

  runSql: (
    connectionId: string,
    sql: string,
    limit?: number,
    onProgress?: (rows: number) => void,
    onRunId?: (runId: string) => void,
  ): Promise<QueryResult> =>
    streamQuery<QueryResult>(
      '/sql/run',
      { connection_id: connectionId, sql, limit },
      onProgress,
      { onRunId },
    ),

  /** Return result column metadata for a raw SQL statement (no rows fetched). */
  sqlColumns: (connectionId: string, sql: string): Promise<{ columns: { name: string; type: string }[] }> =>
    apiFetch(client.post('/sql/columns', { connection_id: connectionId, sql })),

  // ---- Connection templates (FabLIMS quick-search) ----
  getConnectionTemplates: (connectionName: string): Promise<ConnectionTemplatesResponse> =>
    apiFetch(client.get(`/connection-templates/${encodeURIComponent(connectionName)}`)),

  runConnectionTemplate: (
    connectionId: string,
    optionName: string,
    values: Record<string, string>,
    operators?: Record<string, string>,
    extraFilters?: ExtraFilterInput[],
  ): Promise<QueryResult> =>
    apiFetch(
      client.post('/connection-templates/run', {
        connection_id: connectionId,
        option_name: optionName,
        values,
        operators: operators ?? {},
        extra_filters: extraFilters ?? [],
      }),
    ),

  /** Distinct test components (ANALYSIS NAME + DESCRIPTION) with RESULT_NAMEs. */
  getTestComponents: (
    connectionName: string,
  ): Promise<{ connection_name: string; components: TestComponent[] }> =>
    apiFetch(client.get(`/connection-templates/${encodeURIComponent(connectionName)}/test-components`)),

  /** Saved test-component sets (named RESULT_NAME selections). */
  getComponentSets: (): Promise<{ sets: ComponentSet[] }> =>
    apiFetch(client.get('/connection-templates/component-sets')),

  saveComponentSet: (input: { name: string; result_names: string[] }): Promise<{ ok: boolean }> =>
    apiFetch(client.post('/connection-templates/component-sets', input)),

  deleteComponentSet: (name: string): Promise<{ ok: boolean; removed_count: number }> =>
    apiFetch(
      client.delete('/connection-templates/component-sets', {
        params: { name },
      }),
    ),

  /** Distinct operations in DL_ChannelMaster (single-select dropdown feed). */
  getChannelOperations: (
    connectionName: string,
  ): Promise<{ connection_name: string; operations: string[] }> =>
    apiFetch(client.get(`/connection-templates/${encodeURIComponent(connectionName)}/channel-operations`)),

  /** Channel rows for one operation, normalized to the display column keys. */
  getChannelsForOperation: (
    connectionName: string,
    operation: string,
  ): Promise<{ connection_name: string; operation: string; columns: { name: string; type: string }[]; rows: ChannelRow[] }> =>
    apiFetch(
      client.get(`/connection-templates/${encodeURIComponent(connectionName)}/channels`, {
        params: { operation },
      }),
    ),

  /** Saved channel sets, optionally filtered to one operation. */
  getChannelSets: (operation?: string): Promise<{ sets: ChannelSet[] }> =>
    apiFetch(
      client.get('/connection-templates/channel-sets', {
        params: operation ? { operation } : undefined,
      }),
    ),

  /** Persist a named channel set and associate it with its operation. */
  saveChannelSet: (input: ChannelSetInput): Promise<{ ok: boolean }> =>
    apiFetch(client.post('/connection-templates/channel-sets', input)),

  /** Delete a saved channel set by name, optionally scoped to one operation. */
  deleteChannelSet: (name: string, operation?: string): Promise<{ ok: boolean; removed_count: number }> =>
    apiFetch(
      client.delete('/connection-templates/channel-sets', {
        params: { name, operation: operation || undefined },
      }),
    ),

  /**
   * Pivot Process_Data raw rows + DL_ChannelMaster into a Wide table.
   * `rows` are the queried rows already in the grid; `channels` are the
   * device/channel rows of the selected pre-defined set (the SELECTED mapping).
   */
  transformData: (payload: {
    connection_id: string
    operation: string
    rows: Record<string, unknown>[]
    channels: ChannelRow[]
    sql?: string
  }): Promise<QueryResult> =>
    apiFetch(
      client.post('/connection-templates/transform', {
        connection_id: payload.connection_id,
        operation: payload.operation,
        rows: payload.rows,
        channels: payload.channels,
        sql: payload.sql ?? '',
      }),
    ),

  // ---- Charts & analysis ----
  getChartData: (
    source: QuerySource,
    chartType: ChartType,
    x: string,
    y: string | string[],
    operation: ChartOperation,
    result?: QueryResult | null,
  ): Promise<ChartDataResponse> => {
    const base =
      source.kind === 'builder'
        ? { query: source.query, chart_type: chartType, x, y, operation }
        : source.kind === 'sql'
          ? {
              connection_id: source.connectionId,
              sql: source.sql,
              chart_type: chartType,
              x,
              y,
              operation,
            }
          : { chart_type: chartType, x, y, operation }
    // Chart from the grid output when available, so the query is not re-run.
    const body = result ? { ...base, rows: result.rows, columns: result.columns } : base
    return apiFetch(client.post('/charts/data', body))
  },

  // ---- History ----
  getHistory: (limit?: number): Promise<HistoryEntry[]> =>
    apiFetch(client.get('/history', { params: limit !== undefined ? { limit } : undefined })),

  deleteHistoryEntry: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/history/${encodeURIComponent(id)}`)),

  clearHistory: (): Promise<{ ok: boolean }> => apiFetch(client.delete('/history')),

  // ---- AI assistant ----
  getAiSettings: (): Promise<AiSettings> => apiFetch(client.get('/ai/settings')),

  /** `key_label` is the "brand · model" the key belongs to, so the backend files
   *  it under that brand/model instead of keeping it as the last key used.
   *  `profile_label` labels the saved-configuration snapshot the settings page
   *  can re-load from its dropdown. */
  saveAiSettings: (
    settings: Partial<AiSettings> & { key_label?: string; profile_label?: string },
  ): Promise<AiSettings> => apiFetch(client.put('/ai/settings', settings)),

  testAi: (overrides?: Partial<AiSettings>): Promise<{ ok: boolean; message: string }> =>
    apiFetch(
      client.post('/ai/test', {
        provider: overrides?.provider,
        base_url: overrides?.base_url,
        api_key: overrides?.api_key,
        model: overrides?.model,
      }),
    ),

  askAiSql: (
    question: string,
    connectionId: string,
  ): Promise<{ sql: string; dbms: string | null }> =>
    apiFetch(client.post('/ai/nl-to-sql', { question, connection_id: connectionId })),

  aiSummary: (
    stats: Record<string, unknown>,
    context?: string,
  ): Promise<{ summary: string }> =>
    apiFetch(client.post('/ai/summary', { stats, context: context ?? '' })),

  /** Design several dashboard charts from a plain-language requirement. */
  aiDashboard: (payload: {
    requirement: string
    columns?: ResultColumn[]
    rows?: Record<string, unknown>[]
  }): Promise<{ charts: AiDashboardChart[] }> =>
    apiFetch(client.post('/ai/dashboard', payload, { timeout: 120000 })),

  /** Ask the AI to write and run a Python statistical analysis of the rows. */
  aiStats: (payload: {
    columns?: ResultColumn[]
    rows?: Record<string, unknown>[]
    requirement?: string
  }): Promise<AiStatsResult> =>
    apiFetch(client.post('/ai/stats', payload, { timeout: 180000 })),

  /**
   * Continuous assistant conversation with streamed output (global AI sidebar).
   * `mode` selects the specialty: sql | script | chart. `onDelta` is called
   * with each text chunk as the model generates it.
   */
  askAiChatStream: (
    body: {
      messages: { role: string; content: string }[]
      connectionId?: string
      columns?: ResultColumn[]
      rows?: Record<string, unknown>[]
      mode?: AiMode
      /** SQL currently in the editor — sent so the assistant can debug/modify it. */
      sql?: string
    },
    onDelta: (text: string) => void,
  ): Promise<string> =>
    streamChat(
      '/ai/chat/stream',
      {
        messages: body.messages,
        connection_id: body.connectionId,
        columns: body.columns,
        rows: body.rows,
        mode: body.mode,
        sql: body.sql,
      },
      onDelta,
    ),

  // ---- Scripts (pre-defined Python / JavaScript) ----
  runScript: (payload: {
    language: string
    script: string
    query?: QueryDef | null
    sql?: string | null
    connection_id?: string | null
    timeout_seconds?: number
    /** Pass grid rows directly; query/sql are then ignored by the backend. */
    rows?: Record<string, unknown>[] | null
  }): Promise<ScriptRunResult> => apiFetch(client.post('/scripts/run', payload)),

  /** Run a script, streaming stdout/stderr to ``onChunk`` as it executes. */
  runScriptStream: (
    payload: {
      language: string
      script: string
      query?: QueryDef | null
      sql?: string | null
      connection_id?: string | null
      timeout_seconds?: number
      /** Pass grid rows directly; query/sql are then ignored by the backend. */
      rows?: Record<string, unknown>[] | null
    },
    onChunk?: (chunk: string, kind: 'stdout' | 'stderr') => void,
  ): Promise<ScriptRunResult> =>
    streamScript<ScriptRunResult>('/scripts/run-stream', payload, onChunk),

  /** Run a Python transform script against the current grid rows. */
  gridTransform: (payload: {
    script: string
    rows: Record<string, unknown>[]
    columns?: { name: string; type: string }[]
    timeout_seconds?: number
  }): Promise<{
    rows: Record<string, unknown>[]
    columns: { name: string; type: string }[]
    row_count: number
    stdout: string
    elapsed_ms: number
  }> => apiFetch(client.post('/scripts/grid-transform', payload)),

  /** Ask the AI whether a grid-transformation requirement needs clarification. */
  aiGridClarify: (payload: {
    requirement: string
    columns?: { name: string; type: string }[]
    rows_sample?: Record<string, unknown>[]
  }): Promise<{ questions: string[] }> => apiFetch(client.post('/ai/grid/clarify', payload)),

  /** Generate a Python script that transforms the grid rows. */
  aiGridScript: (payload: {
    requirement: string
    questions?: string[]
    answers?: string[]
    columns?: { name: string; type: string }[]
    rows_sample?: Record<string, unknown>[]
  }): Promise<{ script: string }> => apiFetch(client.post('/ai/grid/script', payload)),

  /** Recent AI grid-transform scripts (newest first) for re-use. */
  getGridScriptHistory: (): Promise<GridScriptHistoryEntry[]> =>
    apiFetch(client.get('/ai/grid/history')),

  /** Store a generated grid script in the re-use history. */
  addGridScriptHistory: (payload: { requirement: string; script: string }): Promise<{ ok: boolean }> =>
    apiFetch(client.post('/ai/grid/history', payload)),

  /** Delete one stored grid script. */
  deleteGridScriptHistory: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/ai/grid/history/${id}`)),

  /**
   * Keep-alive ping tagged with this tab's id; the backend auto-stops (and
   * the launcher auto-restarts for reconnects) when tabs stop beating.
   * Short timeout so a dead backend flips the UI offline in seconds.
   */
  heartbeat: (): Promise<{ ok: boolean }> =>
    apiFetch(client.post('/heartbeat', { tab: TAB_ID }, { timeout: 8000 })),

  /** Liveness probe used by the auto-reconnect watcher; fails fast. */
  health: (): Promise<{ status: string }> => apiFetch(client.get('/health', { timeout: 4000 })),

  getScripts: (): Promise<ScriptEntry[]> => apiFetch(client.get('/scripts')),

  /** List available template scripts (Supabase ``templates/`` catalog, bundled fallback). */
  listScriptTemplates: (): Promise<ScriptTemplate[]> =>
    apiFetch(client.get('/scripts/templates')),

  /** Read a template script's file content (auto-load into the editor). */
  getScriptTemplate: (name: string): Promise<{ name: string; filename: string; content: string }> =>
    apiFetch(client.get(`/scripts/templates/${encodeURIComponent(name)}`)),

  createScript: (body: {
    name: string
    description?: string
    language: string
    script: string
    connection_id?: string | null
    query?: QueryDef | null
    sql?: string | null
  }): Promise<ScriptEntry> => apiFetch(client.post('/scripts', body)),

  updateScript: (
    id: string,
    body: {
      name?: string
      description?: string
      language?: string
      script?: string
      connection_id?: string | null
      query?: QueryDef | null
      sql?: string | null
    },
  ): Promise<ScriptEntry> => apiFetch(client.put(`/scripts/${encodeURIComponent(id)}`, body)),

  deleteScript: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/scripts/${encodeURIComponent(id)}`)),

  // ---- Report export (xlsx) ----
  exportReport: async (query: QueryDef, title?: string): Promise<Blob> => {
    try {
      const response = await client.post(
        '/report/export',
        { query, title: title ?? 'ODBC Query Report' },
        { responseType: 'blob', timeout: 300000 },
      )
      return response.data as Blob
    } catch (error) {
      throw new Error(await toBlobErrorMessage(error))
    }
  },

  // ---- Server control ----
  /** Stop the backend server (in-app Quit button; only effective when an
   *  embedded runner registered the live uvicorn server on app.state). */
  shutdown: (): Promise<{ ok: boolean; stopped: boolean }> => apiFetch(client.post('/shutdown')),

  // ---- Self update ----
  /** Current update-checker/installer state (see backend app/update.py). */
  updateStatus: (): Promise<UpdateStatus> => apiFetch(client.get('/update/status', { timeout: 8000 })),

  /** Re-check the published manifest now (fetches latest.json; may take a while on a share drive). */
  updateCheck: (): Promise<UpdateStatus> =>
    apiFetch(client.post('/update/check', {}, { timeout: 20000 })),

  /** Download the staged update and restart the app when idle. */
  updateStart: (): Promise<UpdateStatus> =>
    apiFetch(client.post('/update/start', {}, { timeout: 15000 })),

  /** Release history bundled with this build (Settings → About), newest first. */
  versionHistory: (): Promise<VersionHistoryResponse> =>
    apiFetch(client.get('/version-history', { timeout: 8000 })),

  // ---- Feedback board (top-bar button) ----
  /** This machine's nickname + anonymous author id (created on first use). */
  feedbackProfile: (): Promise<FeedbackProfile> =>
    apiFetch(client.get('/feedback/profile', { timeout: 8000 })),

  /** Rename this machine on the board. */
  saveFeedbackProfile: (nickname: string): Promise<FeedbackProfile> =>
    apiFetch(client.put('/feedback/profile', { nickname }, { timeout: 10000 })),

  /** The board: threads with reply/like counts. */
  feedbackThreads: (options?: {
    category?: FeedbackCategory | null
    status?: FeedbackStatus | null
    sort?: FeedbackSort
  }): Promise<{ threads: FeedbackThread[] }> =>
    apiFetch(
      client.get('/feedback/threads', {
        params: {
          category: options?.category ?? undefined,
          status: options?.status ?? undefined,
          sort: options?.sort ?? 'recent',
        },
        timeout: 15000,
      }),
    ),

  /** One thread plus its replies. */
  feedbackThread: (id: string): Promise<FeedbackThreadDetail> =>
    apiFetch(client.get(`/feedback/threads/${encodeURIComponent(id)}`, { timeout: 15000 })),

  createFeedbackThread: (payload: {
    title: string
    body: string
    category: FeedbackCategory
    attachments?: FeedbackAttachment[]
  }): Promise<FeedbackThread> =>
    apiFetch(client.post('/feedback/threads', payload, { timeout: 20000 })),

  updateFeedbackThread: (
    id: string,
    payload: {
      title?: string
      body?: string
      category?: FeedbackCategory
      status?: FeedbackStatus
    },
  ): Promise<FeedbackThread> =>
    apiFetch(
      client.put(`/feedback/threads/${encodeURIComponent(id)}`, payload, { timeout: 15000 }),
    ),

  deleteFeedbackThread: (id: string): Promise<{ ok: boolean; id: string }> =>
    apiFetch(client.delete(`/feedback/threads/${encodeURIComponent(id)}`, { timeout: 15000 })),

  createFeedbackReply: (
    threadId: string,
    payload: { body: string; attachments?: FeedbackAttachment[] },
  ): Promise<FeedbackReply> =>
    apiFetch(
      client.post(
        `/feedback/threads/${encodeURIComponent(threadId)}/replies`,
        payload,
        { timeout: 20000 },
      ),
    ),

  deleteFeedbackReply: (id: string): Promise<{ ok: boolean; id: string }> =>
    apiFetch(client.delete(`/feedback/replies/${encodeURIComponent(id)}`, { timeout: 15000 })),

  /** Toggle this machine's "same problem" vote. */
  toggleFeedbackLike: (
    threadId: string,
  ): Promise<{ liked: boolean; like_count: number }> =>
    apiFetch(
      client.post(`/feedback/threads/${encodeURIComponent(threadId)}/like`, {}, { timeout: 15000 }),
    ),

  /** Upload one screenshot/log for an upcoming post or reply. */
  uploadFeedbackAttachment: (
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<FeedbackAttachment> => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch(
      client.post('/feedback/attachments', form, {
        timeout: 120000,
        onUploadProgress: (event) => {
          if (!onProgress) return
          const total = event.total ?? 0
          if (total > 0) onProgress(Math.min(100, Math.round((event.loaded / total) * 100)))
        },
      }),
    )
  },

  // ---- BI warehouse (query snapshots) ----

  /** Local warehouse file path, snapshot/row counts and size on disk. */
  getWarehouseInfo: (): Promise<WarehouseInfo> =>
    apiFetch(client.get('/analytics/warehouse', { timeout: 15000 })),

  /** Snapshot metadata (no row payloads), newest first. */
  listSnapshots: (): Promise<SnapshotMeta[]> =>
    apiFetch(client.get('/analytics/snapshots', { timeout: 30000 })),

  /** Persist the current result grid as a new snapshot. */
  createSnapshot: (payload: SnapshotCreatePayload): Promise<SnapshotMeta> =>
    apiFetch(client.post('/analytics/snapshots', payload, { timeout: 120000 })),

  /** Snapshot metadata plus its stored rows. */
  getSnapshot: (id: string): Promise<SnapshotDetail> =>
    apiFetch(client.get(`/analytics/snapshots/${encodeURIComponent(id)}`, { timeout: 60000 })),

  /** Rename an existing snapshot. */
  renameSnapshot: (id: string, name: string): Promise<SnapshotMeta> =>
    apiFetch(
      client.put(
        `/analytics/snapshots/${encodeURIComponent(id)}`,
        { name },
        { timeout: 15000 },
      ),
    ),

  /** Replace a snapshot's stored rows with the current grid data. */
  updateSnapshotData: (id: string, payload: SnapshotDataPayload): Promise<SnapshotMeta> =>
    apiFetch(
      client.put(`/analytics/snapshots/${encodeURIComponent(id)}/data`, payload, { timeout: 120000 }),
    ),

  /** Delete a snapshot and all of its stored rows. */
  deleteSnapshot: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/analytics/snapshots/${encodeURIComponent(id)}`, { timeout: 30000 })),

  /** The snapshot's pinned dashboard visuals (empty list when none exist yet). */
  getDashboard: (id: string): Promise<DashboardPayload> =>
    apiFetch(client.get(`/analytics/snapshots/${encodeURIComponent(id)}/dashboard`, { timeout: 30000 })),

  /** Replace the snapshot's pinned dashboard visuals. */
  saveDashboard: (id: string, visuals: DashboardVisual[]): Promise<DashboardPayload> =>
    apiFetch(
      client.put(
        `/analytics/snapshots/${encodeURIComponent(id)}/dashboard`,
        { visuals },
        { timeout: 60000 },
      ),
    ),

  // ---- BI warehouse (snapshot relationships) ----

  /** All stored relationships, newest first (both tables' names included). */
  listRelationships: (): Promise<SnapshotRelationship[]> =>
    apiFetch(client.get('/analytics/relationships', { timeout: 30000 })),

  /** Store a new relationship between two snapshots. */
  createRelationship: (payload: RelationshipPayload): Promise<SnapshotRelationship> =>
    apiFetch(client.post('/analytics/relationships', payload, { timeout: 30000 })),

  /** Replace a relationship's definition. */
  updateRelationship: (id: string, payload: RelationshipPayload): Promise<SnapshotRelationship> =>
    apiFetch(
      client.put(`/analytics/relationships/${encodeURIComponent(id)}`, payload, { timeout: 30000 }),
    ),

  /** Delete a relationship (the snapshots themselves are untouched). */
  deleteRelationship: (id: string): Promise<{ ok: boolean }> =>
    apiFetch(client.delete(`/analytics/relationships/${encodeURIComponent(id)}`, { timeout: 30000 })),

  /** Flat join preview of the two snapshots on the relationship's keys. */
  previewRelationship: (id: string, limit = 500): Promise<RelationshipJoinPreview> =>
    apiFetch(
      client.get(`/analytics/relationships/${encodeURIComponent(id)}/preview`, {
        params: { limit },
        timeout: 120000,
      }),
    ),
}

/** Feedback category: bug report, idea, question or anything else. */
export type FeedbackCategory = 'bug' | 'idea' | 'question' | 'other'

/** Thread status: still open, or resolved by its author. */
export type FeedbackStatus = 'open' | 'resolved'

/** Board ordering: latest activity, newest post, or most "same problem" votes. */
export type FeedbackSort = 'recent' | 'newest' | 'top'

/** A file attached to a post or reply (already stored in Supabase Storage). */
export interface FeedbackAttachment {
  url: string
  name: string
  size: number
  type: string
}

/** One topic on the feedback board. */
export interface FeedbackThread {
  id: string
  title: string
  body: string
  category: FeedbackCategory
  status: FeedbackStatus
  author_name: string
  app_version: string
  attachments: FeedbackAttachment[]
  created_at: string
  updated_at: string
  reply_count: number
  like_count: number
  liked_by_me: boolean
  /** True when this machine posted it (edit/delete allowed). */
  mine: boolean
}

/** One reply under a topic. */
export interface FeedbackReply {
  id: string
  thread_id: string
  body: string
  author_name: string
  app_version: string
  attachments: FeedbackAttachment[]
  created_at: string
  mine: boolean
}

/** This machine's board identity. */
export interface FeedbackProfile {
  author_id: string
  nickname: string
}

/** GET /api/feedback/threads/{id} response. */
export interface FeedbackThreadDetail {
  thread: FeedbackThread
  replies: FeedbackReply[]
}

/** Snapshot of the backend update state machine (backend app/update.py). */
export interface UpdateStatus {
  supported: boolean
  source: string | null
  current_version: string
  latest_version: string | null
  min_version?: string | null
  available: boolean
  forced: boolean
  notes: string
  /** idle | checking | no_source | up_to_date | update_available |
   *  downloading | verifying | waiting_idle | restarting | error */
  state: string
  message: string
  error: string
  checked_at: number | null
  download_percent: number | null
  /** Bytes per second while downloading (null outside the download phase). */
  download_rate: number | null
}

/** One release entry from the bundled version history (backend app/data). */
export interface VersionHistoryEntry {
  version: string
  date: string
  notes: string
}

/** Response of GET /api/version-history. */
export interface VersionHistoryResponse {
  current_version: string
  history: VersionHistoryEntry[]
}

/** Column metadata from a query result grid ({ name, type }). */
export type ResultColumn = { name: string; type: string }

/** Local SQLite BI warehouse stats (GET /api/analytics/warehouse). */
export interface WarehouseInfo {
  path: string
  snapshot_count: number
  row_count: number
  size_bytes: number
}

/** Metadata for a stored query snapshot (no row payloads). */
export interface SnapshotMeta {
  id: string
  name: string
  source: string
  connection_id: string | null
  sql_text: string | null
  row_count: number
  columns: ResultColumn[]
  created_at: string
}

/** A stored query snapshot including its rows. */
export interface SnapshotDetail extends SnapshotMeta {
  rows: Record<string, unknown>[]
}

/** Request body for POST /api/analytics/snapshots. */
export interface SnapshotCreatePayload {
  name: string
  source?: string
  connection_id?: string | null
  sql_text?: string | null
  columns?: ResultColumn[]
  rows?: Record<string, unknown>[]
}

/** Request body for PUT /api/analytics/snapshots/{id}/data (refresh stored rows). */
export interface SnapshotDataPayload {
  source?: string
  connection_id?: string | null
  sql_text?: string | null
  columns?: ResultColumn[]
  rows?: Record<string, unknown>[]
}

/** A snapshot's pinned dashboard (GET/PUT /api/analytics/snapshots/{id}/dashboard). */
export interface DashboardPayload {
  snapshot_id: string
  visuals: DashboardVisual[]
  /** Null while the snapshot has never been charted. */
  updated_at: string | null
}

/** One AI-designed chart returned by POST /api/ai/dashboard. Maps onto the
 *  VisualConfig pipeline (see aiChartToVisual) so it renders like any pinned tile. */
export interface AiDashboardChart {
  chartType: ChartType
  x: string
  y: string[]
  operation: ChartOperation
  series?: string
  title?: string
  subtitle?: string
}

/** Result of POST /api/ai/stats: the AI-authored Python script and its output. */
export interface AiStatsResult {
  script: string
  stdout: string
  stderr: string
  timed_out: boolean
  elapsed_ms: number
}

/** A saved link between two warehouse snapshots (one column pair). */
export interface SnapshotRelationship {
  id: string
  name: string
  left_snapshot_id: string
  left_column: string
  /** 'left' keeps unmatched left rows; 'inner' drops them (join previews). */
  join_type: string
  right_snapshot_id: string
  right_column: string
  created_at: string
  /** Display names of both tables (resolved server-side). */
  left_name: string
  right_name: string
}

/** Request body for POST/PUT /api/analytics/relationships. */
export interface RelationshipPayload {
  name?: string
  left_snapshot_id: string
  left_column: string
  join_type?: string
  right_snapshot_id: string
  right_column: string
}

/** Flat join preview (GET /api/analytics/relationships/{id}/preview). */
export interface RelationshipJoinPreview {
  columns: string[]
  rows: Record<string, unknown>[]
  total: number
  /** True when the row cap cut the join short. */
  truncated: boolean
  /** How many left rows found at least one match. */
  matched_left: number
  left_row_count: number
  right_row_count: number
}

/** A stored AI grid-transform script kept for re-use. */
export interface GridScriptHistoryEntry {
  id: string
  requirement: string
  script: string
  created_at: string
}

/** Result of saving a file for the user. */
export interface DownloadResult {
  /** Absolute path the file was written to (legacy desktop app only; unused on the web). */
  savedPath?: string
  /** True when a native browser-style download was triggered. */
  browserFallback?: boolean
  /** True when the user cancelled the "Save As" dialog (legacy desktop app only; unused on the web). */
  cancelled?: boolean
}

/**
 * Save a Blob for the user using the browser's native download.
 *
 * Creates a temporary object URL and clicks a download anchor; always resolves
 * with ``{ browserFallback: true }``. Throws when saving fails.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<DownloadResult> {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { browserFallback: true }
}

export default client
