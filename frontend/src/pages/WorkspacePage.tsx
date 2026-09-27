import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
  SyntheticEvent,
} from 'react'
import AddIcon from '@mui/icons-material/Add'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CloseIcon from '@mui/icons-material/Close'
import CodeIcon from '@mui/icons-material/Code'
import DeleteIcon from '@mui/icons-material/Delete'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import FileOpenIcon from '@mui/icons-material/FileOpen'
import FileUploadIcon from '@mui/icons-material/FileUpload'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import GridViewIcon from '@mui/icons-material/GridView'
import FunctionsIcon from '@mui/icons-material/Functions'
import HelpOutlineOutlinedIcon from '@mui/icons-material/HelpOutlineOutlined'
import HistoryIcon from '@mui/icons-material/History'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import SaveIcon from '@mui/icons-material/Save'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import TableChartIcon from '@mui/icons-material/TableChart'
import Alert from '@mui/material/Alert'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import LinearProgress from '@mui/material/LinearProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import Grid from '@mui/material/Grid'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import type { SqlLanguage } from 'sql-formatter'
import { api, downloadBlob, QueryCanceledError } from '../api/client'
import type { ChannelSet, ComponentSet, ConnectionTemplateField, ConnectionTemplateOption, ColorEnrichStep, ExportFormat } from '../api/client'
import ChannelSelectDialog from '../components/ChannelSelectDialog'
import TestComponentsDialog from '../components/TestComponentsDialog'
import type {
  AiMode,
  ColumnInfo,
  DatabaseType,
  DbConnection,
  DerivedColumn,
  FilterDef,
  GridDrillFilter,
  HistoryEntry,
  QueryDef,
  QueryResult,
  SavedSqlQuery,
  TableInfo,
} from '../types'
import ResultsGrid from '../components/ResultsGrid'
import SummaryPanel from '../components/SummaryPanel'
import AiGridTransformDialog from '../components/AiGridTransformDialog'
import { evaluateFormula, type ComputedColumn } from '../utils/formula'
import PredefinedSqlPage from './PredefinedSqlPage'
import { subscribe } from '../editorBus'
import type { EditorAction } from '../editorBus'
import { publishWorkspaceSnapshot } from '../workspaceBus'

/** sql-formatter dialect for the active connection; T-SQL when it is unknown,
 *  since ODBC/DSN connections default to SQL Server in this app. */
const sqlDialectFor = (databaseType: DatabaseType | undefined): SqlLanguage => {
  switch (databaseType) {
    case 'sqlserver':
      return 'transactsql'
    case 'oracle':
      return 'plsql'
    case 'mysql':
      return 'mysql'
    case 'postgresql':
      return 'postgresql'
    case 'jet':
      return 'sqlite'
    default:
      return 'transactsql'
  }
}

/** One-line preview of the current SQL, shown on the collapsed editor strip. */
const sqlPreviewLine = (sql: string): string => {
  const flat = sql.trim().replace(/\s+/g, ' ')
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

/**
 * Bake derived columns into a result so the grid header (type chip) and the
 * chart field list both see them as regular columns. Columns whose name
 * collides with a real column or an earlier derived one are skipped, so a
 * template column never silently overwrites the data. Used both for the
 * displayed result and for the Color_Data lot-genealogy enrichment (which
 * needs the derived WOL / Batch keys before calling the backend).
 */
const bakeComputedColumns = (result: QueryResult, computed: ComputedColumn[]): QueryResult => {
  if (computed.length === 0) return result
  const existing = new Set(result.columns.map((col) => col.name))
  const applied = computed.filter((col) => {
    if (existing.has(col.name)) return false
    existing.add(col.name)
    return true
  })
  if (applied.length === 0) return result
  const columns = [...result.columns, ...applied.map((col) => ({ name: col.name, type: '' }))]
  const rows = result.rows.map((row) => {
    const derived: Record<string, unknown> = { ...row }
    for (const col of applied) {
      try {
        // Evaluate against the accumulating row so chained columns can
        // reference earlier calculated columns.
        derived[col.name] = evaluateFormula(col.expression, derived)
      } catch {
        derived[col.name] = null
      }
    }
    return derived
  })
  return { ...result, columns, rows }
}

/** Group key so repeated runs of the same query collapse to one "Recent runs" row. */
const historyDedupKey = (entry: HistoryEntry): string =>
  `${entry.connection_id ?? ''}\u0000${entry.kind}\u0000${
    entry.kind === 'builder' ? JSON.stringify(entry.query ?? {}) : entry.sql ?? ''
  }`

/** The "Recent runs" panel keeps only the newest entries so it stays scannable. */
const RECENT_RUNS_LIMIT = 20

const OPERATORS: { value: string; label: string }[] = [
  { value: '=', label: '=' },
  { value: '!=', label: '≠' },
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'in', label: 'in' },
  { value: 'is null', label: 'is null' },
  { value: 'is not null', label: 'is not null' },
]

const NULL_OPERATORS = new Set(['is null', 'is not null'])
const DATE_TYPE_RE = /date|time|timestamp/i
const NUMERIC_TYPE_RE = /int|number|decimal|numeric|float|double|real|money/i

/** Operator dropdown items for template fields, filtered by column data type:
 *  text gets equality/LIKE/IN, numbers and dates get comparisons, all get
 *  NULL checks; BETWEEN is available for numbers and dates. */
const TEMPLATE_OPERATORS: Record<string, string> = {
  '=': '=',
  '<>': '<>',
  like: 'LIKE',
  'not like': 'NOT LIKE',
  in: 'IN',
  'not in': 'NOT IN',
  'is null': 'IS NULL',
  'is not null': 'IS NOT NULL',
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
  between: 'BETWEEN',
}

/** Operators that don't need a value input (the value field is hidden). */
const IS_NULL_OPERATORS = new Set(['is null', 'is not null'])

/** Hover hint shown on the value field while a LIKE-style operator is active. */
const LIKE_TOOLTIP = "Use % as a wildcard — e.g. %abc% matches any value containing 'abc'."
/** Hover hint shown on the value field while an IN-style operator is active. */
const IN_TOOLTIP = "Separate multiple values with ';' — e.g. A; B."

/** Reference content for the "How to use operators" help dialog. */
const OPERATOR_GUIDE: { symbol: string; meaning: string; example: string }[] = [
  { symbol: '=', meaning: 'Equal to.', example: "status = 'Closed'" },
  { symbol: '<>', meaning: 'Not equal to.', example: "status <> 'Closed'" },
  { symbol: 'LIKE / NOT LIKE', meaning: 'Pattern match. You type the % wildcards yourself — %abc% contains, abc% starts with, %abc ends with.', example: "name LIKE 'Ave%'" },
  { symbol: 'IN / NOT IN', meaning: 'Value must / must not be in a list. Separate values with ;', example: "lot IN ('A'; 'B')" },
  { symbol: 'IS NULL / IS NOT NULL', meaning: 'Value is empty / not empty (no value input needed).', example: 'note IS NULL' },
  { symbol: 'BETWEEN', meaning: 'Value within an inclusive range — fill the from and to fields.', example: 'date BETWEEN 2024-01-01 AND 2024-01-31' },
  { symbol: '>  >=  <  <=', meaning: 'Greater than, greater or equal, less than, less or equal.', example: 'value >= 100' },
]

/** Popup explaining how to use the criteria operator symbols. */
function OperatorHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>How to use operators</Box>
        <IconButton onClick={onClose} aria-label="Close how to use operators">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Reference for the operator dropdowns in the criteria fields:
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" sx={{ minWidth: { xs: 560, sm: 0 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Operator</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>How to use</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Example</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {OPERATOR_GUIDE.map((row) => (
                <TableRow key={row.symbol} hover>
                  <TableCell
                    sx={{ fontWeight: 600, fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap' }}
                  >
                    {row.symbol}
                  </TableCell>
                  <TableCell>{row.meaning}</TableCell>
                  <TableCell
                    sx={{ fontFamily: 'Consolas, monospace', color: 'text.secondary', wordBreak: 'break-word' }}
                  >
                    {row.example}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
    </Dialog>
  )
}

function templateOperatorsForField(field: ConnectionTemplateField): string[] {
  if (DATE_TYPE_RE.test(field.type)) {
    return ['=', '<>', '>=', '>', '<=', '<', 'between', 'is null', 'is not null']
  }
  if (NUMERIC_TYPE_RE.test(field.type)) {
    return ['=', '<>', '>=', '>', '<=', '<', 'between', 'in', 'not in', 'is null', 'is not null']
  }
  return ['=', '<>', 'like', 'not like', 'in', 'not in', 'is null', 'is not null']
}

/** Data-type-aware operator list for a user-added parameter; mirrors the sets
 *  used for pre-defined template fields so the Op dropdown matches the Type. */
function extraOperatorsForType(dataType: string): string[] {
  if (dataType === 'date' || dataType === 'datetime') {
    return ['=', '<>', '>=', '>', '<=', '<', 'between', 'is null', 'is not null']
  }
  if (dataType === 'number') {
    return ['=', '<>', '>=', '>', '<=', '<', 'between', 'in', 'not in', 'is null', 'is not null']
  }
  return ['=', '<>', 'like', 'not like', 'in', 'not in', 'is null', 'is not null']
}

/** Data type options for a user-added parameter's value input. */
const EXTRA_DATA_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
] as const

/** Map a chosen data type to the native <input> type used for the value field. */
function valueInputType(dataType: string): string {
  switch (dataType) {
    case 'number':
      return 'number'
    case 'date':
      return 'date'
    case 'datetime':
      return 'datetime-local'
    default:
      return 'text'
  }
}

