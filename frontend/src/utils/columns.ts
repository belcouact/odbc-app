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

/** The two AI dialogs that show a data-aware example placeholder. */
export type AiExampleKind = 'dashboard' | 'summary'

/**
 * Split result columns into the pieces both AI example helpers need: the
 * numeric metrics, the first date column and the categorical groups. Falls
 * back to value sampling via detectColumnKind for untyped results.
 */
function classifyColumns(
  columns: { name: string; type: string }[],
  rows: QueryResult['rows'],
): { metrics: string[]; date?: string; groups: string[] } {
  const columnKind = (column: { name: string; type: string }) =>
    detectColumnKind(column.name, column.type, rows)
  return {
    metrics: columns.filter((column) => columnKind(column) === 'number').map((column) => column.name),
    date: columns.find((column) => columnKind(column) === 'date')?.name,
    groups: columns
      .filter((column) => {
        const k = columnKind(column)
        return k === 'text' || k === 'boolean'
      })
      .map((column) => column.name),
  }
}

/** Join a list into "a, b and c" for readable example sentences. */
function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * A data-aware example prompt shown as the placeholder in the AI dialogs, so
 * the example names columns the user's current data actually has (a metric,
 * a grouping column and a date column where available). Falls back to a
 * generic phrasing when the result has no usable columns.
 */
export function aiExamplePlaceholder(
  columns: { name: string; type: string }[],
  rows: QueryResult['rows'],
  kind: AiExampleKind,
): string {
  const { metrics, date, groups } = classifyColumns(columns, rows)
  const metric = metrics[0]
  const [groupA, groupB] = groups

  if (kind === 'summary') {
    if (metric && groupA) return `e.g. compare ${metric} by ${groupA} and flag outliers`
    if (metric && date) return `e.g. show the trend of ${metric} over ${date} and flag outliers`
    if (metric) return `e.g. summarise ${metric} and flag outliers`
    if (groupA) return `e.g. count rows per ${groupA} and flag anything unusual`
    if (date) return `e.g. summarise activity over ${date} and flag anything unusual`
    return 'e.g. describe the key patterns and flag anything unusual'
  }

  if (metric && date && groupA)
    return `e.g. ${metric} trend over ${date}, top 10 ${groupA} by ${metric}, and the split by ${groupB ?? groupA}`
  if (metric && groupA)
    return `e.g. ${metric} by ${groupA}, and the split by ${groupB ?? groupA}`
  if (metric && date) return `e.g. ${metric} trend over ${date}, and its distribution`
  if (metric) return `e.g. the distribution of ${metric}`
  if (date && groupA) return `e.g. row count over ${date} by ${groupA}`
  if (date) return `e.g. row count over ${date}`
  return 'e.g. the distribution of each column and how they relate'
}

/** A one-click example prompt shown as a button in the AI dashboard builder. */
export interface DashboardExample {
  /** Short button label, e.g. "Overview". */
  label: string
  /** Full multi-chart prompt inserted into the text area when clicked. */
  prompt: string
}

/**
 * A few data-aware example dashboard prompts. Each one asks for several
 * complementary charts (never a single chart), because the dashboard builder
 * is meant to design a whole dashboard. Column names come from the user's
 * current data; only the examples the data can support are returned.
 */
export function aiDashboardExamples(
  columns: { name: string; type: string }[],
  rows: QueryResult['rows'],
): DashboardExample[] {
  const { metrics, date, groups } = classifyColumns(columns, rows)
  const [metricA, metricB] = metrics
  const [groupA, groupB] = groups
  const metric = metricA ?? 'the key metric'
  const examples: DashboardExample[] = []

  // 1) Overview — headline numbers plus a trend and a breakdown.
  const overview = [
    `KPI cards for the total and average ${metric}`,
    date ? `a line chart of ${metric} over ${date}` : null,
    groupA ? `a bar chart of ${metric} by ${groupA}` : null,
  ].filter((part): part is string => part !== null)
  if (overview.length >= 2) {
    examples.push({
      label: 'Overview',
      prompt: `Build an overview dashboard with ${joinPhrases(overview)}.`,
    })
  }

  // 2) Trends over time — needs a date column.
  if (date) {
    const trendCharts = metricB
      ? `two line charts (one for ${metric} and one for ${metricB}) plus a bar chart of the row count over ${date}`
      : `a line chart of ${metric} over ${date}, an area chart of the running total and a bar chart of the row count over ${date}`
    examples.push({
      label: 'Trends',
      prompt: `Show how the data changes over ${date} with ${trendCharts}.`,
    })
  }

  // 3) Comparison / breakdown — needs a category column.
  if (groupA) {
    const breakdown = [
      `a bar chart of ${metric} by ${groupA}`,
      groupB ? `a pie chart of ${metric} by ${groupB}` : null,
      `a table of the top 10 ${groupA} by ${metric}`,
    ].filter((part): part is string => part !== null)
    examples.push({
      label: 'Breakdown',
      prompt: `Compare ${metric} across the data with ${joinPhrases(breakdown)}.`,
    })
  }

  // 4) Distribution / correlation — needs at least one metric.
  if (metricA) {
    const spread = [
      `a histogram of ${metricA}`,
      metricB ? `a histogram of ${metricB}` : null,
      metricB ? `a scatter of ${metricA} against ${metricB}` : `a box plot of ${metricA}`,
    ].filter((part): part is string => part !== null)
    examples.push({
      label: 'Distribution',
      prompt: `Explore the spread of the metrics with ${joinPhrases(spread)}.`,
    })
  }

  if (examples.length === 0) {
    examples.push({
      label: 'Overview',
      prompt:
        'Build an overview dashboard with a few KPI cards, a trend line over time, a bar chart breaking the totals down by category and a pie chart of the shares.',
    })
  }

  return examples.slice(0, 4)
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

