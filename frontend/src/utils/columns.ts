import type { DateGrain, QueryResult } from '../types'

/**
 * Database type names that should be treated as numeric.
 * Matches e.g. "int", "integer", "bigint", "decimal(10,2)", "float", "numeric", "money".
 * Does not match "nvarchar", "datetime", "text", ...
 */
const NUMERIC_TYPE_RE =
  /(^|[\s(])(int|integer|bigint|smallint|tinyint|number|numeric|decimal|float|real|double|money|smallmoney|serial)(\s|\(|$)/i

/**
 * ODBC SQL type codes (as returned by ``cursor.description`` via the backend,
 * e.g. as the string "4") that map to numeric types: NUMERIC(2), DECIMAL(3),
 * INTEGER(4), SMALLINT(5), FLOAT(6), REAL(7), DOUBLE(8), BIGINT(-5), TINYINT(-6).
 */
const ODBC_NUMERIC_TYPE_CODES = new Set(['2', '3', '4', '5', '6', '7', '8', '-5', '-6'])

/** Type names treated as date/time (SQL type names, pandas dtypes). */
const DATE_TYPE_RE = /(^|[\s(])(date|datetime|time|timestamp|smalldatetime)(\s|\(|$)/i
/** ODBC date/time type codes: DATE(9/91), TIME(92), TIMESTAMP(93). */
const ODBC_DATE_TYPE_CODES = new Set(['9', '91', '92', '93'])

/** Type names treated as boolean (SQL type names, pandas dtypes). */
const BOOLEAN_TYPE_RE = /(^|[\s(])(bool|boolean|bit)(\s|\(|$)/i
/** ODBC boolean type codes: BIT(-7), BOOLEAN(16). */
const ODBC_BOOLEAN_TYPE_CODES = new Set(['-7', '16'])

export function isNumericColumnType(dataType: string): boolean {
  return NUMERIC_TYPE_RE.test(dataType) || ODBC_NUMERIC_TYPE_CODES.has(dataType.trim())
}

/** A column is numeric if its declared type looks numeric or its values are numbers. */
export function isNumericColumn(
  name: string,
  dataType: string,
  rows: QueryResult['rows'],
): boolean {
  if (isNumericColumnType(dataType)) return true
  return rows.some((row) => typeof row[name] === 'number')
}

/** Names of the numeric columns among the given result columns. */
export function numericColumnNames(
  columns: QueryResult['columns'],
  rows: QueryResult['rows'],
): string[] {
  return columns
    .filter((column) => isNumericColumn(column.name, column.type, rows))
    .map((column) => column.name)
}

/** The recognized data kinds a grid column can be shown / treated as. */
export type ColumnKind = 'number' | 'text' | 'boolean' | 'date'

/** Human-friendly labels for each column kind (shown in the grid header). */
export const COLUMN_KIND_LABELS: Record<ColumnKind, string> = {
  number: 'Number',
  text: 'Text',
  boolean: 'Boolean',
  date: 'Date',
}

/** Selectable kinds offered by the grid header type switcher. */
export const COLUMN_KIND_OPTIONS: { value: ColumnKind; label: string }[] = [
  { value: 'number', label: 'Number' },
  { value: 'text', label: 'Text' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
]

/** A Date object or an ISO-like "YYYY-MM-DD..." string. */
function looksLikeDate(value: unknown): boolean {
  if (value instanceof Date) return true
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)
  return false
}

/**
 * Auto-recognize a column's data kind from its declared type, then fall back to
 * sampling its values (for uploaded files / metadata where the type is generic).
 * The canonical strings "number" / "text" / "boolean" / "date" are also
 * recognized so a user-overridden type round-trips correctly.
 */
export function detectColumnKind(
  name: string,
  dataType: string,
  rows: QueryResult['rows'],
): ColumnKind {
  const t = (dataType ?? '').trim()
  const lower = t.toLowerCase()

  // Canonical kind strings written by the grid header type switcher.
  if (lower === 'number') return 'number'
  if (lower === 'text' || lower === 'string') return 'text'
  if (lower === 'date' || lower === 'datetime') return 'date'
  if (lower === 'boolean') return 'boolean'

  if (isNumericColumnType(t)) return 'number'
  if (DATE_TYPE_RE.test(t) || ODBC_DATE_TYPE_CODES.has(t)) return 'date'
  if (BOOLEAN_TYPE_RE.test(t) || ODBC_BOOLEAN_TYPE_CODES.has(t)) return 'boolean'

  // pandas dtype strings from uploaded files, e.g. "int64", "float64",
  // "datetime64[ns]", "bool", "string".
  if (/^(datetime|timestamp|date)/.test(lower)) return 'date'
  if (lower.includes('bool')) return 'boolean'
  if (/number|decimal|^int|^float|^double/.test(lower)) return 'number'

  // Value sampling fallback when the type is generic (e.g. "object").
  const sample = rows
    .slice(0, 200)
    .map((row) => row[name])
    .filter((value) => value !== null && value !== undefined)
  if (sample.length === 0) return 'text'
  if (sample.every((value) => typeof value === 'boolean')) return 'boolean'
  if (sample.every((value) => typeof value === 'number')) return 'number'
  if (sample.every(looksLikeDate)) return 'date'
  if (sample.every((value) => typeof value === 'string' && /^\d+$/.test(value))) return 'number'
  return 'text'
}

// ---------------------------------------------------------------------------
// Date grouping (Year / Quarter / Month / Day)
// ---------------------------------------------------------------------------

/** Calendar buckets the Summary tab can group a date column to. */
export const DATE_GRAIN_OPTIONS: { value: DateGrain; label: string }[] = [
  { value: 'none', label: 'Exact value' },
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
  { value: 'day', label: 'Day' },
]

/** Parse a Date object or ISO-like string without the UTC shift ``new Date`` applies. */
function toDateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || !looksLikeDate(value)) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  return Number.isNaN(date.getTime()) ? null : date
}

/** Bucket a date-like cell to its calendar label; null when it is not a date. */
export function dateGrainKey(value: unknown, grain: DateGrain): string | null {
  const date = toDateValue(value)
  if (!date) return null
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  if (grain === 'year') return String(year)
  if (grain === 'quarter') return `${year} Q${Math.floor((month - 1) / 3) + 1}`
  if (grain === 'month') return `${year}-${String(month).padStart(2, '0')}`
  return `${year}-${String(month).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Grouping key for one cell: the date bucket when a grain is active, otherwise
 * the stringified raw value ('' for blanks). The results grid's drill-through
 * predicate calls this with the same arguments, so a group always matches
 * exactly the rows that produced it.
 */
export function groupingKey(value: unknown, grain: DateGrain): string {
  if (grain !== 'none') return dateGrainKey(value, grain) ?? ''
  if (value === null || value === undefined) return ''
  return String(value)
}