/** A single column reference: `name` or `table.name` (no quoting needed). */
const COLUMN_REF_RE = /^[A-Za-z_][A-Za-z0-9_$#]*(?:\.[A-Za-z_][A-Za-z0-9_$#]*)?$/

/** One filterable column offered in the template "Add parameter" dropdown:
 *  `value` is the table.column reference used in the WHERE clause; `label`
 *  is the friendly name (the base SQL SELECT alias, e.g. 'WOL' for
 *  gm_batch.TO_LOT). */
interface ColumnOption {
  value: string
  label: string
}

/** Unwrap a single aggregate around one column — e.g. `MAX(mys.lam_date)` →
 *  `mys.lam_date` — so the column can be offered as a WHERE filter. Returns
 *  null for expressions that aggregate multiple columns (e.g. `SUM(a)+SUM(b)`). */
function unwrapSingleAggregate(ref: string): string | null {
  const m = /^(?:MAX|MIN)\s*\(\s*([A-Za-z_][A-Za-z0-9_$#]*(?:\.[A-Za-z_][A-Za-z0-9_$#]*)?)\s*\)$/i.exec(
    ref.trim(),
  )
  return m ? m[1] : null
}

/** Parse one SELECT list item into a (columnRef, alias) pair. Handles an
 *  optional trailing alias — `AS 'x'`, `AS "x"`, `AS [x]`, `AS x` or a bare
 *  `x` (as in `mesa_lot_master.product Item`). Returns null for expressions
 *  such as ROUND(...) or (a + b), which cannot be used as a WHERE column. */
function parseSelectItem(item: string): ColumnOption | null {
  const trimmed = item.trim()
  const asMatch = /^(.+?)\s+AS\s+(?:'([^']*)'|"([^"]*)"|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_$#]*))$/i.exec(trimmed)
  let ref: string
  let alias: string | null = null
  if (asMatch) {
    ref = asMatch[1].trim()
    alias = asMatch[2] ?? asMatch[3] ?? asMatch[4] ?? asMatch[5] ?? null
  } else {
    const bareMatch = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_$#]*)$/.exec(trimmed)
    ref = bareMatch ? bareMatch[1].trim() : trimmed
    if (bareMatch) alias = bareMatch[2]
  }
  if (COLUMN_REF_RE.test(ref)) return { value: ref, label: alias || ref }
  // A single aggregate wrapped around one column (e.g. MAX(date) AS date) is
  // filterable on its inner column; keep the alias as the friendly label.
  const inner = unwrapSingleAggregate(ref)
  if (inner) return { value: inner, label: alias || inner }
  return null
}

/** Split a SELECT list on top-level commas (ignores commas inside parentheses). */
function splitTopLevel(selectList: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of selectList) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts
}

/** Extract the filterable columns from the template's base SELECT list.
 *  Returns {value, label} pairs so the "Add parameter" dropdown shows the
 *  friendly alias while the SQL keeps the real table.column. Expressions
 *  (e.g. ROUND(...) AS 'Qty') are skipped. For `SELECT *` or an empty base
 *  the configured field labels are used as a fallback. */
function extractTemplateColumns(option: ConnectionTemplateOption | null): ColumnOption[] {
  const templateSql = option?.sql ?? ''
  const base = templateSql.split('WHERE 1 = 1')[0] ?? ''
  const selectMatch = /\bSELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\bFROM\s/i.exec(base)
  const columns: ColumnOption[] = []
  if (selectMatch) {
    for (const rawItem of splitTopLevel(selectMatch[1])) {
      if (!rawItem.trim() || rawItem.trim() === '*') continue
      const parsed = parseSelectItem(rawItem)
      if (parsed && !columns.some((c) => c.value === parsed.value)) columns.push(parsed)
    }
  }
  if (columns.length > 0) return columns
  return (option?.fields ?? [])
    .map((field) => ({
      value: field.column ?? field.label ?? field.key,
      label: field.label ?? field.key,
    }))
    .filter((c) => c.value)
}

/** True when the base SELECT list is a bare `*` (or `table.*`), so the
 *  explicit column list cannot be parsed from the SQL text. */
function isStarSelect(option: ConnectionTemplateOption | null): boolean {
  const base = (option?.sql ?? '').split('WHERE 1 = 1')[0] ?? ''
  const selectMatch = /\bSELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\bFROM\s/i.exec(base)
  if (!selectMatch) return false
  const body = selectMatch[1].trim()
  return body === '*' || /^[A-Za-z_][\w$#]*\.\*$/.test(body)
}

/** First table name from the base SQL's FROM clause (may be schema-qualified). */
function extractPrimaryTable(option: ConnectionTemplateOption | null): string | null {
  const base = (option?.sql ?? '').split('WHERE 1 = 1')[0] ?? ''
  const fromMatch = /\bFROM\s+([^\s,;()]+)/i.exec(base)
  return fromMatch ? fromMatch[1].trim() : null
}

/** Single-quote a value for the live SQL preview ('' escapes a quote).
 *  The preview is display-only — the backend still uses bound parameters.
 *  Only the datetime-local 'T' separator (between digits) becomes a space,
 *  so text like 'Ave MVTR' stays untouched. */
function quoteSql(value: string): string {
  const normalized = value.replace(/(\d)T(\d)/g, '$1 $2')
  return `'${normalized.replace(/'/g, "''")}'`
}

/** Date-literal form the live SQL preview uses for a connection: Oracle needs
 *  TO_DATE(), Access/Jet needs '#...#', everything else compares plain quoted
 *  strings (mirrors the backend's resolve_dbms gating). */
type SqlDateDialect = 'plain' | 'oracle' | 'access'

/** Normalize a date-only or datetime-local value (e.g. '2024-01-15',
 *  '2024-01-15T10:30') to a full 'YYYY-MM-DD HH:MM:SS' timestamp: a bare date
 *  gets a midnight time and a minute-precision value gets ':00' seconds, so a
 *  fixed-format date literal always parses. */
function normalizeTimestamp(value: string): string {
  const v = value.trim().replace(/(\d)T(\d)/g, '$1 $2')
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} 00:00:00`
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return `${v}:00`
  return v
}

/** Oracle TO_DATE() literal — comparing a DATE column to a bare string
 *  otherwise raises ORA-01861. */
function toDateSql(value: string): string {
  return `TO_DATE(${quoteSql(normalizeTimestamp(value))}, 'YYYY-MM-DD HH24:MI:SS')`
}

/** Access/Jet date literal. Jet rejects a single-quoted string in a criteria
 *  expression against a Date/Time column ("Data type mismatch in criteria
 *  expression", -3030); '#...#' is the accepted form. */
function toJetDateSql(value: string): string {
  return `#${normalizeTimestamp(value)}#`
}

/** Pick the date-literal dialect for a connection. Access file connections
 *  carry no database_type, so the resolved DBMS name and the connection kind
 *  are consulted as well. */
function sqlDateDialect(connection: DbConnection | null | undefined): SqlDateDialect {
  const type = (connection?.database_type ?? '').toLowerCase()
  if (type === 'oracle') return 'oracle'
  const dbms = (connection?.resolved_dbms ?? '').toLowerCase()
  if (type === 'jet' || connection?.type === 'access' || dbms.includes('access')) return 'access'
  return 'plain'
}

/** Split a list into fixed-size chunks (e.g. two template fields per row). */
function chunkFields<T>(items: T[], size = 2): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/** For SZMFGACTIVE's Process_Data template, the '<>' FROM placeholder is
 *  substituted with the physical table name derived from the operation value
 *  rather than the operation itself. Unknown operations fall back to the raw
 *  operation value (legacy behaviour) so other '<>'-bearing templates stay
 *  safe — mirrors the backend's _OPERATION_TABLE_MAP. */
const OPERATION_TABLE_MAP: Record<string, string> = {
  '180COT': 'L08_Mfg_Data',
  '180D10C': 'L10c_Mfg_Data',
  '180D16C': 'L16c_Mfg_Data',
  '180L07A': 'L07_Mfg_Data',
  '180L07B': 'L07_Mfg_Data',
  '180L07C': 'L07_Mfg_Data',
  '180L11C': 'L11c_Mfg_Data',
  '180L26C': 'L26c_Mfg_Data',
  '180L88C': 'L88c_Mfg_Data',
}

/** Resolve the physical '<>' FROM table for a Process_Data operation value —
 *  mirrors the backend's _resolve_process_table. Operation values may arrive
 *  with the line number missing its leading zero, either as the operation code
 *  ('180L7A' instead of '180L07A') or as a literal table name ('L7_Mfg_Data'
 *  instead of 'L07_Mfg_Data'). Falls back to the raw value (legacy behaviour).
 *  Only single-digit runs are zero-padded, so multi-digit numbers ('180',
 *  'L88c') are never touched. */
function resolveProcessTable(opValue: string): string {
  const value = opValue.trim()
  if (OPERATION_TABLE_MAP[value]) return OPERATION_TABLE_MAP[value]
  const padSingleDigits = (s: string): string => s.replace(/(?<!\d)(\d)(?!\d)/g, '0$1')
  const lower = value.toLowerCase()
  if (lower.startsWith('l') && lower.endsWith('_mfg_data')) {
    const padded = padSingleDigits(value)
    const canonical = Object.values(OPERATION_TABLE_MAP).find(
      (t) => t.toLowerCase() === padded.toLowerCase(),
    )
    if (canonical) return canonical
  }
  const paddedOp = padSingleDigits(value)
  if (OPERATION_TABLE_MAP[paddedOp]) return OPERATION_TABLE_MAP[paddedOp]
  return value
}

/** Mirror of the backend criteria rendering: build the SELECT statement from
 *  the template base + the conditions the user has filled in so far. Every
 *  criterion — configured template fields (in config order) and user-added
 *  parameters — is injected at the '{}' anchor, so a tail (ORDER BY, GROUP BY,
 *  subqueries, …) is never disturbed. Blank optional fields are omitted.
 *  Without a '{}' anchor the conditions are appended at the end, exactly like
 *  the backend. */
function renderFabSqlPreview(
  option: ConnectionTemplateOption,
  values: Record<string, string>,
  operators: Record<string, string>,
  extraFilters: ExtraFilterRow[] = [],
  dateDialect: SqlDateDialect = 'plain',
): string {
  const templateSql = option.sql ?? ''
  // Only render when the template carries a '{}' injection point or a '<>'
  // FROM placeholder (Process_Data).
  if (!templateSql.includes('{}') && !templateSql.includes('<>')) return ''

  /** Quote a value for the WHERE fragment; date/datetime values use the
   *  connection's date-literal form. */
  const wrapValue = (value: string, isDate: boolean): string => {
    if (!isDate) return quoteSql(value)
    if (dateDialect === 'oracle') return toDateSql(value)
    if (dateDialect === 'access') return toJetDateSql(value)
    return quoteSql(value)
  }

  /** Render one condition fragment ('' when it must be omitted). */
  const render = (column: string, op: string, raw: string, rawTo = '', isDate = false): string => {
    const lower = op.toLowerCase()
    if (lower === 'is null' || lower === 'is not null') return `${column} ${lower.toUpperCase()}`
    if (!raw.trim()) return ''
    if (lower === 'between') {
      if (!rawTo.trim()) return ''
      const a = wrapValue(raw, isDate)
      const b = wrapValue(rawTo, isDate)
      return `${column} BETWEEN ${a} AND ${b}`
    }
    if (lower === 'like' || lower === 'not like') {
      // The value is used verbatim — the user types their own % wildcards.
      return `${column} ${lower === 'like' ? 'LIKE' : 'NOT LIKE'} ${quoteSql(raw)}`
    }
    if (lower === 'in' || lower === 'not in' || raw.includes(';')) {
      // Any field's value may be a ';'-separated list (values may contain
      // commas), rendered as an IN clause.
      const parts = raw
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
      if (!parts.length) return ''
      const rendered = parts.map((part) => wrapValue(part, isDate)).join(', ')
      return `${column} ${lower === 'not in' ? 'NOT IN' : 'IN'} (${rendered})`
    }
    return `${column} ${lower} ${wrapValue(raw, isDate)}`
  }

  // Templates with a '<>' FROM placeholder (Process_Data) use the selected
  // operation value to substitute it, so the operation field is excluded from
  // the WHERE criteria here. Only a template that declares an 'operation'
  // field uses the placeholder — elsewhere '<>' is a plain not-equal
  // comparison (e.g. "status <> 'NOPRODUCTION'") and must be left alone.
  // Mirror of the backend check.
  const hasFromPlaceholder =
    templateSql.includes('<>') && option.fields.some((field) => field.key === 'operation')

  // Configured template fields, in config order; blank optional fields are
  // omitted (no '1 = 1' filler — nothing is pinned to a placeholder position).
  const conditions: string[] = []
  for (const field of option.fields) {
    if (!field.key) continue
    if (hasFromPlaceholder && field.key === 'operation') continue
    const op = (operators[field.key] ?? field.operator ?? '=').toLowerCase()
    const raw = (values[field.key] ?? '').trim()
    const rawTo = (values[`${field.key}__to`] ?? '').trim()
    if (op === 'is null' || op === 'is not null') {
      conditions.push(`AND ${field.column ?? field.label} ${op.toUpperCase()}`)
      continue
    }
    if (!raw) continue
    const condition = render(field.column ?? field.label, op, raw, rawTo, field.type === 'datetime')
    if (condition) conditions.push(`AND ${condition}`)
  }

  // User-added parameters (columns picked from the base SQL).
  for (const filter of extraFilters) {
    if (!filter.column) continue
    const isDate = filter.dataType === 'date' || filter.dataType === 'datetime'
    const condition = render(filter.column, filter.operator.toLowerCase(), filter.value.trim(), filter.valueTo.trim(), isDate)
    if (condition) conditions.push(`AND ${condition}`)
  }

  // Substitute the selected operation value into the '<>' FROM placeholder
  // (Process_Data) before injecting the WHERE criteria at '{}'.
  const opValue = (values.operation ?? '').trim()
  const opFilled = hasFromPlaceholder && opValue ? resolveProcessTable(opValue) : ''
  if (!conditions.length && !opFilled) return ''

  let result = templateSql
  if (opFilled) result = result.replace('<>', opFilled)

  // Inject every criterion at the '{}' anchor; without an anchor, append them
  // at the end (legacy behaviour) — mirror of the backend.
  const tail = `\n  ${conditions.join('\n  ')}`
  if (result.includes('{}')) {
    return result.replace(/\{\}/g, tail)
  }
  return result.trimEnd() + tail
}

/** Labels of the template's date criteria that are still blank. Date fields
 *  are mandatory when running a template: leaving one empty drops its WHERE
 *  condition and would scan the full (unbounded) date range. An
 *  'is null'/'is not null' operator counts as a deliberate choice. */
function missingRequiredDates(
  option: ConnectionTemplateOption,
  values: Record<string, string>,
  operators: Record<string, string>,
): string[] {
  const missing: string[] = []
  for (const field of option.fields) {
    if (!DATE_TYPE_RE.test(field.type)) continue
    const op = (operators[field.key] ?? field.operator ?? '=').toLowerCase()
    if (IS_NULL_OPERATORS.has(op)) continue
    if (!((values[field.key] ?? '').trim())) missing.push(field.label)
  }
  return missing
}

type Mode = 'builder' | 'sql'

interface FilterRow {
  id: number
  column: string
  operator: string
  value: string
}

/** A user-added template parameter row (column picked from the base SQL). */
interface ExtraFilterRow {
  id: number
  column: string
  /** Column data type driving the value input (e.g. Date → date picker). */
  dataType: string
  operator: string
  value: string
  valueTo: string
}

/** A derived/calculated column being edited in the builder. */
interface DerivedColumnRow {
  id: number
  name: string
  expression: string
}

/** A promptable parameter being edited in the save dialog (builder mode). */
interface ParameterRow {
  id: number
  label: string
  column: string
  operator: string
  default: string
}

/** Snapshot of the builder state used to assemble a QueryDef. */
interface BuilderSnapshot {
  connectionId: string
  table: string
  selectedColumns: string[]
  filters: FilterRow[]
  derivedColumns: DerivedColumnRow[]
  dateColumn: string
  dateFrom: string
  dateTo: string
  limit: string
}

/** Convert a raw stored query definition (Record) into a typed QueryDef. */
function toQueryDef(raw: Record<string, unknown>, connectionId?: string): QueryDef {
  const query: QueryDef = {
    connection_id: connectionId ?? (typeof raw.connection_id === 'string' ? raw.connection_id : ''),
    table: String(raw.table ?? ''),
    columns: Array.isArray(raw.columns) ? raw.columns.map(String) : [],
    filters: Array.isArray(raw.filters)
      ? (raw.filters as Record<string, unknown>[]).map(
          (f): FilterDef => ({
            column: String(f.column ?? ''),
            operator: String(f.operator ?? '='),
            value: f.value === undefined || f.value === null ? '' : String(f.value),
          }),
        )
      : [],
  }
  if (Array.isArray(raw.derived_columns)) {
    query.derived_columns = (raw.derived_columns as Record<string, unknown>[])
      .map(
        (d): DerivedColumn => ({
          name: String(d.name ?? ''),
          expression: String(d.expression ?? ''),
        }),
      )
      .filter((d) => d.name.trim() && d.expression.trim())
  }
  if (typeof raw.date_column === 'string' && raw.date_column) query.date_column = raw.date_column
  if (typeof raw.date_from === 'string' && raw.date_from) query.date_from = raw.date_from
  if (typeof raw.date_to === 'string' && raw.date_to) query.date_to = raw.date_to
  const parsedLimit = Number(raw.limit)
  if (
    raw.limit !== undefined &&
    raw.limit !== null &&
    Number.isFinite(parsedLimit) &&
    parsedLimit > 0
  ) {
    query.limit = Math.floor(parsedLimit)
  }
  return query
}

function buildQuery(snapshot: BuilderSnapshot): QueryDef | null {
  // No table selected => not a runnable query. Empty columns mean "SELECT *".
  if (!snapshot.connectionId || !snapshot.table) {
    return null
  }
  const query: QueryDef = {
    connection_id: snapshot.connectionId,
    table: snapshot.table,
    columns: snapshot.selectedColumns,
    filters: snapshot.filters
      .filter((f) => f.column)
      .map((f): FilterDef => ({ column: f.column, operator: f.operator, value: f.value })),
  }
  const derived = snapshot.derivedColumns
    .map((d) => ({ name: d.name.trim(), expression: d.expression.trim() }))
    .filter((d) => d.name && d.expression)
  if (derived.length > 0) query.derived_columns = derived
  if (snapshot.dateColumn) {
    query.date_column = snapshot.dateColumn
    if (snapshot.dateFrom) query.date_from = snapshot.dateFrom
    if (snapshot.dateTo) query.date_to = snapshot.dateTo
  }
  const parsedLimit = Number(snapshot.limit)
  if (snapshot.limit.trim() !== '' && Number.isFinite(parsedLimit) && parsedLimit > 0) {
    query.limit = Math.floor(parsedLimit)
  }
  return query
}

/** Plain SQL identifier -> quote only when it is not a simple name. */
function quoteIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

/** Literal string with single quotes escaped (SQL standard). */
function sqlLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Render a value as a number when it is numeric, otherwise as a quoted string. */
function sqlValue(value: string): string {
  const trimmed = String(value).trim()
  return trimmed !== '' && Number.isFinite(Number(trimmed)) ? trimmed : sqlLiteral(value)
}

/**
 * Preview of the SELECT statement the backend will run for the current
 * builder criteria. Mirrors backend/app/db/sql_builder.py, but inlines the
 * values so the preview is readable (the backend still uses parameters).
 */
function buildSqlPreview(input: {
  table: string
  columns: string[]
  filters: FilterRow[]
  derivedColumns: DerivedColumnRow[]
  dateColumn: string
  dateFrom: string
  dateTo: string
  limit: string
  databaseType?: string
}): string {
  const { table, columns, filters, derivedColumns, dateColumn, dateFrom, dateTo, limit, databaseType } = input
  if (!table) return ''

  let colSql = columns.length > 0 ? columns.map(quoteIdentifier).join(', ') : '*'
  // Filter out rows missing a name or expression after trimming.
  const derivedParts = derivedColumns
    .filter((d) => d.name.trim() && d.expression.trim())
    .map((d) => `${d.expression.trim()} AS ${quoteIdentifier(d.name.trim())}`)
  if (derivedParts.length > 0) {
    colSql = colSql === '*' ? `${colSql}, ${derivedParts.join(', ')}` : `${colSql}, ${derivedParts.join(', ')}`
  }
  const where: string[] = []

  for (const f of filters) {
    if (!f.column) continue
    const qcol = quoteIdentifier(f.column)
    const value = f.value
    switch (f.operator) {
      case '=':
        where.push(`${qcol} = ${sqlValue(value)}`)
        break
      case '!=':
        where.push(`${qcol} <> ${sqlValue(value)}`)
        break
      case '>':
        where.push(`${qcol} > ${sqlValue(value)}`)
        break
      case '>=':
        where.push(`${qcol} >= ${sqlValue(value)}`)
        break
      case '<':
        where.push(`${qcol} < ${sqlValue(value)}`)
        break
      case '<=':
        where.push(`${qcol} <= ${sqlValue(value)}`)
        break
      case 'contains':
        where.push(`${qcol} LIKE ${sqlLiteral(`%${value}%`)}`)
        break
      case 'starts_with':
        where.push(`${qcol} LIKE ${sqlLiteral(`${value}%`)}`)
        break
      case 'ends_with':
        where.push(`${qcol} LIKE ${sqlLiteral(`%${value}`)}`)
        break
      case 'in': {
        const parts = String(value)
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
        if (parts.length > 0) where.push(`${qcol} IN (${parts.map(sqlLiteral).join(', ')})`)
        break
      }
      case 'is null':
        where.push(`${qcol} IS NULL`)
        break
      case 'is not null':
        where.push(`${qcol} IS NOT NULL`)
        break
    }
  }

  if (dateColumn && (dateFrom || dateTo)) {
    const qcol = quoteIdentifier(dateColumn)
    if (dateFrom && dateTo) {
      where.push(`${qcol} BETWEEN ${sqlLiteral(dateFrom)} AND ${sqlLiteral(dateTo)}`)
    } else if (dateFrom) {
      where.push(`${qcol} >= ${sqlLiteral(dateFrom)}`)
    } else {
      where.push(`${qcol} <= ${sqlLiteral(dateTo)}`)
    }
  }

  let sql = `SELECT ${colSql} FROM ${quoteIdentifier(table)}`
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`

  const rawLimit = limit.trim()
  const effectiveLimit =
    rawLimit === '' ? 1000 : Math.max(1, Math.min(Math.floor(Number(rawLimit)) || 1000, 100000))
  const db = (databaseType || '').toLowerCase()
  if (db === 'sqlserver' || db === 'jet') {
    sql = sql.replace('SELECT ', `SELECT TOP ${effectiveLimit} `)
  } else if (db === 'oracle') {
    sql += ` FETCH FIRST ${effectiveLimit} ROWS ONLY`
  } else {
    sql += ` LIMIT ${effectiveLimit}`
  }
  return sql
}

function validateBuilder(snapshot: BuilderSnapshot): string | null {
  if (!snapshot.connectionId) return 'Select a connection first.'
  if (!snapshot.table) return 'Select a table first.'
  if (
    snapshot.dateColumn &&
    snapshot.dateFrom &&
    snapshot.dateTo &&
    snapshot.dateFrom > snapshot.dateTo
  ) {
    return 'The date range start must not be after the end.'
  }
  return null
}

/** Imperative API the shell uses to refresh this page when its tab is opened. */
export interface WorkspacePageHandle {
  /** Re-fetch the connection list so newly added connections appear in the dropdowns. */
  refresh: () => void
}

interface WorkspacePageProps {
  /** Open the global AI sidebar in the given specialty (SQL / Script / Chart). */
  onOpenAi?: (mode: AiMode) => void
  /** The shell asks the page to refresh through this handle when the tab is
   *  opened. A boolean "active" prop would instead re-render the page on every
   *  switch — including the ones where it is only being hidden. */
  ref?: Ref<WorkspacePageHandle>
}

const EXPRESSION_EXAMPLES: { label: string; examples: { alias: string; expression: string }[] }[] = [
  {
    label: 'Arithmetic',
    examples: [
      { alias: 'Delta', expression: 'AFTER - BEFORE' },
      { alias: 'Amount', expression: 'QTY * PRICE' },
      { alias: 'Rounded', expression: 'ROUND(PRICE * QTY, 2)' },
      { alias: 'Fallback', expression: 'COALESCE(AMOUNT, 0)' },
    ],
  },
  {
    label: 'Text',
    examples: [
      { alias: 'Upper', expression: 'UPPER(NAME)' },
      { alias: 'Code', expression: 'LEFT(CODE, 3)' },
      { alias: 'Trimmed', expression: 'TRIM(DESCRIPTION)' },
      { alias: 'Full name', expression: "CONCAT(FIRST, ' ', LAST)" },
    ],
  },
  {
    label: 'Date & time',
    examples: [
      { alias: 'Year', expression: 'YEAR(DATE_COL)' },
      { alias: 'Month', expression: 'MONTH(DATE_COL)' },
      { alias: 'Days', expression: 'DATEDIFF(day, START, END)' },
      { alias: 'Today', expression: 'CURRENT_DATE' },
    ],
  },
  {
    label: 'Conditional',
    examples: [
      { alias: 'Bucket', expression: "CASE WHEN SCORE >= 90 THEN 'A' ELSE 'B' END" },
      { alias: 'Fallback', expression: 'COALESCE(A, B)' },
    ],
  },
]

function WorkspacePage({ onOpenAi, ref }: WorkspacePageProps = {}) {
  const filterIdRef = useRef(0)
  const [connections, setConnections] = useState<DbConnection[]>([])
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [loadingTables, setLoadingTables] = useState(false)
  const [table, setTable] = useState('')
  /** Table/View filter for the table selector (all | tables | views). */
  const [tableFilter, setTableFilter] = useState<'all' | 'tables' | 'views'>('all')
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [loadingColumns, setLoadingColumns] = useState(false)
  const [schemaReloadKey, setSchemaReloadKey] = useState(0)

  // ---- Builder definition ----
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [filters, setFilters] = useState<FilterRow[]>([])
  const [derivedColumns, setDerivedColumns] = useState<DerivedColumnRow[]>([])
  const [showExprExamples, setShowExprExamples] = useState(false)
  const [dateColumn, setDateColumn] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [limit, setLimit] = useState('1000')

  // ---- SQL mode ----
  const [sqlText, setSqlText] = useState('')
  /** The raw SQL editor box is expandable/collapsible. Expanded by default;
   *  checking "Use template" collapses it (the criteria form drives the SQL). */
  const [editorExpanded, setEditorExpanded] = useState(true)
  const [mode, setMode] = useState<Mode>('sql')
  /** Whether the SQL editor is driven by the selected connection template.
   *  Turned off to keep the current SQL and hide the template panel. */
  const [useTemplate, setUseTemplate] = useState(true)

  // ---- FabLIMS connection templates ----
  const [fabTemplates, setFabTemplates] = useState<ConnectionTemplateOption[]>([])
  const [fabTemplateError, setFabTemplateError] = useState<string | null>(null)
  const [fabOption, setFabOption] = useState('')
  const [fabValues, setFabValues] = useState<Record<string, string>>({})
  const [fabOperators, setFabOperators] = useState<Record<string, string>>({})
  const [fabExtraFilters, setFabExtraFilters] = useState<ExtraFilterRow[]>([])
  const fabExtraFilterIdRef = useRef(0)
  /** Labels of the required template date criteria left blank on the last
   *  "Run" attempt; non-null opens the reminder dialog and blocks the query. */
  const [missingDateReminder, setMissingDateReminder] = useState<string[] | null>(null)
  /** Distinct operations from DL_ChannelMaster, backing the Process_Data
   *  'operation' field dropdown (single select). */
  const [fabOperations, setFabOperations] = useState<string[]>([])
  const [fabOperationsLoading, setFabOperationsLoading] = useState(false)
  /** Snapshot of the SQL-template session (selected template + filled form) so
   *  switching away from the SQL tab and back restores the previous template
   *  instead of re-initializing to the first one. */
  const fabSessionRef = useRef<{
    connectionName: string
    fabOption: string
    fabValues: Record<string, string>
    fabOperators: Record<string, string>
    fabExtraFilters: ExtraFilterRow[]
  } | null>(null)

  /** Pre-filled values from each field's default (e.g. a default branch plant). */
  const defaultFabValues = (option: ConnectionTemplateOption | undefined): Record<string, string> => {
    const values: Record<string, string> = {}
    for (const field of option?.fields ?? []) {
      if (field.default) values[field.key] = field.default
    }
    return values
  }

  /** Reset values + operators when the selected template option changes. */
  const resetFabForm = (option: ConnectionTemplateOption | undefined) => {
    const defaults: Record<string, string> = {}
    for (const field of option?.fields ?? []) {
      defaults[field.key] = field.operator ?? '='
    }
    setFabValues(defaultFabValues(option))
    setFabExtraFilters([])
    setFabOperators(defaults)
  }

  // ---- Tautona "Test Components" picker ----
  const [testComponentsOpen, setTestComponentsOpen] = useState(false)
  /** Saved named component sets + the one chosen in the "Pre-defined
   *  components" dropdown (mirrors the "Pre-defined channels" pattern). */
  const [componentSets, setComponentSets] = useState<ComponentSet[]>([])
  const [selectedComponentSet, setSelectedComponentSet] = useState('')

  const refreshComponentSets = useCallback(() => {
    api
      .getComponentSets()
      .then((response) => {
        setComponentSets(response.sets)
        // Drop any selection that no longer exists after the fetch.
        setSelectedComponentSet((current) =>
          response.sets.some((set) => set.name === current) ? current : '',
        )
      })
      .catch(() => {
        // Leave the current list untouched on a transient failure.
      })
  }, [])

  /** Fill the RESULT_NAME query field from a saved component set. */
  const applyComponentSet = useCallback((names: string[]) => {
    setFabValues((current) => ({ ...current, result_name: names.join('; ') }))
    setFabOperators((current) => ({ ...current, result_name: 'in' }))
  }, [])

  /** Choosing a pre-defined component set applies it to the query field. */
  const handleComponentSetChange = (setName: string) => {
    setSelectedComponentSet(setName)
    const found = componentSets.find((set) => set.name === setName)
    if (found && (found.result_names ?? []).length > 0) applyComponentSet(found.result_names)
  }

  // ---- SZMFGACTIVE "Select Channels" picker ----
  const [channelDialogOpen, setChannelDialogOpen] = useState(false)
  const [criteriaHelpOpen, setCriteriaHelpOpen] = useState(false)
  const [savedChannelSets, setSavedChannelSets] = useState<ChannelSet[]>([])
  const [selectedChannelSet, setSelectedChannelSet] = useState('')

  const refreshChannelSets = useCallback((operation: string) => {
    const op = operation.trim()
    if (!op) {
      setSavedChannelSets([])
      setSelectedChannelSet('')
      return
    }
    api
      .getChannelSets(op)
      .then((response) => {
        setSavedChannelSets(response.sets)
        // Drop any selection that no longer exists after the fetch.
        setSelectedChannelSet((current) =>
          response.sets.some((set) => set.name === current) ? current : '',
        )
      })
      .catch(() => {
        // Leave the current list untouched on a transient failure.
      })
  }, [])

  /** Refresh the pre-defined sets dropdown once a set is saved for `operation`. */
  const handleChannelDialogSaved = useCallback(
    (operation: string) => {
      refreshChannelSets(operation)
    },
    [refreshChannelSets],
  )

  // Only the sets whose operation matches the block's current operation field
  // belong in the "Pre-defined channels" dropdown.
  const visibleChannelSets = useMemo(() => {
    const op = (fabValues.operation ?? '').trim()
    return savedChannelSets.filter((set) => (set.operation ?? '').trim() === op)
  }, [savedChannelSets, fabValues.operation])

  // ---- Execution / results ----
  /** FabLIMS template currently selected; its SQL is mirrored into the editor.
   *  Declared here (before the results memos) so its derived columns can be
   *  applied to the result as soon as a query returns. */
  const selectedFabOption = fabTemplates.find((o) => o.name === fabOption) ?? null
  const [result, setResult] = useState<QueryResult | null>(null)
  /** User-added calculated columns (grid formula helper). Shared with the charts. */
  const [computedColumns, setComputedColumns] = useState<ComputedColumn[]>([])
  const [running, setRunning] = useState(false)
  const [queryProgress, setQueryProgress] = useState<number | null>(null)
  /** Backend run id of the in-flight query (from X-Run-Id) — used to cancel it. */
  const runIdRef = useRef('')
  /** True once a cancel has been requested and is being processed. */
  const [cancelling, setCancelling] = useState(false)
  const cancelPendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  /** Schema-loading (tables/columns) failure — shown inside the Builder tab
   *  so it is visible where the user is working, not in the results panel. */
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  /** Which view the results area shows: the raw grid or the summary statistics. */
  const [resultTab, setResultTab] = useState<'grid' | 'summary'>('grid')
  /** Drill-through conditions pushed from the Summary tab onto the results grid. */
  const [drillFilters, setDrillFilters] = useState<GridDrillFilter[]>([])
  /** Color_Data auto-enrichment: one entry per stage, newest state wins. */
  const [enrichSteps, setEnrichSteps] = useState<ColorEnrichStep[]>([])
  /** True while the FabLIMS lot genealogy is being loaded onto the grid. */
  const [enriching, setEnriching] = useState(false)
  /** Non-fatal enrichment failure (the queried rows stay in the grid). */
  const [enrichError, setEnrichError] = useState<string | null>(null)

  // Calculated columns only make sense for the result they were built on, so
  // drop them as soon as a new result arrives.
  useEffect(() => {
    setComputedColumns([])
    setDrillFilters([])
  }, [result])

  /** Clicking a summary group filters the grid to its rows and switches views. */
  const handleDrillThrough = useCallback((filters: GridDrillFilter[]) => {
    setDrillFilters(filters)
    if (filters.length > 0) setResultTab('grid')
  }, [])

  /** Derived columns declared by the selected template (e.g. Color_Data parses
   *  LD_item / WOL / Batch / Sample_type out of NAME). Kept out of the
   *  `computedColumns` state so they survive the per-result reset and apply to
   *  every result the template returns — including re-runs and exports. */
  const templateComputedColumns = useMemo<ComputedColumn[]>(() => {
    const specs = useTemplate ? selectedFabOption?.computed_columns ?? [] : []
    return specs.map((spec) => ({ name: spec.name, expression: spec.expression }))
  }, [useTemplate, selectedFabOption])

  /** Bake computed columns into the result so the grid header (type chip) and
   *  the chart field list both see them as regular columns. */
  const effectiveResult = useMemo<QueryResult | null>(() => {
    if (!result) return null
    // Template columns come first so user-added columns can reference them.
    return bakeComputedColumns(result, [...templateComputedColumns, ...computedColumns])
  }, [result, computedColumns, templateComputedColumns])

  // ---- Manual data upload ----
  const [uploading, setUploading] = useState(false)
  /** Detailed upload progress: 'upload' = sending bytes (percent known),
   *  'read' = backend parsing the file, 'import' = rows shipped to the grid. */
  const [uploadStage, setUploadStage] = useState<'upload' | 'read' | 'import'>('upload')
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  /** Rows read / imported so far (null before the first row event). */
  const [uploadRows, setUploadRows] = useState<number | null>(null)
  /** Total rows, known once parsing finished — enables "N / total" display. */
  const [uploadTotalRows, setUploadTotalRows] = useState<number | null>(null)
  /** True while the grid shows rows parsed from an uploaded file. */
  const [uploadActive, setUploadActive] = useState(false)
  /** Base name (without extension) of the uploaded file — reused for exports. */
  const [uploadName, setUploadName] = useState('')

  // ---- Custom (pre-defined) query browser ----
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  /** Saved custom queries (builder + SQL), shown as a badge on the Custom button. */
  const [customQueryCount, setCustomQueryCount] = useState(0)
  /** Phones get the full screen so the card list isn't squeezed into side margins. */
  const fullScreenDialog = useMediaQuery('(max-width:600px)')

  const refreshCustomQueryCount = useCallback(async () => {
    try {
      const [builderList, sqlList] = await Promise.all([api.getSavedQueries(), api.getSqlQueries()])
      setCustomQueryCount(builderList.length + sqlList.length)
    } catch {
      // Leave the badge at its last known value if the probe fails.
    }
  }, [])

  useEffect(() => {
    void refreshCustomQueryCount()
  }, [refreshCustomQueryCount])

  // ---- Save as pre-defined ----
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDescription, setSaveDescription] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savingQuery, setSavingQuery] = useState(false)
  /** Promptable parameters being defined in the save dialog (builder mode). */
  const [saveParameters, setSaveParameters] = useState<ParameterRow[]>([])
  /** Existing custom SQLs shown in the save dialog so one can be overwritten. */
  const [existingSqls, setExistingSqls] = useState<SavedSqlQuery[]>([])
  /** Custom SQL selected for overwriting; '' means "save as new". */
  const [selectedSqlId, setSelectedSqlId] = useState('')
  const [sqlsLoading, setSqlsLoading] = useState(false)

  // ---- Recent runs (history) ----
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null)

  // Deduplicate the raw history (newest-first) so each unique query shows once,
  // with a count of how many times it has been executed.
  const historyGroups = useMemo(() => {
    const map = new Map<string, { entry: HistoryEntry; count: number }>()
    for (const entry of history) {
      const key = historyDedupKey(entry)
      const existing = map.get(key)
      if (existing) {
        existing.count += 1
      } else {
        map.set(key, { entry, count: 1 })
      }
    }
    return Array.from(map.values())
  }, [history])

  const [notice, setNotice] = useState<string | null>(null)

  // Latest committed state, readable from the editorBus 'request-run' handler.
  const stateRef = useRef<
    BuilderSnapshot & { mode: Mode; sqlText: string; connections: DbConnection[] }
  >({
    mode: 'builder',
    connectionId: '',
    table: '',
    selectedColumns: [],
    filters: [],
    derivedColumns: [],
    dateColumn: '',
    dateFrom: '',
    dateTo: '',
    limit: '',
    sqlText: '',
    connections: [],
  })
  stateRef.current = {
    mode,
    connectionId,
    table,
    selectedColumns,
    filters,
    derivedColumns,
    dateColumn,
    dateFrom,
    dateTo,
    limit,
    sqlText,
    connections,
  }

  const builderSnapshot = (): BuilderSnapshot => ({
    connectionId,
    table,
    selectedColumns,
    filters,
    derivedColumns,
    dateColumn,
    dateFrom,
    dateTo,
    limit,
  })

  // Publish the current builder query / SQL / grid rows so the Analyze tab can reuse them.
  // Publish the *effective* result so computed/added columns travel with the grid.
  useEffect(() => {
    publishWorkspaceSnapshot({
      connectionId,
      builderQuery: buildQuery(builderSnapshot()),
      sqlText,
      table,
      columns: (effectiveResult?.columns ?? []).map((col) => col.name),
      rows: effectiveResult?.rows ?? [],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, table, selectedColumns, filters, derivedColumns, dateColumn, dateFrom, dateTo, limit, sqlText, effectiveResult])

  // ---- Load connections ----
  const loadConnections = useCallback(() => {
    api
      .getConnections()
      .then((list) => setConnections(list))
      .catch((err: unknown) =>
        setConnectionsError(err instanceof Error ? err.message : 'Failed to load connections'),
      )
  }, [])

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  // The shell calls this when the Query tab is opened, so connections added in
  // Settings show up without re-rendering this page on every tab switch.
  useImperativeHandle(ref, () => ({ refresh: loadConnections }), [loadConnections])

  // ---- Schema cascade: connection -> tables -> columns ----
  useEffect(() => {
    if (!connectionId) {
      setTables([])
      return
    }
    let cancelled = false
    setLoadingTables(true)
    api
      .listTables(connectionId)
      .then((list) => {
        if (!cancelled) {
          setTables(list)
          setSchemaError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setSchemaError(err instanceof Error ? err.message : 'Failed to load tables')
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    if (!connectionId || !table) {
      setColumns([])
      return
    }
    let cancelled = false
    setLoadingColumns(true)
    api
      .listColumns(connectionId, table)
      .then((list) => {
        if (!cancelled) {
          setColumns(list)
          setSchemaError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setSchemaError(err instanceof Error ? err.message : 'Failed to load columns')
      })
      .finally(() => {
        if (!cancelled) setLoadingColumns(false)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, table, schemaReloadKey])

  // ---- Connection templates: auto-loaded per selected connection while the
  // SQL tab is active (the connection dropdown drives the template list). ----
  const selectedConnection = connections.find((c) => c.id === connectionId)
  // Template / script / channel links are keyed by the ODBC DSN — an immutable
  // identifier — not by the editable display name. Non-DSN connections fall
  // back to their name so the access-file connection keeps working.
  const templateKey = selectedConnection?.dsn || selectedConnection?.name || ''
  useEffect(() => {
    const connectionName = templateKey

    // Leaving SQL-template mode (another mode tab, template disabled, or a
    // connection switch): remember the current session so we can restore it
    // when the user returns to the same connection's SQL tab.
    if (mode !== 'sql' || !useTemplate) {
      fabSessionRef.current = { connectionName, fabOption, fabValues, fabOperators, fabExtraFilters }
      setFabTemplates([])
      return
    }

    if (!connectionName) {
      setFabTemplates([])
      setFabOption('')
      return
    }
    let cancelled = false
    setFabTemplateError(null)
    api
      .getConnectionTemplates(connectionName)
      .then((response) => {
        if (cancelled) return
        setFabTemplates(response.options)
        // Restore the previously selected template when returning to the same
        // connection (works when switching mode tabs and back); otherwise fall
        // back to the first template of the connection.
        const session = fabSessionRef.current
        const sameConnection = session?.connectionName === connectionName
        const restoreName =
          sameConnection && session && response.options.some((o) => o.name === session.fabOption)
            ? session.fabOption
            : ''
        // Never auto-select the first template: the dropdown stays on the
        // placeholder until the user picks the intended template. Only a
        // restored session (returning to the same connection) pre-selects.
        const effective = restoreName
          ? response.options.find((o) => o.name === restoreName)
          : undefined
        setFabOption(effective?.name ?? '')
        // Auto-show the selected template's base SQL only when the editor is
        // empty — never clobber SQL the user is already working on.
        if (effective && sqlText.trim() === '') setSqlText(effective.sql ?? '')
        if (restoreName && session) {
          // Return to the same connection + template: restore the filled-in
          // form so the user continues exactly where they left off. Defaults
          // (e.g. a default branch plant) fill any keys the session predates.
          setFabValues({ ...defaultFabValues(effective), ...session.fabValues })
          setFabExtraFilters(session.fabExtraFilters)
          setFabOperators(session.fabOperators)
        } else {
          resetFabForm(effective)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFabTemplateError(
            err instanceof Error ? err.message : `Failed to load templates for '${connectionName}'`,
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [mode, templateKey, useTemplate])

  // Columns start unselected by default — empty selection means "SELECT *".

  // ---- Builder handlers ----
  const handleConnectionChange = (event: SelectChangeEvent) => {
    setConnectionId(event.target.value)
    setTable('')
    setColumns([])
    setSelectedColumns([])
    setFilters([])
    setDerivedColumns([])
    setDateColumn('')
    setDateFrom('')
    setDateTo('')
    setError(null)
    setSchemaError(null)
  }

  const handleTableChange = (event: SelectChangeEvent) => {
    setTable(event.target.value)
    setColumns([])
    setSelectedColumns([])
    setFilters([])
    setDerivedColumns([])
    setDateColumn('')
    setError(null)
    setSchemaError(null)
  }

  const toggleColumn = (name: string) => {
    setSelectedColumns((current) =>
      current.includes(name) ? current.filter((c) => c !== name) : [...current, name],
    )
  }

  const toggleSelectAllColumns = () => {
    setSelectedColumns((current) =>
      current.length === columns.length ? [] : columns.map((column) => column.name),
    )
  }

  const addFilter = () => {
    setFilters((current) => [
      ...current,
      { id: ++filterIdRef.current, column: '', operator: '=', value: '' },
    ])
  }

  const updateFilter = (id: number, field: 'column' | 'operator' | 'value', value: string) => {
    setFilters((current) => current.map((f) => (f.id === id ? { ...f, [field]: value } : f)))
  }

  const removeFilter = (id: number) => {
    setFilters((current) => current.filter((f) => f.id !== id))
  }

  const addDerivedColumn = () => {
    setDerivedColumns((current) => [
      ...current,
      { id: ++filterIdRef.current, name: '', expression: '' },
    ])
  }

  const updateDerivedColumn = (
    id: number,
    field: 'name' | 'expression',
    value: string,
  ) => {
    setDerivedColumns((current) =>
      current.map((d) => (d.id === id ? { ...d, [field]: value } : d)),
    )
  }

  const removeDerivedColumn = (id: number) => {
    setDerivedColumns((current) => current.filter((d) => d.id !== id))
  }

  /** Fill the last calculated column's expression, adding one if needed. */
  const insertExpressionExample = (expression: string) => {
    const normalized = expression.trim()
    if (!normalized) return
    setDerivedColumns((current) => {
      if (current.length === 0) {
        return [{ id: ++filterIdRef.current, name: '', expression: normalized }]
      }
      return current.map((d, index) =>
        index === current.length - 1 ? { ...d, expression: normalized } : d,
      )
    })
  }

  // ---- Execution ----
  /**
   * After (or in place of) a raw query, automatically pivot Process_Data raw rows
   * into the wide table when a pre-defined channel set is selected. Returns the
   * source result unchanged when a transform is not applicable.
   */
  const maybeTransform = async (source: QueryResult): Promise<QueryResult> => {
    if (selectedFabOption?.name !== 'Process_Data' || templateKey.toUpperCase() !== 'SZMFGACTIVE') {
      return source
    }
    const op = (fabValues.operation ?? '').trim()
    if (!op) return source
    const set = visibleChannelSets.find((s) => s.name === selectedChannelSet)
    if (!set || set.channels.length === 0) return source
    const connId = connectionId || connections[0]?.id
    if (!connId) return source
    return api.transformData({
      connection_id: connId,
      operation: op,
      rows: source.rows,
      channels: set.channels,
      sql: source.sql,
    })
  }

  /**
   * After a Color_Data query, automatically append the FabLIMS lot genealogy:
   * derive WOL / Batch / Sample_type from NAME, then add Product (matched on
   * WOL) and Raw_item (matched on Batch). The color query's row count is
   * preserved — one row per color record, unmatched values left empty.
   *
   * Enrichment is a convenience: if the genealogy cannot be loaded the queried
   * rows are returned unchanged so the user is never left without data.
   */
  const maybeEnrichColorData = async (source: QueryResult): Promise<QueryResult> => {
    if (templateKey.toUpperCase() !== 'COLORDB') return source
    if (source.rows.length === 0) return source
    // WOL / Batch / Sample_type come from the Color_Data template's computed
    // columns; bake them in first so the backend only has to add the genealogy.
    const baked = bakeComputedColumns(source, templateComputedColumns)
    if (!baked.columns.some((col) => col.name.toUpperCase() === 'NAME')) return source

    setEnriching(true)
    setEnrichSteps([])
    setEnrichError(null)
    try {
      const enriched = await api.enrichColorData(
        { rows: baked.rows, columns: baked.columns },
        (step) =>
          setEnrichSteps((prev) => {
            const next = [...prev]
            const index = next.findIndex((entry) => entry.step === step.step)
            if (index >= 0) next[index] = step
            else next.push(step)
            return next
          }),
      )
      const summary = enriched.summary
      setNotice(
        `Lot genealogy added — ${summary.wol_matched.toLocaleString()}/${summary.wol_total.toLocaleString()} WOL → Product, ` +
          `${summary.batch_matched.toLocaleString()}/${summary.batch_total.toLocaleString()} Batch → Raw_item ` +
          `(${summary.genealogy_rows.toLocaleString()} genealogy rows${summary.cached ? ', cached' : ''}).`,
      )
      return enriched
    } catch (err) {
      setEnrichError(
        err instanceof Error ? err.message : 'Failed to load the FabLIMS lot genealogy.',
      )
      return source
    } finally {
      setEnriching(false)
    }
  }

  /** Cancel the in-flight query run. Retries briefly while the backend may
   *  not have registered the run yet (e.g. the connection is still opening). */
  const handleCancelQuery = async () => {
    if (cancelPendingRef.current) return
    cancelPendingRef.current = true
    setCancelling(true)
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const runId = runIdRef.current
        if (runId) {
          const response = await api.cancelQuery(runId)
          if (response.ok) return
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch {
      // Best effort — a hiccup reaching the cancel endpoint shouldn't break the UI.
    } finally {
      cancelPendingRef.current = false
      setCancelling(false)
    }
  }

  const runQueryDef = async (query: QueryDef) => {
    setRunning(true)
    setQueryProgress(0)
    setError(null)
    runIdRef.current = ''
    try {
      const response = await api.runQuery(query, (rows) => setQueryProgress(rows), (id) => {
        runIdRef.current = id
      })
      // The query is done — hand the results area over to the enrichment stepper.
      setRunning(false)
      setQueryProgress(null)
      let final = response
      try {
        final = await maybeTransform(response)
        if (final !== response) {
          setNotice(`Transformed ${final.row_count.toLocaleString()} row(s) into a wide table.`)
        }
      } catch (transformErr) {
        setError(transformErr instanceof Error ? transformErr.message : 'Transform failed')
        final = response
      }
      final = await maybeEnrichColorData(final)
      setGridHistory([])
      setResult(final)
      setUploadActive(false)
    } catch (err) {
      if (err instanceof QueryCanceledError) setNotice('Query canceled.')
      else setError(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setRunning(false)
      setQueryProgress(null)
    }
  }

  const runRawSql = async (connectionIdToUse: string, sql: string) => {
    setRunning(true)
    setQueryProgress(0)
    setError(null)
    runIdRef.current = ''
    try {
      const response = await api.runSql(
        connectionIdToUse,
        sql.trim(),
        undefined,
        (rows) => setQueryProgress(rows),
        (id) => {
          runIdRef.current = id
        },
      )
      // The query is done — hand the results area over to the enrichment stepper.
      setRunning(false)
      setQueryProgress(null)
      let final = response
      try {
        final = await maybeTransform(response)
        if (final !== response) {
          setNotice(`Transformed ${final.row_count.toLocaleString()} row(s) into a wide table.`)
        }
      } catch (transformErr) {
        setError(transformErr instanceof Error ? transformErr.message : 'Transform failed')
        final = response
      }
      final = await maybeEnrichColorData(final)
      setGridHistory([])
      setResult(final)
      setUploadActive(false)
    } catch (err) {
      if (err instanceof QueryCanceledError) setNotice('Query canceled.')
      else setError(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setRunning(false)
      setQueryProgress(null)
    }
  }

  const uploadInputRef = useRef<HTMLInputElement>(null)

  // ---- AI grid edit (transform the current grid rows via a generated script) ----
  const [aiTransformOpen, setAiTransformOpen] = useState(false)
  /** Stack of grid states before each AI transform, for Revert (newest last). */
  const [gridHistory, setGridHistory] = useState<{ result: QueryResult; computedColumns: ComputedColumn[] }[]>([])

  /** Apply an AI transform: snapshot the current grid, then swap in the new data. */
  const handleGridTransformApply = (
    rows: Record<string, unknown>[],
    columns: { name: string; type: string }[],
    log: string,
  ) => {
    setAiTransformOpen(false)
    if (!result) return
    // Snapshot the ORIGINAL result + computed columns (not the memoized
    // effective result, which already has computed columns baked in) so that
    // reverting restores exactly the pre-transform state.
    setGridHistory((prev) => [...prev, { result, computedColumns }])
    // Computed columns were baked into the transformed rows, so reset them.
    setComputedColumns([])
    setResult({
      rows,
      columns,
      row_count: rows.length,
      elapsed_ms: 0,
      sql: result.sql,
    })
    const logLine = log.trim() ? ` — ${log.trim().split('\n').slice(-1)[0].slice(0, 80)}` : ''
    setNotice(`Grid updated (${rows.length.toLocaleString()} row(s))${logLine}.`)
  }

  /** Restore the most recent pre-transform grid state. */
  const handleGridRevert = () => {
    const last = gridHistory[gridHistory.length - 1]
    if (!last) return
    setResult(last.result)
    setComputedColumns(last.computedColumns)
    setGridHistory((prev) => prev.slice(0, -1))
    setNotice('Grid reverted to the previous state.')
  }

  /** Parse a user-selected CSV/Excel file and show its rows in the grid. */
  const handleUpload = async (file: File) => {
    setUploading(true)
    setUploadStage('upload')
    setUploadPct(0)
    setUploadRows(null)
    setUploadTotalRows(null)
    setError(null)
    try {
      const response = await api.uploadData(file, (p) => {
        setUploadStage(p.stage)
        setUploadPct(p.stage === 'upload' ? p.percent ?? null : null)
        if (typeof p.rows === 'number') setUploadRows(p.rows)
        if (typeof p.totalRows === 'number') setUploadTotalRows(p.totalRows)
      })
      setGridHistory([])
      setResult({
        rows: response.rows,
        columns: response.columns,
        row_count: response.row_count,
        elapsed_ms: response.elapsed_ms,
        sql: '',
      })
      setUploadActive(true)
      setUploadName(file.name.replace(/\.[^.]+$/, '') || 'uploaded')
      setNotice(`Uploaded ${file.name} — ${response.row_count.toLocaleString()} rows.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      setUploadPct(null)
      setUploadRows(null)
      setUploadTotalRows(null)
    }
  }

  const handleRun = async () => {
    if (mode === 'builder') {
      const snapshot = builderSnapshot()
      const validation = validateBuilder(snapshot)
      if (validation) {
        setError(validation)
        return
      }
      const query = buildQuery(snapshot)
      if (!query) return
      await runQueryDef(query)
    } else {
      // Template quick-search SQL runs against the selected connection (the
      // one whose templates were loaded when "Use template" was turned on).
      const connId = connectionId || connections[0]?.id
      if (!connId) {
        setError('No connections available — add one in ODBC Setup first.')
        return
      }
      // Date criteria are mandatory for template runs: block the query and
      // remind the user which date fields still need a value.
      if (useTemplate && selectedFabOption) {
        const missing = missingRequiredDates(selectedFabOption, fabValues, fabOperators)
        if (missing.length > 0) {
          setMissingDateReminder(missing)
          return
        }
      }
      if (!sqlText.trim()) {
        setError('Enter some SQL to run.')
        return
      }
      await runRawSql(connId, sqlText)
    }
  }

  // ---- Exports ----
  const handleExport = async (format: ExportFormat) => {
    setExporting(format)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const extension = format
      const filename = (() => {
        if (uploadActive) return `${uploadName}_${stamp}.${extension}`
        if (mode === 'sql') return `sql_${stamp}.${extension}`
        return `query_${stamp}.${extension}`
      })()
      // Export exactly what the grid shows (including computed columns) —
      // never re-run the SQL/query on the backend.
      if (!effectiveResult || effectiveResult.rows.length === 0) {
        setError('Nothing to export — run a query first.')
        return
      }
      const blob = await api.exportGrid(effectiveResult.rows, effectiveResult.columns, format)
      const saved = await downloadBlob(blob, filename)
      if (saved.cancelled) {
        setNotice('Export cancelled')
        return
      }
      setNotice(
        saved.savedPath
          ? `Exported ${format.toUpperCase()} to ${saved.savedPath}`
          : `Exported ${format.toUpperCase()} (${filename})`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(null)
    }
  }

  // ---- Save as pre-defined ----
  const canSavePredefined =
    mode === 'builder'
      ? Boolean(result && buildQuery(builderSnapshot()))
      : Boolean(result && sqlText.trim())

  const openSaveDialog = () => {
    setSaveName('')
    setSaveDescription('')
    setSaveError(null)
    setSaveParameters([])
    setSelectedSqlId('')
    setSaveDialogOpen(true)
    if (mode === 'sql') {
      setSqlsLoading(true)
      api
        .getSqlQueries()
        .then((list) => setExistingSqls(list))
        .catch(() => setExistingSqls([]))
        .finally(() => setSqlsLoading(false))
    } else {
      setExistingSqls([])
    }
  }

  /** Pick an existing custom SQL to overwrite; prefill name/description. */
  const handleSqlSelectChange = (event: SelectChangeEvent) => {
    const id = event.target.value
    setSelectedSqlId(id)
    const found = existingSqls.find((q) => q.id === id)
    if (found) {
      setSaveName(found.name)
      setSaveDescription(found.description ?? '')
    }
  }

  // ---- Save dialog: prompt parameter editor (builder mode) ----
  const addParameter = () => {
    setSaveParameters((current) => [
      ...current,
      { id: ++filterIdRef.current, label: '', column: '', operator: '=', default: '' },
    ])
  }

  const updateParameter = (id: number, field: keyof ParameterRow, value: string) => {
    setSaveParameters((current) =>
      current.map((p) => (p.id === id ? { ...p, [field]: value } : p)),
    )
  }

  const removeParameter = (id: number) => {
    setSaveParameters((current) => current.filter((p) => p.id !== id))
  }

  const handleSaveQuery = async () => {
    const name = saveName.trim()
    if (!name) {
      setSaveError('Enter a name for the query.')
      return
    }
    setSavingQuery(true)
    setSaveError(null)
    try {
      if (mode === 'builder') {
        const query = buildQuery(builderSnapshot())
        if (!query) {
          setSaveError('Complete the query first.')
          return
        }
        // Collect fully-defined prompt parameters (non-empty label + column).
        const parameters = saveParameters
          .filter((p) => p.label.trim() && p.column)
          .map((p) => ({
            name: p.label.trim(),
            label: p.label.trim(),
            column: p.column,
            operator: p.operator,
            ...(p.default.trim() ? { default: p.default.trim() } : {}),
          }))
        await api.createSavedQuery(name, saveDescription, query, parameters)
      } else if (selectedSqlId) {
        // Overwrite the selected entry, keeping its connection unchanged.
        const existing = existingSqls.find((q) => q.id === selectedSqlId)
        await api.updateSqlQuery(selectedSqlId, name, saveDescription, sqlText, existing?.connection_id)
      } else {
        await api.createSqlQuery(name, saveDescription, sqlText, connectionId)
      }
      setSaveDialogOpen(false)
      void refreshCustomQueryCount()
      setNotice(
        selectedSqlId
          ? `Updated pre-defined SQL "${name}".`
          : `Saved as pre-defined ${mode === 'builder' ? 'query' : 'SQL'} "${name}".`,
      )
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save query')
    } finally {
      setSavingQuery(false)
    }
  }

  // ---- Recent runs (history) ----
  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const list = await api.getHistory(100)
      setHistory(list)
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load history')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const toggleHistory = () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next) void refreshHistory()
  }

  const loadHistoryEntry = (entry: HistoryEntry) => {
    if (entry.kind === 'builder' && entry.query) {
      applyLoadBuilder(entry.query, entry.connection_id)
    } else {
      applyLoadSql(entry.sql, entry.connection_id)
    }
  }

  const runHistoryEntry = async (entry: HistoryEntry) => {
    setHistoryBusyId(entry.id)
    try {
      if (entry.kind === 'builder' && entry.query) {
        const q = toQueryDef(entry.query, entry.connection_id)
        applyBuilderState(q)
        setMode('builder')
        await runQueryDef(q)
      } else {
        const connId = entry.connection_id || connections[0]?.id
        if (!connId) return
        applyLoadSql(entry.sql, connId)
        setMode('sql')
        await runRawSql(connId, entry.sql)
      }
    } finally {
      setHistoryBusyId(null)
    }
  }

  /** Delete every execution of a deduplicated query (all matching entries). */
  const handleDeleteHistoryGroup = async (entry: HistoryEntry) => {
    const ids = history.filter((h) => historyDedupKey(h) === historyDedupKey(entry)).map((h) => h.id)
    setHistoryBusyId(entry.id)
    try {
      await Promise.all(ids.map((id) => api.deleteHistoryEntry(id)))
      setHistory((current) => current.filter((h) => historyDedupKey(h) !== historyDedupKey(entry)))
      setNotice('History entry deleted.')
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to delete history entry')
    } finally {
      setHistoryBusyId(null)
    }
  }

  // ---- editorBus handlers (load from pre-defined pages) ----
  const applyBuilderState = (query: QueryDef) => {
    setTable(query.table)
    setColumns([])
    setSelectedColumns(query.columns ?? [])
    setFilters(
      (query.filters ?? []).map((f) => ({
        id: ++filterIdRef.current,
        column: f.column,
        operator: f.operator,
        value: f.value ?? '',
      })),
    )
    setDerivedColumns(
      (query.derived_columns ?? []).map((d) => ({
        id: ++filterIdRef.current,
        name: d.name,
        expression: d.expression,
      })),
    )
    setDateColumn(query.date_column ?? '')
    setDateFrom(query.date_from ?? '')
    setDateTo(query.date_to ?? '')
    setLimit(query.limit === undefined || query.limit === null ? '' : String(query.limit))
    setSchemaReloadKey((key) => key + 1)
    setError(null)
  }

  const applyLoadBuilder = (raw: Record<string, unknown>, connectionIdArg?: string) => {
    const connId =
      connectionIdArg ?? (typeof raw.connection_id === 'string' ? raw.connection_id : undefined)
    if (connId) setConnectionId(connId)
    setMode('builder')
    setTable(String(raw.table ?? ''))
    setColumns([])
    setSelectedColumns(Array.isArray(raw.columns) ? raw.columns.map(String) : [])
    setFilters(
      Array.isArray(raw.filters)
        ? (raw.filters as Record<string, unknown>[]).map((f) => ({
            id: ++filterIdRef.current,
            column: String(f.column ?? ''),
            operator: String(f.operator ?? '='),
            value: f.value === undefined || f.value === null ? '' : String(f.value),
          }))
        : [],
    )
    setDerivedColumns(
      Array.isArray(raw.derived_columns)
        ? (raw.derived_columns as Record<string, unknown>[]).map((d) => ({
            id: ++filterIdRef.current,
            name: String(d.name ?? ''),
            expression: String(d.expression ?? ''),
          }))
        : [],
    )
    setDateColumn(String(raw.date_column ?? ''))
    setDateFrom(String(raw.date_from ?? ''))
    setDateTo(String(raw.date_to ?? ''))
    setLimit(raw.limit === undefined || raw.limit === null ? '' : String(raw.limit))
    setSchemaReloadKey((key) => key + 1)
    setError(null)
  }

  const applyLoadSql = (sql: string, connectionIdArg?: string) => {
    if (connectionIdArg) setConnectionId(connectionIdArg)
    setMode('sql')
    setSqlText(sql)
    // Reveal the editor so loaded/AI-generated SQL is actually visible.
    setEditorExpanded(true)
    setError(null)
  }

  const requestRunFromRef = () => {
    const s = stateRef.current
    if (s.mode === 'builder') {
      const snapshot: BuilderSnapshot = {
        connectionId: s.connectionId,
        table: s.table,
        selectedColumns: s.selectedColumns,
        filters: s.filters,
        derivedColumns: s.derivedColumns,
        dateColumn: s.dateColumn,
        dateFrom: s.dateFrom,
        dateTo: s.dateTo,
        limit: s.limit,
      }
      const validation = validateBuilder(snapshot)
      if (validation) {
        setError(validation)
        return
      }
      const query = buildQuery(snapshot)
      if (!query) return
      void runQueryDef(query)
    } else if (s.mode === 'sql') {
      const connId = s.connectionId || s.connections[0]?.id
      if (!connId) {
        setError('No connections available — add one in ODBC Setup first.')
        return
      }
      if (!s.sqlText.trim()) {
        setError('Enter some SQL to run.')
        return
      }
      void runRawSql(connId, s.sqlText)
    }
  }

  const actionHandlerRef = useRef<(action: EditorAction) => void>(() => {})
  actionHandlerRef.current = (action) => {
    switch (action.type) {
      case 'load-builder':
        applyLoadBuilder(action.query, action.connectionId)
        break
      case 'load-sql':
        applyLoadSql(action.sql, action.connectionId)
        break
      case 'request-run':
        requestRunFromRef()
        break
    }
  }

  useEffect(() => {
    return subscribe((action) => actionHandlerRef.current(action))
  }, [])

  // ---- Derived ----
  const dateColumns = columns.filter((column) => DATE_TYPE_RE.test(column.data_type))
  const allColumnsSelected = columns.length > 0 && selectedColumns.length === columns.length
  // No columns selected is valid — it means "SELECT *" (all columns).
  const canRunBuilder = Boolean(connectionId && table)

  /** Tables/views list filtered by the All | Tables | Views toggle. */
  const filteredTables = useMemo(
    () =>
      tables.filter((t) => tableFilter === 'all' || t.type === (tableFilter === 'tables' ? 'table' : 'view')),
    [tables, tableFilter],
  )

  /** SQL auto-generated from the current builder criteria (read-only preview). */
  const previewSql = useMemo(() => {
    const connection = connections.find((c) => c.id === connectionId)
    return buildSqlPreview({
      table,
      columns: selectedColumns,
      filters,
      derivedColumns,
      dateColumn,
      dateFrom,
      dateTo,
      limit,
      databaseType: connection?.database_type,
    })
  }, [table, selectedColumns, filters, derivedColumns, dateColumn, dateFrom, dateTo, limit, connections, connectionId])

  /** Pretty-print the editor SQL. sql-formatter is loaded on demand so the
   *  dialect grammars stay out of the initial bundle. */
  const handleFormatSql = async () => {
    const trimmed = sqlText.trim()
    if (!trimmed) return
    try {
      const { format } = await import('sql-formatter')
      setSqlText(
        format(trimmed, {
          language: sqlDialectFor(selectedConnection?.database_type),
          keywordCase: 'upper',
        }),
      )
      setNotice('SQL formatted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to format SQL')
    }
  }

  const handleModeChange = (_event: SyntheticEvent, value: Mode) => {
    if (value) setMode(value)
  }

  const exportDisabled = !result || exporting !== null || running

  // Results panel — rendered standalone for Builder, and inside the
  // SQL-mode layout when in SQL mode.
  const resultsPanel = (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
      <Stack spacing={1.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          useFlexGap
          sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
        >
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h6">Results</Typography>
            {result && (
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                label={`${result.row_count.toLocaleString()} rows · ${result.elapsed_ms.toLocaleString()} ms`}
              />
            )}
          </Stack>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0]
                if (file) void handleUpload(file)
                event.target.value = ''
              }}
            />
            <Button
              size="small"
              variant="outlined"
              startIcon={uploading ? <CircularProgress size={16} /> : <FileUploadIcon />}
              onClick={() => uploadInputRef.current?.click()}
              disabled={uploading || running}
              sx={{ minHeight: 40 }}
            >
              Upload
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={exporting === 'xlsx' ? <CircularProgress size={16} /> : <FileDownloadIcon />}
              onClick={() => void handleExport('xlsx')}
              disabled={exportDisabled}
              sx={{ minHeight: 40 }}
            >
              XLSX
            </Button>
            <Button
              size="small"
              variant={historyOpen ? 'contained' : 'outlined'}
              startIcon={<HistoryIcon />}
              onClick={toggleHistory}
              sx={{ minHeight: 40 }}
            >
              Recent runs
            </Button>
          </Stack>
        </Stack>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Recent runs panel */}
        {historyOpen && (
          <Paper variant="outlined" sx={{ maxHeight: 320, overflow: 'auto', p: 1 }}>
            {historyError && (
              <Alert
                severity="error"
                sx={{ mb: historyGroups.length > 0 ? 1 : 0 }}
                action={
                  <Button color="inherit" size="small" onClick={() => void refreshHistory()} sx={{ minHeight: 36 }}>
                    Retry
                  </Button>
                }
              >
                {historyError}
              </Alert>
            )}
            {historyLoading && historyGroups.length === 0 ? (
              // The spinner is only for a cold load, so re-opening the panel
              // keeps the cached rows on screen instead of blanking out.
              <Box sx={{ py: 2, textAlign: 'center' }}>
                <CircularProgress size={22} />
              </Box>
            ) : historyGroups.length === 0 ? (
              !historyError && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                  No recent runs yet. Run a query to record it here.
                </Typography>
              )
            ) : (
              <Stack spacing={1}>
                {historyGroups.slice(0, RECENT_RUNS_LIMIT).map((group) => {
                  const entry = group.entry
                  return (
                  <Paper
                    key={group.entry.id}
                    variant="outlined"
                    sx={{ p: 1, bgcolor: 'action.hover', borderColor: 'divider' }}
                  >
                    <Stack
                      direction={{ xs: 'column', md: 'row' }}
                      spacing={1}
                      useFlexGap
                      sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}
                    >
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                          <Typography variant="caption" color="text.secondary">
                            {new Date(entry.executed_at).toLocaleString()}
                          </Typography>
                          <Chip
                            size="small"
                            variant="outlined"
                            label={entry.connection_name || 'Unknown connection'}
                          />
                          <Chip
                            size="small"
                            color={entry.kind === 'builder' ? 'primary' : 'secondary'}
                            label={entry.kind === 'builder' ? 'Builder' : 'SQL'}
                          />
                          {group.count > 1 && (
                            <Chip
                              size="small"
                              color="success"
                              sx={{ fontWeight: 600 }}
                              label={`×${group.count}`}
                            />
                          )}
                          <Typography variant="caption" color="text.secondary">
                            {entry.row_count.toLocaleString()} rows · {entry.elapsed_ms.toLocaleString()} ms
                          </Typography>
                        </Stack>
                        <Typography
                          variant="body2"
                          noWrap
                          sx={{
                            mt: 0.25,
                            cursor: 'pointer',
                            '&:hover': { textDecoration: 'underline', color: 'primary.main' },
                          }}
                          onClick={() => {
                            loadHistoryEntry(entry)
                            setHistoryOpen(false)
                          }}
                          title="Click to load in editor"
                        >
                          {entry.sql || '—'}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexShrink: 0 }}>
                        <Tooltip title="Run again">
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => void runHistoryEntry(entry)}
                              disabled={historyBusyId !== null}
                              aria-label={`Run ${entry.sql}`}
                            >
                              {historyBusyId === group.entry.id ? (
                                <CircularProgress size={18} />
                              ) : (
                                <PlayArrowIcon fontSize="small" />
                              )}
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Load in editor">
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => loadHistoryEntry(entry)}
                              disabled={historyBusyId !== null}
                              aria-label={`Load ${entry.sql}`}
                            >
                              <FileOpenIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => void handleDeleteHistoryGroup(entry)}
                              disabled={historyBusyId !== null}
                              aria-label={`Delete ${entry.sql}`}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </Stack>
                  </Paper>
                  )
                })}
              </Stack>
            )}
          </Paper>
        )}

        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs
            value={resultTab}
            onChange={(_event: SyntheticEvent, value: 'grid' | 'summary') => setResultTab(value)}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab
              value="grid"
              icon={<GridViewIcon />}
              iconPosition="start"
              label="Grid"
              sx={{ minHeight: 48 }}
            />
            <Tab
              value="summary"
              icon={<FunctionsIcon />}
              iconPosition="start"
              label="Summary"
              sx={{ minHeight: 48 }}
            />
          </Tabs>
        </Box>

        {/* Color_Data auto-enrichment progress: one line per stage, collapsing
            to the snackbar summary once the genealogy has been added. */}
        {(enriching || enrichError) && (
          <Alert
            severity={enrichError ? 'warning' : 'info'}
            onClose={enrichError ? () => setEnrichError(null) : undefined}
            sx={{ mx: { xs: 1, sm: 1.5 }, mt: 1, borderRadius: 1.5 }}
          >
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {enrichError ? 'Lot genealogy not loaded' : 'Adding FabLIMS lot genealogy…'}
            </Typography>
            {enrichError ? (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {enrichError}
              </Typography>
            ) : (
              <>
                <Stack spacing={0.25} sx={{ mt: 0.75 }}>
                  {enrichSteps.map((step) => (
                    <Stack key={step.step} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                      <Box
                        sx={{
                          width: 18,
                          pt: '3px',
                          display: 'flex',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {step.status === 'done' ? (
                          <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                        ) : (
                          <CircularProgress size={12} />
                        )}
                      </Box>
                      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                        {step.label}
                        {step.detail ? ` — ${step.detail}` : ''}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
                <LinearProgress sx={{ mt: 1, borderRadius: 1 }} />
              </>
            )}
          </Alert>
        )}

        <Box sx={{ position: 'relative', minHeight: 240 }}>
          {/* Both views stay mounted so their settings survive switching tabs —
              e.g. a pivot keeps its Rows/Columns/Values and axis filters after
              drilling through to the grid and coming back. */}
          <Box sx={{ display: resultTab === 'grid' ? 'block' : 'none' }}>
            <ResultsGrid
              result={effectiveResult}
              onAddComputedColumn={(col) => setComputedColumns((prev) => [...prev, col])}
              onOpenAiTransform={() => setAiTransformOpen(true)}
              onRevertGrid={gridHistory.length > 0 ? handleGridRevert : undefined}
              drillFilters={drillFilters}
              onClearDrill={() => setDrillFilters([])}
            />
          </Box>
          <Box sx={{ display: resultTab === 'summary' ? 'block' : 'none' }}>
            <SummaryPanel result={effectiveResult} onDrillThrough={handleDrillThrough} />
          </Box>
          {running && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                zIndex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1.5,
                px: 2,
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark' ? 'rgba(18,18,18,0.8)' : 'rgba(255,255,255,0.82)',
                backdropFilter: 'blur(2px)',
              }}
            >
              <CircularProgress size={36} />
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                {queryProgress !== null && queryProgress > 0
                  ? `Loading ${queryProgress.toLocaleString()} rows…`
                  : 'Running query…'}
              </Typography>
              <LinearProgress sx={{ width: 'min(240px, 60vw)' }} />
            </Box>
          )}
          {uploading && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                zIndex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1.5,
                px: 2,
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark' ? 'rgba(18,18,18,0.8)' : 'rgba(255,255,255,0.82)',
                backdropFilter: 'blur(2px)',
              }}
            >
              <CircularProgress size={36} />
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                {uploadStage === 'upload'
                  ? `Uploading file… ${uploadPct ?? 0}%`
                  : uploadStage === 'read'
                    ? uploadRows !== null
                      ? `Reading rows… ${uploadRows.toLocaleString()}`
                      : 'Reading workbook… this can take a while for large files'
                    : uploadTotalRows !== null
                      ? `Importing rows… ${(uploadRows ?? 0).toLocaleString()} / ${uploadTotalRows.toLocaleString()}`
                      : `Importing rows… ${(uploadRows ?? 0).toLocaleString()}`}
              </Typography>
              {uploadStage === 'import' && uploadTotalRows !== null ? (
                <LinearProgress
                  variant="determinate"
                  value={Math.min(100, ((uploadRows ?? 0) / uploadTotalRows) * 100)}
                  sx={{ width: 'min(240px, 60vw)' }}
                />
              ) : uploadStage === 'upload' && uploadPct !== null ? (
                <LinearProgress
                  variant="determinate"
                  value={uploadPct}
                  sx={{ width: 'min(240px, 60vw)' }}
                />
              ) : (
                <LinearProgress sx={{ width: 'min(240px, 60vw)' }} />
              )}
            </Box>
          )}
        </Box>
      </Stack>
    </Paper>
  )

  /** Columns users can add as extra parameters. Parsed from the base SQL's
   *  SELECT list; for a `SELECT *` base the primary table's columns are
   *  fetched from the database instead. */
  const [fabAvailableColumns, setFabAvailableColumns] = useState<ColumnOption[]>([])
  const [fabColumnsLoading, setFabColumnsLoading] = useState(false)
  useEffect(() => {
    const option = selectedFabOption
    if (!option) {
      setFabAvailableColumns([])
      setFabColumnsLoading(false)
      return
    }
    if (!isStarSelect(option)) {
      setFabAvailableColumns(extractTemplateColumns(option))
      setFabColumnsLoading(false)
      return
    }
    const table = extractPrimaryTable(option)
    // `SELECT *` base: the explicit list cannot be parsed from the SQL text,
    // so fall back to the configured fields (their column/label pair keeps
    // the alias display).
    const fallback = extractTemplateColumns(option)
    if (!table || !connectionId) {
      setFabAvailableColumns(fallback)
      setFabColumnsLoading(false)
      return
    }
    let cancelled = false
    setFabColumnsLoading(true)
    api
      .listColumns(connectionId, table)
      .then((list) => {
        if (!cancelled) {
          setFabAvailableColumns(list.map((column) => ({ value: column.name, label: column.name })))
        }
      })
      .catch(() => {
        if (!cancelled) setFabAvailableColumns(fallback)
      })
      .finally(() => {
        if (!cancelled) setFabColumnsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedFabOption, connectionId])

  // Load the pre-defined channel sets for the block's operation whenever the
  // Process_Data template becomes active or its operation field changes, so the
  // dropdown only lists sets that belong to the selected operation.
  useEffect(() => {
    if (selectedFabOption?.name !== 'Process_Data') {
      setSavedChannelSets([])
      setSelectedChannelSet('')
      return
    }
    setSelectedChannelSet('')
    refreshChannelSets((fabValues.operation ?? '').trim())
  }, [selectedFabOption, fabValues.operation, refreshChannelSets])

  // Load the distinct DL_ChannelMaster operations into the 'operation' field
  // dropdown whenever the Process_Data template becomes active.
  useEffect(() => {
    if (selectedFabOption?.name !== 'Process_Data') return
    const connectionName = templateKey
    if (!connectionName) return
    let cancelled = false
    setFabOperationsLoading(true)
    api
      .getChannelOperations(connectionName)
      .then((response) => {
        if (!cancelled) setFabOperations(response.operations)
      })
      .catch(() => {
        if (!cancelled) setFabOperations([])
      })
      .finally(() => {
        if (!cancelled) setFabOperationsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedFabOption, templateKey])

  // Load the saved component sets when the Tautona template becomes active and
  // clear the chosen set whenever the template option changes (mirrors the
  // "Pre-defined channels" dropdown behaviour).
  useEffect(() => {
    if (selectedFabOption?.name !== 'Tautona_Test_Result') {
      setComponentSets([])
      setSelectedComponentSet('')
      return
    }
    setSelectedComponentSet('')
    refreshComponentSets()
  }, [selectedFabOption, refreshComponentSets])

  const addFabExtraFilter = () => {
    setFabExtraFilters((current) => [
      ...current,
      {
        id: ++fabExtraFilterIdRef.current,
        column: fabAvailableColumns[0]?.value ?? '',
        dataType: 'text',
        operator: '=',
        value: '',
        valueTo: '',
      },
    ])
  }

  const updateFabExtraFilter = (
    id: number,
    field: 'column' | 'dataType' | 'operator' | 'value' | 'valueTo',
    value: string,
  ) => {
    setFabExtraFilters((current) =>
      current.map((f) => {
        if (f.id !== id) return f
        // Changing the data type also narrows the operator list; snap the current
        // operator back to a valid one for the newly selected type.
        if (field === 'dataType') {
          const ops = extraOperatorsForType(value)
          return { ...f, dataType: value, operator: ops.includes(f.operator) ? f.operator : ops[0] }
        }
        return { ...f, [field]: value }
      }),
    )
  }

  const removeFabExtraFilter = (id: number) => {
    setFabExtraFilters((current) => current.filter((f) => f.id !== id))
  }

  // Live preview: mirror the filled FabLIMS parameters into the SQL editor.
  useEffect(() => {
    if (mode !== 'sql' || !selectedFabOption) return
    // Date literals are dialect-specific — Oracle needs TO_DATE(), Access/Jet
    // needs '#...#', other servers compare plain quoted strings (mirrors the
    // backend's resolve_dbms gating).
    const preview = renderFabSqlPreview(
      selectedFabOption,
      fabValues,
      fabOperators,
      fabExtraFilters,
      sqlDateDialect(selectedConnection),
    )
    if (preview) setSqlText(preview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabValues, fabOperators, fabExtraFilters, fabOption, connectionId, selectedConnection])

  /** Render one template criteria row: the value input(s) + operator dropdown. */
  const renderFabField = (field: ConnectionTemplateField): ReactNode => {
    const fieldOperators = templateOperatorsForField(field)
    const currentOp = fabOperators[field.key]
      ? fieldOperators.includes(fabOperators[field.key])
        ? fabOperators[field.key]
        : fieldOperators[0]
      : fieldOperators.includes(field.operator ?? '=')
        ? (field.operator ?? '=')
        : fieldOperators[0]
    const isNullOp = IS_NULL_OPERATORS.has(currentOp)
    const isBetween = currentOp === 'between'
    const isLikeOp = currentOp === 'like' || currentOp === 'not like'
    const isInOp = currentOp === 'in' || currentOp === 'not in'
    /** Hover hint for the value field, when the active operator needs one. */
    const valueTooltip = isLikeOp ? LIKE_TOOLTIP : isInOp ? IN_TOOLTIP : ''
    // Field label stays pinned above the input (like the Op label), never inside it.
    const inputProps = { inputLabel: { shrink: true } }
    // Date criteria are mandatory for template runs; flag their labels with a
    // red asterisk. IS NULL / IS NOT NULL need no value, so no marker there.
    const isRequiredDate = DATE_TYPE_RE.test(field.type) && !isNullOp
    const withRequiredMark = (text: string): ReactNode =>
      isRequiredDate ? (
        <span>
          {text} <span style={{ color: '#d32f2f' }}>*</span>
        </span>
      ) : (
        text
      )
    // Process_Data 'operation' field is a single-select dropdown fed from
    // DL_ChannelMaster; its value substitutes the '<>' FROM placeholder, so no
    // operator dropdown is needed for it.
    const isOperationDropdown =
      selectedFabOption?.name === 'Process_Data' && field.key === 'operation'
    return (
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        useFlexGap
        sx={{ alignItems: { xs: 'stretch', sm: 'flex-start' } }}
      >
        {isOperationDropdown ? (
          <FormControl size="small" sx={{ flexGrow: 1, width: { xs: '100%', sm: 'auto' } }}>
            <InputLabel id={`operation-${field.key}`}>{field.label}</InputLabel>
            <Select
              labelId={`operation-${field.key}`}
              label={field.label}
              value={fabValues[field.key] ?? ''}
              onChange={(event: SelectChangeEvent) =>
                setFabValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
              disabled={fabOperationsLoading}
              fullWidth
            >
              {fabOperations.map((op) => (
                <MenuItem key={op} value={op}>
                  {op}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : isNullOp ? (
          <TextField
            size="small"
            label={field.label}
            value=""
            disabled
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
            helperText="No value needed for this operator"
          />
        ) : isBetween ? (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            useFlexGap
            sx={{
              flexGrow: 1,
              minWidth: 0,
              width: { xs: '100%', sm: 'auto' },
              alignItems: { xs: 'stretch', sm: 'flex-start' },
            }}
          >
            <TextField
              size="small"
              label={withRequiredMark(`${field.label} (from)`)}
              type={field.type === 'datetime' ? 'datetime-local' : 'text'}
              value={fabValues[field.key] ?? ''}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setFabValues((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
              sx={{ flex: 1, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}
              slotProps={inputProps}
            />
            <TextField
              size="small"
              label="to"
              type={field.type === 'datetime' ? 'datetime-local' : 'text'}
              value={fabValues[`${field.key}__to`] ?? ''}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setFabValues((current) => ({
                  ...current,
                  [`${field.key}__to`]: event.target.value,
                }))
              }
              sx={{ flex: 1, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}
              slotProps={inputProps}
            />
          </Stack>
        ) : valueTooltip ? (
          <Tooltip title={valueTooltip}>
            <Box sx={{ flexGrow: 1, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}>
              <TextField
                size="small"
                label={withRequiredMark(field.label)}
                type={field.type === 'datetime' ? 'datetime-local' : 'text'}
                value={fabValues[field.key] ?? ''}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setFabValues((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
                placeholder={field.placeholder}
                fullWidth
                slotProps={inputProps}
              />
            </Box>
          </Tooltip>
        ) : (
          <TextField
            size="small"
            label={withRequiredMark(field.label)}
            type={field.type === 'datetime' ? 'datetime-local' : 'text'}
            value={fabValues[field.key] ?? ''}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setFabValues((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
            placeholder={field.placeholder}
            fullWidth
            slotProps={inputProps}
          />
        )}
        {!isOperationDropdown && (
          <FormControl size="small" sx={{ width: { xs: '100%', sm: 116 }, flexShrink: 0 }}>
            <InputLabel id={`op-${field.key}`}>Op</InputLabel>
            <Select
              labelId={`op-${field.key}`}
              label="Op"
              value={currentOp}
              onChange={(event: SelectChangeEvent) =>
                setFabOperators((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
            >
              {fieldOperators.map((op) => (
                <MenuItem key={op} value={op}>
                  {TEMPLATE_OPERATORS[op]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Stack>
    )
  }

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      {/* Header: title + subtitle first, consistent with the Analyze page */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5">Query</Typography>
        <Typography variant="body2" color="text.secondary">
          Run SQL, build a query visually, or upload a CSV/Excel file. Results
          load into the grid and feed the Analyze tab for charts and scripts.
        </Typography>
      </Box>

      {/* Mode tabs (connection selector lives inside Builder mode) */}
      <Tabs
        value={mode}
        onChange={handleModeChange}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
      >
        <Tab value="sql" icon={<CodeIcon />} iconPosition="start" label="SQL editor" />
        <Tab value="builder" icon={<TableChartIcon />} iconPosition="start" label="Builder" />
      </Tabs>
      {connectionsError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {connectionsError}
        </Alert>
      )}

      {/* Builder mode */}
      {mode === 'builder' && (
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, mb: 2 }}>
          <Stack spacing={2} sx={{ mb: 2 }}>
            <Typography variant="h6">Query Builder</Typography>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              useFlexGap
              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
            >
              <FormControl size="small" sx={{ width: { xs: '100%', md: 380 } }}>
                <InputLabel id="workspace-connection-label">Connection</InputLabel>
                <Select
                  size="small"
                  labelId="workspace-connection-label"
                  label="Connection"
                  value={connectionId}
                  onChange={handleConnectionChange}
                  disabled={connections.length === 0}
                >
                  <MenuItem value="" disabled>
                    {connections.length === 0 ? 'No connections — add one first' : 'Select a connection'}
                  </MenuItem>
                  {connections.map((connection) => (
                    <MenuItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          </Stack>
          <Stack spacing={2}>
            {/* Table / View selector with All | Tables | Views toggle */}
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              useFlexGap
              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, maxWidth: 760 }}
            >
              <ToggleButtonGroup
                size="small"
                exclusive
                value={tableFilter}
                onChange={(_event: ReactMouseEvent<HTMLElement>, value: 'all' | 'tables' | 'views' | null) => {
                  if (value) setTableFilter(value)
                }}
                aria-label="Filter table list by type"
              >
                <ToggleButton value="all" sx={{ minHeight: 40 }}>
                  All
                </ToggleButton>
                <ToggleButton value="tables" sx={{ minHeight: 40 }}>
                  Tables
                </ToggleButton>
                <ToggleButton value="views" sx={{ minHeight: 40 }}>
                  Views
                </ToggleButton>
              </ToggleButtonGroup>
              <FormControl fullWidth size="small">
                <InputLabel id="table-label">Table / View</InputLabel>
                <Select
                  labelId="table-label"
                  label="Table / View"
                  value={table}
                  onChange={handleTableChange}
                  disabled={!connectionId}
                >
                  <MenuItem value="" disabled>
                    {connectionId ? 'Select a table' : 'Select a connection first'}
                  </MenuItem>
                  {filteredTables.map((t) => (
                    <MenuItem key={t.name} value={t.name}>
                      {t.name} {t.type === 'view' ? '(view)' : ''}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {loadingTables && <CircularProgress size={20} sx={{ flexShrink: 0 }} />}
            </Stack>

            {/* Schema-loading failures belong to the Builder tab, not the results panel */}
            {schemaError && (
              <Alert severity="error" onClose={() => setSchemaError(null)}>
                {schemaError}
              </Alert>
            )}

            {/* Filters (moved up) */}
            <Box>
              <Stack
                direction="row"
                sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}
              >
                <Typography
                  variant="subtitle1"
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                >
                  <FilterAltIcon fontSize="small" color="secondary" />
                  Filters
                </Typography>
                <Button size="small" startIcon={<AddIcon />} onClick={addFilter} sx={{ minHeight: 36 }}>
                  Add filter
                </Button>
              </Stack>
              <Stack spacing={1}>
                {filters.map((filter) => (
                  <Stack
                    key={filter.id}
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 150 } }}>
                      <Select
                        value={filter.column}
                        onChange={(event: SelectChangeEvent) =>
                          updateFilter(filter.id, 'column', event.target.value)
                        }
                        displayEmpty
                      >
                        <MenuItem value="" disabled>
                          Column
                        </MenuItem>
                        {columns.map((column) => (
                          <MenuItem key={column.name} value={column.name}>
                            {column.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 140 } }}>
                      <Select
                        value={filter.operator}
                        onChange={(event: SelectChangeEvent) =>
                          updateFilter(filter.id, 'operator', event.target.value)
                        }
                      >
                        {OPERATORS.map((op) => (
                          <MenuItem key={op.value} value={op.value}>
                            {op.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    {!NULL_OPERATORS.has(filter.operator) && (
                      <TextField
                        size="small"
                        value={filter.value}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          updateFilter(filter.id, 'value', event.target.value)
                        }
                        placeholder={filter.operator === 'in' ? 'comma-separated values' : 'value'}
                        fullWidth
                        sx={{ flexGrow: 1 }}
                      />
                    )}
                    <IconButton
                      size="small"
                      onClick={() => removeFilter(filter.id)}
                      aria-label="Remove filter"
                      sx={{ alignSelf: { xs: 'flex-end', sm: 'center' } }}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
                {filters.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No filters — all rows will be returned.
                  </Typography>
                )}
              </Stack>
            </Box>

            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 6 }}>
                <Stack spacing={2}>
                  {/* Columns */}
                  <Box>
                    <Stack
                      direction="row"
                      sx={{ mb: 0.5, alignItems: 'center', justifyContent: 'space-between' }}
                    >
                      <Typography
                        variant="subtitle1"
                        sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                      >
                        <GridViewIcon fontSize="small" color="primary" />
                        Columns
                        {columns.length > 0 && (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`${selectedColumns.length}/${columns.length}`}
                            sx={{ ml: 0.5 }}
                          />
                        )}
                      </Typography>
                      {columns.length > 0 && (
                        <Button size="small" onClick={toggleSelectAllColumns} sx={{ minHeight: 36 }}>
                          {allColumnsSelected ? 'Clear all' : 'Select all'}
                        </Button>
                      )}
                    </Stack>
                    <Paper variant="outlined" sx={{ maxHeight: 230, overflow: 'auto', p: 1 }}>
                      <FormGroup>
                        {columns.map((column) => (
                          <FormControlLabel
                            key={column.name}
                            control={
                              <Checkbox
                                checked={selectedColumns.includes(column.name)}
                                onChange={() => toggleColumn(column.name)}
                                size="small"
                              />
                            }
                            label={
                              <Box
                                component="span"
                                sx={{ display: 'flex', gap: 1, alignItems: 'center', minWidth: 0 }}
                              >
                                <Box
                                  component="span"
                                  sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
                                >
                                  {column.name}
                                </Box>
                                <Typography
                                  component="span"
                                  variant="caption"
                                  color="text.secondary"
                                  noWrap
                                >
                                  {column.data_type}
                                </Typography>
                              </Box>
                            }
                          />
                        ))}
                        {columns.length === 0 && (
                          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                            {loadingColumns ? 'Loading columns…' : 'Select a table to see its columns.'}
                          </Typography>
                        )}
                      </FormGroup>
                    </Paper>
                    {loadingColumns && <CircularProgress size={20} sx={{ mt: 1 }} />}
                  </Box>
                </Stack>
              </Grid>

              <Grid size={{ xs: 12, md: 6 }}>
                <Stack spacing={2}>
                  {/* Date range */}
                  <Box>
                    <Typography variant="subtitle1" sx={{ mb: 1 }}>
                      Date range (optional)
                    </Typography>
                    <Grid container spacing={2}>
                      <Grid size={{ xs: 12, sm: 6 }}>
                        <FormControl fullWidth size="small">
                          <InputLabel id="date-column-label">Date column</InputLabel>
                          <Select
                            labelId="date-column-label"
                            label="Date column"
                            value={dateColumn}
                            onChange={(event: SelectChangeEvent) => setDateColumn(event.target.value)}
                          >
                            <MenuItem value="">
                              <em>None</em>
                            </MenuItem>
                            {dateColumns.map((column) => (
                              <MenuItem key={column.name} value={column.name}>
                                {column.name}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                        {dateColumns.length === 0 && (
                          <Typography variant="caption" color="text.secondary">
                            No date/time columns detected in this table.
                          </Typography>
                        )}
                      </Grid>
                      <Grid size={{ xs: 6, sm: 3 }}>
                        <TextField
                          label="From"
                          type="date"
                          value={dateFrom}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setDateFrom(event.target.value)}
                          fullWidth
                          slotProps={{ inputLabel: { shrink: true } }}
                          disabled={!dateColumn}
                        />
                      </Grid>
                      <Grid size={{ xs: 6, sm: 3 }}>
                        <TextField
                          label="To"
                          type="date"
                          value={dateTo}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setDateTo(event.target.value)}
                          fullWidth
                          slotProps={{ inputLabel: { shrink: true } }}
                          disabled={!dateColumn}
                        />
                      </Grid>
                    </Grid>
                  </Box>

                  {/* Row limit */}
                  <TextField
                    label="Row limit"
                    type="number"
                    value={limit}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setLimit(event.target.value)}
                    placeholder="all"
                    helperText="Maximum rows to return (blank = all)."
                    slotProps={{ htmlInput: { min: 1, inputMode: 'numeric' } }}
                    sx={{ maxWidth: { xs: '100%', sm: 220 } }}
                  />
                </Stack>
              </Grid>
            </Grid>

            {/* Calculated (derived) columns */}
            <Box>
              <Stack
                direction="row"
                sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}
              >
                <Typography variant="subtitle1" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <FunctionsIcon fontSize="small" color="success" />
                  Calculated columns
                </Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={addDerivedColumn}
                  sx={{ minHeight: 36 }}
                >
                  Add calculated
                </Button>
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Append a database-evaluated expression to the result, e.g. name{' '}
                <em>&quot;Delta&quot;</em> and expression <em>&quot;AFTER - BEFORE&quot;</em>.
                The expression becomes <code>expr AS name</code> in the SELECT list.
              </Typography>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}
              >
                <Button size="small" onClick={() => setShowExprExamples((v) => !v)} sx={{ minHeight: 32, minWidth: 0, p: 0 }}>
                  {showExprExamples ? 'Hide' : 'Show'} expression examples
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Tap an example to fill the last calculated expression.
                </Typography>
              </Stack>
              {showExprExamples && (
                <Stack spacing={1.2} useFlexGap sx={{ mb: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                  {EXPRESSION_EXAMPLES.map((group) => (
                    <Box key={group.label}>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>
                        {group.label}
                      </Typography>
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
                        {group.examples.map((ex) => (
                          <Chip
                            key={ex.alias + ex.expression}
                            size="small"
                            variant="outlined"
                            label={ex.expression}
                            title={`${ex.expression} AS ${ex.alias}`}
                            onClick={() => insertExpressionExample(ex.expression)}
                          />
                        ))}
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              )}
              <Stack spacing={1}>
                {derivedColumns.map((col) => (
                  <Stack
                    key={col.id}
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <TextField
                      size="small"
                      label="Name (alias)"
                      value={col.name}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        updateDerivedColumn(col.id, 'name', event.target.value)
                      }
                      fullWidth
                      sx={{ sm: { minWidth: 180 } }}
                    />
                    <TextField
                      size="small"
                      label="Expression (SQL)"
                      value={col.expression}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        updateDerivedColumn(col.id, 'expression', event.target.value)
                      }
                      placeholder="e.g. AFTER - BEFORE"
                      fullWidth
                      sx={{ flexGrow: 1 }}
                    />
                    <IconButton
                      size="small"
                      onClick={() => removeDerivedColumn(col.id)}
                      aria-label="Remove calculated column"
                      sx={{ alignSelf: { xs: 'flex-end', sm: 'center' } }}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
                {derivedColumns.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No calculated columns — expressions are appended as-is to the SELECT list.
                  </Typography>
                )}
              </Stack>
            </Box>

            {/* Generated SQL preview */}
            <Box>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>
                Generated SQL (auto)
              </Typography>
              <TextField
                fullWidth
                multiline
                minRows={4}
                maxRows={10}
                value={previewSql}
                placeholder="Generated SQL appears here as you define your criteria…"
                slotProps={{
                  input: {
                    readOnly: true,
                    sx: { fontFamily: 'Consolas, monospace', fontSize: '0.8rem' },
                  },
                }}
              />
            </Box>

            {/* Run */}
            <Stack direction="row" useFlexGap sx={{ justifyContent: 'flex-start' }}>
              <Button
                variant="contained"
                size="large"
                startIcon={running ? <CircularProgress size={20} color="inherit" /> : <PlayArrowIcon />}
                onClick={() => void handleRun()}
                disabled={running || !canRunBuilder}
                sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
              >
                {running ? 'Running…' : 'Run Query'}
              </Button>
              {running && (
                <Button
                  variant="outlined"
                  color="error"
                  size="large"
                  startIcon={cancelling ? <CircularProgress size={18} color="inherit" /> : undefined}
                  onClick={() => void handleCancelQuery()}
                  disabled={cancelling}
                  sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </Button>
              )}
            </Stack>
          </Stack>
        </Paper>
      )}

      {/* SQL mode: editor + results on the left, full-height AI assist on the right */}
      {mode === 'sql' && (
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          useFlexGap
          sx={{ alignItems: { xs: 'stretch', md: 'flex-start' }, mb: 2 }}
        >
          <Stack spacing={2} useFlexGap sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
              <Stack spacing={2}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  useFlexGap
                  sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
                >
                  <Stack
                    data-tour="query-template"
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
                  >
                    <FormControl size="small" sx={{ width: { xs: '100%', sm: 320 } }}>
                      <InputLabel id="sql-connection-label">Connection</InputLabel>
                      <Select
                        labelId="sql-connection-label"
                        label="Connection"
                        value={connectionId}
                        onChange={handleConnectionChange}
                        disabled={connections.length === 0}
                      >
                        <MenuItem value="" disabled>
                          {connections.length === 0 ? 'No connections — add one first' : 'Select a connection'}
                        </MenuItem>
                        {connections.map((connection) => (
                          <MenuItem key={connection.id} value={connection.id}>
                            {connection.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={useTemplate}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => {
                            setUseTemplate(event.target.checked)
                            // Checking "Use template" collapses the raw SQL
                            // editor; un-checking brings it back.
                            setEditorExpanded(!event.target.checked)
                          }}
                        />
                      }
                      label="Use template"
                      sx={{ mt: { xs: 0, sm: 0.5 }, mr: 0, minHeight: 40 }}
                    />
                    {useTemplate && fabTemplates.length > 0 && (
                      <FormControl size="small" sx={{ width: { xs: '100%', sm: 280 } }}>
                        <InputLabel id="fab-template-label">Template</InputLabel>
                        <Select
                          labelId="fab-template-label"
                          label="Template"
                          value={fabOption}
                          onChange={(event) => {
                            const nextOption = fabTemplates.find((o) => o.name === event.target.value)
                            setFabOption(event.target.value)
                            // Show the new template's base SQL; criteria are injected as they are filled.
                            // Strip the '{}' injection anchor so it never appears in the editor.
                            setSqlText((nextOption?.sql ?? '').replace(/\{\}/g, ''))
                            resetFabForm(nextOption)
                            // A template is now in use — collapse the raw SQL editor.
                            setEditorExpanded(false)
                          }}
                        >
                          <MenuItem value="" disabled>
                            Select a template
                          </MenuItem>
                          {fabTemplates.map((option) => (
                            <MenuItem key={option.name} value={option.name}>
                              {option.name}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    )}
                  </Stack>
                  <Tooltip title="How to use operators">
                    <IconButton
                      aria-label="How to use operators"
                      onClick={() => setCriteriaHelpOpen(true)}
                      sx={{ alignSelf: { xs: 'flex-start', sm: 'center' }, minWidth: 40, minHeight: 40 }}
                    >
                      <HelpOutlineOutlinedIcon />
                    </IconButton>
                  </Tooltip>
                </Stack>

                {/* Connection template quick-search (auto-shown for the selected connection) */}
                {useTemplate && (fabTemplates.length > 0 || fabTemplateError) && (
                  <>
                    <Divider />
                    <Box>
                {fabTemplateError && (
                  <Alert severity="error" sx={{ mt: 1 }}>
                    {fabTemplateError}
                  </Alert>
                )}
                {selectedFabOption ? (
                  <>
                    {selectedFabOption.fields.length > 0 && (
                      <>
                        {/* Criteria section header */}
                        <Typography variant="subtitle2" sx={{ mt: 0.5 }}>
                          Criteria
                        </Typography>
                        <Stack spacing={{ xs: 1.5, sm: 2 }} sx={{ mt: 1 }}>
                        {chunkFields(selectedFabOption.fields).map((pair) => (
                          <Stack
                            key={pair[0].key}
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={{ xs: 1, sm: 0 }}
                            useFlexGap
                            sx={{ alignItems: 'stretch' }}
                          >
                            <Box sx={{ flex: { xs: '0 0 auto', sm: pair[1] ? '0 1 50%' : '0 1 calc(50% - 17px)' }, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}>
                              {renderFabField(pair[0])}
                            </Box>
                            {pair[1] && (
                              <>
                                <Box
                                  aria-hidden
                                  sx={{
                                    display: { xs: 'none', sm: 'block' },
                                    width: 2,
                                    mx: 2,
                                    flexShrink: 0,
                                    alignSelf: 'stretch',
                                    bgcolor: 'rgba(100, 100, 100, 0.55)',
                                  }}
                                />
                                <Box sx={{ flex: { xs: '0 0 auto', sm: '0 1 50%' }, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}>
                                  {renderFabField(pair[1])}
                                </Box>
                              </>
                            )}
                          </Stack>
                        ))}
                      </Stack>
                      </>
                    )}
                    <Divider sx={{ mt: 2 }} />
                          <Stack
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={1}
                            useFlexGap
                            sx={{
                              alignItems: { xs: 'stretch', sm: 'center' },
                              justifyContent: 'space-between',
                              mt: 2,
                            }}
                          >
                            <Typography variant="subtitle2">Additional parameters</Typography>
                            <Stack
                              direction={{ xs: 'column', sm: 'row' }}
                              spacing={1}
                              useFlexGap
                              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
                            >
                              {selectedFabOption?.name === 'Tautona_Test_Result' && (
                                <>
                                  <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 210 }, minHeight: 40 }}>
                                    <InputLabel id="saved-component-set-label">Pre-defined components</InputLabel>
                                    <Select
                                      labelId="saved-component-set-label"
                                      label="Pre-defined components"
                                      value={selectedComponentSet}
                                      onChange={(event: SelectChangeEvent) => handleComponentSetChange(event.target.value)}
                                      disabled={componentSets.length === 0}
                                      renderValue={(value) =>
                                        value ? (
                                          value
                                        ) : (
                                          <Typography component="span" variant="inherit" color="text.secondary">
                                            Custom components
                                          </Typography>
                                        )
                                      }
                                    >
                                      <MenuItem value="">— none —</MenuItem>
                                      {componentSets.map((set) => (
                                        <MenuItem key={set.name} value={set.name}>
                                          {set.name}
                                        </MenuItem>
                                      ))}
                                    </Select>
                                  </FormControl>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    startIcon={<AddIcon />}
                                    onClick={() => setTestComponentsOpen(true)}
                                    sx={{ minHeight: 40, width: { xs: '100%', sm: 'auto' } }}
                                  >
                                    Test Components
                                  </Button>
                                </>
                              )}
                              {selectedFabOption?.name === 'Process_Data' && (
                                <>
                                  <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 210 }, minHeight: 40 }}>
                                    <InputLabel id="saved-channel-set-label">Pre-defined channels</InputLabel>
                                    <Select
                                      labelId="saved-channel-set-label"
                                      label="Pre-defined channels"
                                      value={selectedChannelSet}
                                      onChange={(event: SelectChangeEvent) => setSelectedChannelSet(event.target.value)}
                                      disabled={visibleChannelSets.length === 0}
                                    >
                                      <MenuItem value="">— none —</MenuItem>
                                      {visibleChannelSets.map((set) => (
                                        <MenuItem key={`${set.operation}|${set.name}`} value={set.name}>
                                          {set.name}
                                        </MenuItem>
                                      ))}
                                    </Select>
                                  </FormControl>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    startIcon={<GridViewIcon />}
                                    onClick={() => setChannelDialogOpen(true)}
                                    sx={{ minHeight: 40, width: { xs: '100%', sm: 'auto' } }}
                                  >
                                    Select Channels
                                  </Button>
                                </>
                              )}
                              <Button
                                size="small"
                                variant="outlined"
                                startIcon={<AddIcon />}
                                onClick={addFabExtraFilter}
                                disabled={fabAvailableColumns.length === 0}
                                sx={{ minHeight: 40 }}
                              >
                                Add parameter
                              </Button>
                            </Stack>
                          </Stack>
                          {fabColumnsLoading ? (
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                              Loading columns… (the base SQL selects all columns of the primary table)
                            </Typography>
                          ) : fabAvailableColumns.length === 0 ? (
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                              No additional columns available — the base SQL selects no explicit columns.
                            </Typography>
                          ) : (
                            fabExtraFilters.map((filter) => {
                              const isNullOp = IS_NULL_OPERATORS.has(filter.operator.toLowerCase())
                              const isBetween = filter.operator.toLowerCase() === 'between'
                              const isLikeOp = filter.operator === 'like' || filter.operator === 'not like'
                              const isInOp = filter.operator === 'in' || filter.operator === 'not in'
                              const dataType = filter.dataType ?? 'text'
                              const valueType = valueInputType(dataType)
                              /** Hover hint for the value field, when the active operator needs one. */
                              const valueTooltip = isLikeOp ? LIKE_TOOLTIP : isInOp ? IN_TOOLTIP : ''
                              return (
                                <Stack
                                  key={filter.id}
                                  direction={{ xs: 'column', sm: 'row' }}
                                  spacing={1}
                                  useFlexGap
                                  sx={{ mt: 1, alignItems: { xs: 'stretch', sm: 'center' } }}
                                >
                                  <FormControl size="small" sx={{ width: { xs: '100%', sm: 260 } }}>
                                    <InputLabel id={`ef-col-${filter.id}`}>Column</InputLabel>
                                    <Select
                                      labelId={`ef-col-${filter.id}`}
                                      label="Column"
                                      value={filter.column}
                                      onChange={(event: SelectChangeEvent) =>
                                        updateFabExtraFilter(filter.id, 'column', event.target.value)
                                      }
                                    >
                                      {fabAvailableColumns.map((col) => (
                                        <MenuItem key={col.value} value={col.value}>
                                          {col.label}
                                        </MenuItem>
                                      ))}
                                    </Select>
                                  </FormControl>
                                  <FormControl size="small" sx={{ width: { xs: '100%', sm: 140 }, flexShrink: 0 }}>
                                    <InputLabel id={`ef-type-${filter.id}`}>Type</InputLabel>
                                    <Select
                                      labelId={`ef-type-${filter.id}`}
                                      label="Type"
                                      value={dataType}
                                      onChange={(event: SelectChangeEvent) =>
                                        updateFabExtraFilter(filter.id, 'dataType', event.target.value)
                                      }
                                    >
                                      {EXTRA_DATA_TYPES.map((type) => (
                                        <MenuItem key={type.value} value={type.value}>
                                          {type.label}
                                        </MenuItem>
                                      ))}
                                    </Select>
                                  </FormControl>
                                  <FormControl size="small" sx={{ width: { xs: '100%', sm: 116 }, flexShrink: 0 }}>
                                    <InputLabel id={`ef-op-${filter.id}`}>Op</InputLabel>
                                    <Select
                                      labelId={`ef-op-${filter.id}`}
                                      label="Op"
                                      value={filter.operator}
                                      onChange={(event: SelectChangeEvent) =>
                                        updateFabExtraFilter(filter.id, 'operator', event.target.value)
                                      }
                                    >
                                      {extraOperatorsForType(dataType).map((op) => (
                                        <MenuItem key={op} value={op}>
                                          {TEMPLATE_OPERATORS[op]}
                                        </MenuItem>
                                      ))}
                                    </Select>
                                  </FormControl>
                                  {!isNullOp && (
                                    isBetween ? (
                                      <Stack
                                        direction={{ xs: 'column', sm: 'row' }}
                                        spacing={1}
                                        useFlexGap
                                        sx={{
                                          flexGrow: 1,
                                          minWidth: 0,
                                          width: { xs: '100%', sm: 'auto' },
                                          alignItems: { xs: 'stretch', sm: 'center' },
                                        }}
                                      >
                                        <TextField
                                          size="small"
                                          label="Value"
                                          type={valueType}
                                          value={filter.value}
                                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                            updateFabExtraFilter(filter.id, 'value', event.target.value)
                                          }
                                          sx={{ flex: 1, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}
                                          slotProps={{ inputLabel: { shrink: true } }}
                                        />
                                        <TextField
                                          size="small"
                                          label="to"
                                          type={valueType}
                                          value={filter.valueTo}
                                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                            updateFabExtraFilter(filter.id, 'valueTo', event.target.value)
                                          }
                                          sx={{ flex: 1, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}
                                          slotProps={{ inputLabel: { shrink: true } }}
                                        />
                                      </Stack>
                                    ) : valueTooltip ? (
                                      <Tooltip title={valueTooltip}>
                                        <Box sx={{ flexGrow: 1, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}>
                                          <TextField
                                            size="small"
                                            label="Value"
                                            type={valueType}
                                            value={filter.value}
                                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                              updateFabExtraFilter(filter.id, 'value', event.target.value)
                                            }
                                            fullWidth
                                            slotProps={{ inputLabel: { shrink: true } }}
                                          />
                                        </Box>
                                      </Tooltip>
                                    ) : (
                                      <TextField
                                        size="small"
                                        label="Value"
                                        type={valueType}
                                        value={filter.value}
                                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                          updateFabExtraFilter(filter.id, 'value', event.target.value)
                                        }
                                        fullWidth
                                        slotProps={{ inputLabel: { shrink: true } }}
                                      />
                                    )
                                  )}
                                  <IconButton
                                    size="small"
                                    onClick={() => removeFabExtraFilter(filter.id)}
                                    aria-label="Remove parameter"
                                    sx={{ flexShrink: 0 }}
                                  >
                                    <DeleteIcon />
                                  </IconButton>
                                </Stack>
                              )
                            })
                          )}
                        </>
                      ) : (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                          No template selected.
                        </Typography>
                      )}
                    </Box>
                  </>
                )}
                {/* Query editor: expand / collapse. Expanded by default and
                    collapsed automatically while a template is in use. When
                    collapsed, a one-line SQL summary keeps the context visible. */}
                <Link
                  component="button"
                  type="button"
                  variant="subtitle2"
                  underline="hover"
                  onClick={() => setEditorExpanded((expanded) => !expanded)}
                  aria-expanded={editorExpanded}
                  sx={{
                    alignSelf: 'flex-start',
                    minHeight: 48,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {editorExpanded ? 'Hide query editor' : 'Show query editor'}
                </Link>
                {editorExpanded ? (
                  <TextField
                    label="SQL (SELECT only — read-only enforced)"
                    value={sqlText}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setSqlText(event.target.value)}
                    fullWidth
                    multiline
                    rows={8}
                    placeholder="SELECT TOP 100 * FROM dbo.Sales;"
                    sx={{ '& textarea': { fontFamily: 'Consolas, monospace', fontSize: '0.9rem' } }}
                  />
                ) : (
                  <Box
                    role="button"
                    tabIndex={0}
                    aria-label="Expand query editor"
                    onClick={() => setEditorExpanded(true)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setEditorExpanded(true)
                      }
                    }}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      px: 1.5,
                      minHeight: 48,
                      cursor: 'pointer',
                      '&:hover': { backgroundColor: 'action.hover' },
                    }}
                  >
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      noWrap
                      sx={{ flexGrow: 1, minWidth: 0, fontFamily: 'Consolas, monospace', fontSize: '0.85rem' }}
                    >
                      {sqlPreviewLine(sqlText) || 'No SQL yet — expand to write a query.'}
                    </Typography>
                    <KeyboardArrowDownIcon sx={{ flexShrink: 0, color: 'primary.main', fontSize: '1.4rem' }} />
                  </Box>
                )}
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  useFlexGap
                  sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
                >
                  <Button
                    variant="contained"
                    startIcon={running ? <CircularProgress size={18} color="inherit" /> : <PlayArrowIcon />}
                    onClick={() => void handleRun()}
                    disabled={running || !sqlText.trim()}
                    sx={{ minHeight: 48 }}
                  >
                    {running ? 'Running…' : 'Run'}
                  </Button>
                  {running && (
                    <Button
                      variant="outlined"
                      color="error"
                      startIcon={cancelling ? <CircularProgress size={18} color="inherit" /> : undefined}
                      onClick={() => void handleCancelQuery()}
                      disabled={cancelling}
                      sx={{ minHeight: 48 }}
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel'}
                    </Button>
                  )}
                  <Tooltip title="Pretty-print the SQL for the selected connection's dialect">
                    <span style={{ display: 'flex' }}>
                      <Button
                        variant="outlined"
                        startIcon={<CodeIcon />}
                        onClick={() => void handleFormatSql()}
                        disabled={!sqlText.trim() || running}
                        sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
                      >
                        Format
                      </Button>
                    </span>
                  </Tooltip>
                  <Button
                    variant="outlined"
                    startIcon={<AutoAwesomeIcon />}
                    onClick={() => onOpenAi?.('sql')}
                    disabled={running}
                    sx={{ minHeight: 48 }}
                  >
                    AI assist
                  </Button>
                  <Tooltip title="Save the current query as a custom query">
                    <span style={{ display: 'flex' }}>
                      <Button
                        variant="outlined"
                        startIcon={savingQuery ? <CircularProgress size={18} /> : <SaveIcon />}
                        onClick={openSaveDialog}
                        disabled={!canSavePredefined || savingQuery}
                        sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
                      >
                        Save
                      </Button>
                    </span>
                  </Tooltip>
                  {/* The count rides in the button's top-right corner, so the
                      label stays short next to the other toolbar actions. */}
                  <Tooltip
                    title={
                      customQueryCount > 0
                        ? `Open your ${customQueryCount} saved custom quer${customQueryCount === 1 ? 'y' : 'ies'}`
                        : 'Open your saved custom queries'
                    }
                  >
                    <span style={{ display: 'flex' }}>
                      <Badge
                        badgeContent={customQueryCount}
                        max={99}
                        color="primary"
                        sx={{
                          display: 'flex',
                          width: { xs: '100%', sm: 'auto' },
                          '& .MuiBadge-badge': { fontWeight: 700, fontSize: 11 },
                        }}
                      >
                        <Button
                          variant="outlined"
                          startIcon={<LibraryBooksIcon />}
                          onClick={() => setCustomDialogOpen(true)}
                          sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
                        >
                          Custom
                        </Button>
                      </Badge>
                    </span>
                  </Tooltip>
                </Stack>
              </Stack>
            </Paper>
            {resultsPanel}
          </Stack>
        </Stack>
      )}

      {/* Results — inside the SQL-mode layout beside the full-height AI assist; standalone for Builder only */}
      {mode === 'builder' && resultsPanel}

      {/* Custom (pre-defined) query browser */}
      <Dialog
        open={customDialogOpen}
        onClose={() => {
          setCustomDialogOpen(false)
          // Save/delete happens inside the dialog, so re-count once it closes.
          void refreshCustomQueryCount()
        }}
        fullWidth
        maxWidth="lg"
        fullScreen={fullScreenDialog}
        slotProps={{ paper: { sx: { height: { xs: '100%', sm: 'min(90vh, 860px)' } } } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
          <LibraryBooksIcon color="primary" />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>Custom queries</Box>
          <IconButton onClick={() => setCustomDialogOpen(false)} aria-label="Close custom queries">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 1.5, sm: 3 }, py: { xs: 1.5, sm: 2 } }}>
          {/* The dialog unmounts its children on close, so the list refetches
              the latest saved queries every time it is opened. */}
          <PredefinedSqlPage
            onOpenInEditor={(kind) => {
              setCustomDialogOpen(false)
              setMode(kind)
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Save as pre-defined dialog */}
      <Dialog open={saveDialogOpen} onClose={() => setSaveDialogOpen(false)}>
        <DialogTitle>Save as pre-defined</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={1.5}>
            {mode === 'sql' && (
              <FormControl fullWidth size="small">
                <InputLabel id="save-sql-select-label">Existing custom SQL (optional)</InputLabel>
                <Select
                  labelId="save-sql-select-label"
                  label="Existing custom SQL (optional)"
                  value={selectedSqlId}
                  onChange={handleSqlSelectChange}
                  disabled={sqlsLoading}
                >
                  <MenuItem value="">
                    <em>None — save as new</em>
                  </MenuItem>
                  {existingSqls.map((q) => (
                    <MenuItem key={q.id} value={q.id}>
                      {q.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
            <TextField
              label="Query name"
              value={saveName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSaveName(event.target.value)}
              fullWidth
              required
              autoFocus
              placeholder="e.g. Monthly sales by region"
            />
            <TextField
              label="Description (optional)"
              value={saveDescription}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSaveDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              placeholder="What this query is for — shown on the pre-defined card."
            />
            {mode === 'builder' && (
              <Box>
                <Stack
                  direction="row"
                  sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Typography variant="subtitle2">Prompts (optional)</Typography>
                  <Button size="small" startIcon={<AddIcon />} onClick={addParameter} sx={{ minHeight: 36 }}>
                    Add prompt
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Ask for a value when this saved query is run. Each prompt becomes a filter on the
                  chosen column.
                </Typography>
                <Stack spacing={1}>
                  {saveParameters.map((p) => (
                    <Stack
                      key={p.id}
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1}
                      useFlexGap
                      sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
                    >
                      <TextField
                        size="small"
                        label="Label"
                        value={p.label}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          updateParameter(p.id, 'label', event.target.value)
                        }
                        sx={{ flexGrow: 1, minWidth: { xs: '100%', sm: 120 } }}
                      />
                      <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 140 } }}>
                        <Select
                          value={p.column}
                          onChange={(event: SelectChangeEvent) =>
                            updateParameter(p.id, 'column', event.target.value)
                          }
                          displayEmpty
                        >
                          <MenuItem value="" disabled>
                            Column
                          </MenuItem>
                          {columns.map((column) => (
                            <MenuItem key={column.name} value={column.name}>
                              {column.name}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 110 } }}>
                        <Select
                          value={p.operator}
                          onChange={(event: SelectChangeEvent) =>
                            updateParameter(p.id, 'operator', event.target.value)
                          }
                        >
                          {OPERATORS.map((op) => (
                            <MenuItem key={op.value} value={op.value}>
                              {op.label}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      {!NULL_OPERATORS.has(p.operator) && (
                        <TextField
                          size="small"
                          label="Default"
                          value={p.default}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateParameter(p.id, 'default', event.target.value)
                          }
                          sx={{ minWidth: { xs: '100%', sm: 120 } }}
                        />
                      )}
                      <IconButton
                        size="small"
                        onClick={() => removeParameter(p.id)}
                        aria-label="Remove prompt"
                        sx={{ alignSelf: { xs: 'flex-end', sm: 'center' } }}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  ))}
                  {saveParameters.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No prompts — the saved query runs with its current filters.
                    </Typography>
                  )}
                </Stack>
              </Box>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {mode === 'builder'
                ? 'Saved to Query → Custom (Builder query).'
                : 'Saved to Query → Custom (custom SQL).'}
            </Typography>
          </Stack>
          {saveError && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {saveError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setSaveDialogOpen(false)} disabled={savingQuery} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSaveQuery()}
            disabled={savingQuery}
            startIcon={savingQuery ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            sx={{ minHeight: 44 }}
          >
            {selectedSqlId ? 'Update' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Tautona quick-search: pick test components to fill RESULT_NAME. */}
      <TestComponentsDialog
        open={testComponentsOpen}
        onClose={() => setTestComponentsOpen(false)}
        connectionName={templateKey}
        onApply={(resultNames) => {
          setFabValues((current) => ({ ...current, result_name: resultNames }))
          setFabOperators((current) => ({ ...current, result_name: 'in' }))
        }}
        onSaved={refreshComponentSets}
        onNotice={setNotice}
      />

      <ChannelSelectDialog
        open={channelDialogOpen}
        onClose={() => setChannelDialogOpen(false)}
        connectionName={templateKey}
        onSaved={handleChannelDialogSaved}
        onNotice={setNotice}
      />

      {effectiveResult && (
        <AiGridTransformDialog
          open={aiTransformOpen}
          result={effectiveResult}
          onClose={() => setAiTransformOpen(false)}
          onApply={handleGridTransformApply}
        />
      )}

      <OperatorHelpDialog
        open={criteriaHelpOpen}
        onClose={() => setCriteriaHelpOpen(false)}
      />

      {/* Popup reminder when a template's required date criteria are blank */}
      <Dialog open={missingDateReminder !== null} onClose={() => setMissingDateReminder(null)} fullWidth maxWidth="xs">
        <DialogTitle>Date criteria required</DialogTitle>
        <DialogContent dividers>
          <Typography gutterBottom>
            The date field{missingDateReminder && missingDateReminder.length > 1 ? 's' : ''} below must be
            specified before the query runs — otherwise it would search the full date range.
          </Typography>
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
            {missingDateReminder?.map((label) => (
              <li key={label}>
                <Typography variant="body2">{label}</Typography>
              </li>
            ))}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            variant="contained"
            onClick={() => setMissingDateReminder(null)}
            sx={{ minHeight: 40, minWidth: 96 }}
          >
            OK
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={3500}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" variant="filled" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      </Snackbar>
    </Box>
  )
}

// The page stays mounted while another tab is shown, so memoising it keeps a
// view switch from re-rendering every other page in the shell.
export default memo(WorkspacePage)
