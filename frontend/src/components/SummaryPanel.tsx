import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableFooter from '@mui/material/TableFooter'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import InsightsIcon from '@mui/icons-material/Insights'
import TableRowsIcon from '@mui/icons-material/TableRows'
import { api, downloadBlob } from '../api/client'
import type { ChartOperation } from '../api/client'
import type { DateGrain, GridDrillFilter, QueryResult } from '../types'
import { aggregateGroup, quantileSorted, toNumber } from '../utils/chartData'
import { CATEGORICAL_OPERATIONS, OPERATIONS } from '../utils/chartCatalog'
import {
  COLUMN_KIND_LABELS,
  DATE_GRAIN_OPTIONS,
  detectColumnKind,
  groupingKey,
  type ColumnKind,
} from '../utils/columns'
import FieldWell from './ChartFieldWell'

/** Statistics offered for every column on the Statistics shelf (long table). */
const STAT_FIELDS: { key: keyof SummaryStat; label: string }[] = [
  { key: 'count', label: 'Count' },
  { key: 'nulls', label: 'Nulls' },
  { key: 'sum', label: 'Sum' },
  { key: 'mean', label: 'Average' },
  { key: 'min', label: 'Min' },
  { key: 'max', label: 'Max' },
  { key: 'range', label: 'Range' },
  { key: 'median', label: 'Median' },
  { key: 'std', label: 'Std dev' },
]

/** Header used for the "which column" column of the statistics table. */
const COLUMN_HEADER = 'Column'

/** Cap the grouped output so grouping by a high-cardinality column can't lock
 *  up the browser (the table is a summary, not a full dump). */
const MAX_GROUPS = 200
/** Pivot guards: cap each axis so a cross-tab cannot explode into 100k cells. */
const MAX_PIVOT_ROWS = 200
const MAX_PIVOT_COLS = 60

const KIND_ORDER: ColumnKind[] = ['number', 'text', 'date', 'boolean']

/** Operations that make sense as a pivot measure (raw / % of total do not). */
const MEASURE_OPERATIONS = OPERATIONS.filter((op) => op.value !== 'none' && op.value !== 'share')

/** Numeric statistics for one column within one group (null = not computable). */
interface SummaryStat {
  count: number
  nulls: number
  sum: number | null
  mean: number | null
  min: number | null
  max: number | null
  range: number | null
  median: number | null
  std: number | null
}

/** One table row: the group's label values + the stats of a single column. */
interface SummaryRow extends SummaryStat {
  /** Group-by cell values, in the same order as the selected group columns. */
  labels: unknown[]
  column: string
}

/** One "Values" entry of the pivot: a column aggregated with an operation. */
interface Measure {
  column: string
  op: ChartOperation
}

/** One line of a pivot axis: the stringified grouping keys it matches. */
interface AxisLine {
  key: string
  values: string[]
}

/** A fully materialised (rows × columns × measures) cross-tab. */
interface PivotModel {
  rowLines: AxisLine[]
  colLines: AxisLine[]
  measures: Measure[]
  /** Aggregated value per row line / column line / measure index. */
  cellAt: (rowIndex: number, colIndex: number, measureIndex: number) => number
  /** Aggregations over a whole row or column line (not a sum of cells). */
  rowTotalAt: (rowIndex: number, measureIndex: number) => number
  colTotalAt: (colIndex: number, measureIndex: number) => number
  grandAt: (measureIndex: number) => number
  /** Max absolute value per measure, for data-bar scaling. */
  scale: number[]
  /** Filters that reproduce a row line / column line on the results grid. */
  rowFilter: (rowIndex: number) => GridDrillFilter[]
  colFilter: (colIndex: number) => GridDrillFilter[]
  truncated: boolean
}

interface SummaryPanelProps {
  result: QueryResult | null
  /** Send a drill-through filter (or clear it with an empty array) to the grid. */
  onDrillThrough?: (filters: GridDrillFilter[]) => void
}

/** Display a statistic, keeping full numbers readable (no axis-style compacting). */
function formatStat(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

/** Display a group-by cell value, keeping blanks visible. */
function formatLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(blank)'
  if (value instanceof Date) return value.toLocaleString()
  return String(value)
}

/** Compute every statistic for one column's values (population std dev). */
function computeStat(
  values: number[],
  totalRows: number,
  labels: unknown[],
  column: string,
): SummaryRow {
  const count = values.length
  if (count === 0) {
    return {
      labels,
      column,
      count,
      nulls: totalRows,
      sum: null,
      mean: null,
      min: null,
      max: null,
      range: null,
      median: null,
      std: null,
    }
  }
  let sum = 0
  let min = values[0]
  let max = values[0]
  for (const value of values) {
    sum += value
    if (value < min) min = value
    if (value > max) max = value
  }
  const mean = sum / count
  let squared = 0
  for (const value of values) squared += (value - mean) * (value - mean)
  const sorted = [...values].sort((a, b) => a - b)
  return {
    labels,
    column,
    count,
    nulls: totalRows - count,
    sum,
    mean,
    min,
    max,
    range: max - min,
    median: quantileSorted(sorted, 0.5),
    std: Math.sqrt(squared / count),
  }
}

/** Key of a group combination ('' cell values stay distinguishable). */
function lineKey(labels: string[]): string {
  return labels.join('\u0001')
}

/** Display a pivot axis key, keeping blanks visible. */
function displayKey(key: string): string {
  return key === '' ? '(blank)' : key
}

/** Readable one-line label of an axis line (one value per field). */
function formatAxisLabel(line: AxisLine): string {
  if (line.values.length === 0) return 'All'
  return line.values.map(displayKey).join(' / ')
}

/**
 * Axis label cell content. With several fields on one axis, the values are
 * stacked and indented instead of being concatenated with an invisible
 * separator, which otherwise reads as e.g. "Film CNorth".
 */
function AxisLabel({ line }: { line: AxisLine }) {
  if (line.values.length <= 1) return <>{displayKey(line.key)}</>
  return (
    <Stack spacing={0}>
      {line.values.map((value, index) => (
        <Box
          key={`${index}-${value}`}
          sx={{
            pl: index * 1.5,
            fontSize: index === 0 ? 'inherit' : '0.75rem',
            color: index === 0 ? 'text.primary' : 'text.secondary',
            whiteSpace: 'nowrap',
          }}
        >
          {displayKey(value)}
        </Box>
      ))}
    </Stack>
  )
}

interface AxisFilterMenuProps {
  title: string
  anchorEl: HTMLElement | null
  items: AxisLine[]
  /** Keys currently shown, or null when nothing is filtered out. */
  selection: string[] | null
  onChange: (next: string[] | null) => void
  onClose: () => void
}

/** Excel-style "filter by items" checklist for one pivot axis. */
function AxisFilterMenu({
  title,
  anchorEl,
  items,
  selection,
  onChange,
  onClose,
}: AxisFilterMenuProps) {
  const [query, setQuery] = useState('')
  const allKeys = useMemo(() => items.map((item) => item.key), [items])
  const shown = selection === null ? items.length : selection.length
  const allShown = items.length > 0 && shown === items.length
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? items.filter((item) => formatAxisLabel(item).toLowerCase().includes(needle))
    : items

  const toggle = (key: string) => {
    const current = selection === null ? allKeys : selection
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
    // A full selection is stored as null so "no filter" stays distinguishable
    // from "everything unchecked".
    onChange(next.length === items.length ? null : next)
  }

  return (
    <Menu
      anchorEl={anchorEl}
      open={Boolean(anchorEl)}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: 264 } } }}
    >
      <Box sx={{ px: 1.5, pt: 1.25, pb: 0.5 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Typography variant="caption" color="text.secondary">
          {shown} of {items.length} shown
        </Typography>
      </Box>
      {items.length > 8 && (
        <Box sx={{ px: 1.5, pb: 0.5 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Box>
      )}
      <MenuItem dense onClick={() => onChange(allShown ? [] : null)} sx={{ minHeight: 40 }}>
        <Checkbox
          size="small"
          checked={allShown}
          indeterminate={shown > 0 && !allShown}
          tabIndex={-1}
          disableRipple
        />
        <ListItemText primary="Select all" />
      </MenuItem>
      <Divider />
      <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
        {visible.map((item) => (
          <MenuItem key={item.key} dense onClick={() => toggle(item.key)} sx={{ minHeight: 40 }}>
            <Checkbox
              size="small"
              checked={selection === null || selection.includes(item.key)}
              tabIndex={-1}
              disableRipple
            />
            <ListItemText
              primary={formatAxisLabel(item)}
              slotProps={{ primary: { noWrap: true } }}
            />
          </MenuItem>
        ))}
        {visible.length === 0 && (
          <MenuItem dense disabled>
            No matches
          </MenuItem>
        )}
      </Box>
      <Divider />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 0.75 }}>
        <Button size="small" onClick={onClose} sx={{ minHeight: 40 }}>
          Done
        </Button>
      </Box>
    </Menu>
  )
}

/**
 * Summary tab: aggregates the grid's rows in the browser, two ways.
 *
 * - **Table** — the long-format statistics table (count / nulls / sum / … ) built
 *   from the "Group by" and "Statistics" shelves.
 * - **Pivot** — a cross-tab built from the "Rows" / "Columns" / "Values" shelves,
 *   with a per-measure aggregation, row / column / grand totals and data bars.
 *
 * Date columns can be bucketed to Year / Quarter / Month / Day, and clicking any
 * group drills the results grid down to exactly the rows behind it (both sides
 * share ``groupingKey``, so the match is exact).
 */
export default function SummaryPanel({ result, onDrillThrough }: SummaryPanelProps) {
  const [layout, setLayout] = useState<'table' | 'pivot'>('table')
  const [groupBy, setGroupBy] = useState<string[]>([])
  const [statColumns, setStatColumns] = useState<string[]>([])
  const [pivotRows, setPivotRows] = useState<string[]>([])
  const [pivotCols, setPivotCols] = useState<string[]>([])
  const [measures, setMeasures] = useState<Measure[]>([])
  const [grains, setGrains] = useState<Record<string, DateGrain>>({})
  const [showBars, setShowBars] = useState(true)
  /** Whether the Fields palette is expanded (desktop: side-by-side, mobile: above). */
  const [fieldsOpen, setFieldsOpen] = useState(true)
  /** Axis item filters: the row / column lines currently shown (null = all). */
  const [rowSelection, setRowSelection] = useState<string[] | null>(null)
  const [colSelection, setColSelection] = useState<string[] | null>(null)
  const [rowFilterAnchor, setRowFilterAnchor] = useState<HTMLElement | null>(null)
  const [colFilterAnchor, setColFilterAnchor] = useState<HTMLElement | null>(null)
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  /** Auto-detected data kind for each column (Number / Text / Boolean / Date). */
  const columnKinds = useMemo(() => {
    const map: Record<string, ColumnKind> = {}
    for (const column of result?.columns ?? []) {
      map[column.name] = detectColumnKind(column.name, column.type, result?.rows ?? [])
    }
    return map
  }, [result])

  const allNames = useMemo(() => (result?.columns ?? []).map((c) => c.name), [result])
  const numericNames = useMemo(
    () => allNames.filter((name) => columnKinds[name] === 'number'),
    [allNames, columnKinds],
  )

  // Signatures let the selection survive unrelated re-renders (e.g. a new
  // calculated column) while still being pruned when the columns really change.
  const nameSignature = allNames.join('\u0000')
  const numericSignature = numericNames.join('\u0000')

  useEffect(() => {
    const keep = (prev: string[]) => prev.filter((name) => allNames.includes(name))
    setGroupBy(keep)
    setPivotRows(keep)
    setPivotCols(keep)
    setStatColumns((prev) => {
      const kept = prev.filter((name) => numericNames.includes(name))
      return kept.length > 0 ? kept : numericNames.slice(0, 3)
    })
    setMeasures((prev) => {
      const kept = prev.filter((m) => allNames.includes(m.column))
      if (kept.length > 0) return kept
      return numericNames.length > 0 ? [{ column: numericNames[0], op: 'sum' }] : []
    })
    setGrains((prev) => {
      const next: Record<string, DateGrain> = {}
      for (const name of allNames) {
        const grain = prev[name]
        if (grain) next[name] = grain
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameSignature, numericSignature])

  /** Pivot axis filters are tied to the axis fields, so drop them whenever the
   *  Rows / Columns definition changes (item keys from the old axis no longer
   *  describe the new one). */
  const pivotAxisSignature = `${pivotRows.join('\u0000')}\u0001${pivotCols.join('\u0000')}`
  useEffect(() => {
    setRowSelection(null)
    setColSelection(null)
  }, [pivotAxisSignature])

  const grainOf = useCallback(
    (name: string): DateGrain => {
      if (columnKinds[name] !== 'date') return 'none'
      return grains[name] ?? 'month'
    },
    [columnKinds, grains],
  )

  // ---- Shelf handlers ----

  const toggle = (setter: (fn: (prev: string[]) => string[]) => void) => (name: string) =>
    setter((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  const add = (setter: (fn: (prev: string[]) => string[]) => void) => (name: string) =>
    setter((prev) => (prev.includes(name) ? prev : [...prev, name]))
  const remove = (setter: (fn: (prev: string[]) => string[]) => void) => (name: string) =>
    setter((prev) => prev.filter((n) => n !== name))

  const handleGroupToggle = toggle(setGroupBy)
  const handleGroupAdd = add(setGroupBy)
  const handleGroupRemove = remove(setGroupBy)
  const handleStatToggle = toggle(setStatColumns)
  const handleStatAdd = add(setStatColumns)
  const handleStatRemove = remove(setStatColumns)
  const handleRowToggle = toggle(setPivotRows)
  const handleRowAdd = add(setPivotRows)
  const handleRowRemove = remove(setPivotRows)
  const handleColToggle = toggle(setPivotCols)
  const handleColAdd = add(setPivotCols)
  const handleColRemove = remove(setPivotCols)

  const handleMeasureAdd = (name: string) =>
    setMeasures((prev) =>
      prev.some((m) => m.column === name)
        ? prev
        : [...prev, { column: name, op: columnKinds[name] === 'number' ? 'sum' : 'count' }],
    )
  const handleMeasureRemove = (name: string) =>
    setMeasures((prev) => prev.filter((m) => m.column !== name))
  const handleMeasureOp = (name: string, op: ChartOperation) =>
    setMeasures((prev) => prev.map((m) => (m.column === name ? { ...m, op } : m)))

  /** Operations selectable for a measure (categorical columns only count). */
  const operationsFor = (name: string) =>
    columnKinds[name] === 'number'
      ? MEASURE_OPERATIONS
      : MEASURE_OPERATIONS.filter((op) => CATEGORICAL_OPERATIONS.includes(op.value))

  // ---- Long-format table ----

  /** Single pass over the rows: bucket by group key, collect numeric values. */
  const summary = useMemo(() => {
    const empty = { rows: [] as SummaryRow[], groups: 0, truncated: false }
    if (!result || result.rows.length === 0 || statColumns.length === 0) return empty

    const buckets = new Map<
      string,
      { labels: unknown[]; total: number; values: Map<string, number[]> }
    >()
    let truncated = false

    for (const row of result.rows) {
      const keys = groupBy.map((name) => groupingKey(row[name], grainOf(name)))
      const key = lineKey(keys)
      let bucket = buckets.get(key)
      if (!bucket) {
        if (buckets.size >= MAX_GROUPS) {
          truncated = true
          continue
        }
        bucket = { labels: keys, total: 0, values: new Map() }
        for (const name of statColumns) bucket.values.set(name, [])
        buckets.set(key, bucket)
      }
      bucket.total += 1
      for (const name of statColumns) {
        const value = toNumber(row[name])
        if (value !== null) bucket.values.get(name)?.push(value)
      }
    }

    const rows: SummaryRow[] = []
    for (const bucket of buckets.values()) {
      for (const name of statColumns) {
        rows.push(computeStat(bucket.values.get(name) ?? [], bucket.total, bucket.labels, name))
      }
    }
    return { rows, groups: buckets.size, truncated }
  }, [result, groupBy, statColumns, grainOf])

  // ---- Pivot ----

  /**
   * Every row / column line the pivot could show, before its axis filter is
   * applied. The filter menus list these, so hidden items stay reachable.
   */
  const axisItems = useMemo(() => {
    const rows: AxisLine[] = []
    const cols: AxisLine[] = []
    let truncated = false
    if (!result || result.rows.length === 0) return { rows, cols, truncated }
    if (pivotRows.length === 0) rows.push({ key: '', values: [] })
    if (pivotCols.length === 0) cols.push({ key: '', values: [] })
    const seenRows = new Set(rows.map((line) => line.key))
    const seenCols = new Set(cols.map((line) => line.key))
    const rowsCapped = () => pivotRows.length > 0 && rows.length >= MAX_PIVOT_ROWS
    const colsCapped = () => pivotCols.length > 0 && cols.length >= MAX_PIVOT_COLS

    for (const row of result.rows) {
      if (rowsCapped() && colsCapped()) {
        truncated = true
        break
      }
      if (pivotRows.length > 0) {
        const values = pivotRows.map((name) => groupingKey(row[name], grainOf(name)))
        const key = lineKey(values)
        if (!seenRows.has(key)) {
          if (rowsCapped()) truncated = true
          else {
            seenRows.add(key)
            rows.push({ key, values })
          }
        }
      }
      if (pivotCols.length > 0) {
        const values = pivotCols.map((name) => groupingKey(row[name], grainOf(name)))
        const key = lineKey(values)
        if (!seenCols.has(key)) {
          if (colsCapped()) truncated = true
          else {
            seenCols.add(key)
            cols.push({ key, values })
          }
        }
      }
    }
    return { rows, cols, truncated }
  }, [result, pivotRows, pivotCols, grainOf])

  const pivot = useMemo<PivotModel | null>(() => {
    if (!result || result.rows.length === 0) return null
    if (measures.length === 0) return null
    if (pivotRows.length === 0 && pivotCols.length === 0) return null

    // The axis filter drops hidden items before aggregating, so the row,
    // column and grand totals describe only what is actually on screen.
    const rowLines = axisItems.rows.filter(
      (line) => rowSelection === null || rowSelection.includes(line.key),
    )
    const colLines = axisItems.cols.filter(
      (line) => colSelection === null || colSelection.includes(line.key),
    )
    const rowIndex = new Map(rowLines.map((line, index) => [line.key, index]))
    const colIndex = new Map(colLines.map((line, index) => [line.key, index]))
    const rowRows: Record<string, unknown>[][] = rowLines.map(() => [])
    const colRows: Record<string, unknown>[][] = colLines.map(() => [])
    const cellRows = new Map<string, Record<string, unknown>[]>()
    const grandRows: Record<string, unknown>[] = []
    const truncated = axisItems.truncated

    for (const row of result.rows) {
      const rIndex = rowIndex.get(lineKey(pivotRows.map((name) => groupingKey(row[name], grainOf(name)))))
      if (rIndex === undefined) continue
      const cIndex = colIndex.get(lineKey(pivotCols.map((name) => groupingKey(row[name], grainOf(name)))))
      if (cIndex === undefined) continue

      rowRows[rIndex].push(row)
      colRows[cIndex].push(row)
      grandRows.push(row)
      const cellKey = `${rIndex}\u0003${cIndex}`
      const existing = cellRows.get(cellKey)
      if (existing) existing.push(row)
      else cellRows.set(cellKey, [row])
    }

    const scale = measures.map((measure) => {
      let max = 0
      for (let r = 0; r < rowLines.length; r += 1) {
        for (let c = 0; c < colLines.length; c += 1) {
          const rows = cellRows.get(`${r}\u0003${c}`)
          if (!rows || rows.length === 0) continue
          const value = Math.abs(aggregateGroup(rows, measure.column, measure.op))
          if (value > max) max = value
        }
      }
      return max
    })

    const filterFor = (names: string[], values: string[]): GridDrillFilter[] =>
      names.map((name, index) => ({ column: name, values: [values[index]], grain: grainOf(name) }))

    return {
      rowLines,
      colLines,
      measures,
      cellAt: (r, c, m) => {
        const rows = cellRows.get(`${r}\u0003${c}`)
        if (!rows || rows.length === 0) return 0
        return aggregateGroup(rows, measures[m].column, measures[m].op)
      },
      rowTotalAt: (r, m) => aggregateGroup(rowRows[r] ?? [], measures[m].column, measures[m].op),
      colTotalAt: (c, m) => aggregateGroup(colRows[c] ?? [], measures[m].column, measures[m].op),
      grandAt: (m) => aggregateGroup(grandRows, measures[m].column, measures[m].op),
      scale,
      rowFilter: (r) => filterFor(pivotRows, rowLines[r].values),
      colFilter: (c) => filterFor(pivotCols, colLines[c].values),
      truncated,
    }
  }, [result, measures, pivotRows, pivotCols, grainOf, axisItems, rowSelection, colSelection])

  // ---- Export / copy ----

  /** Headers + raw cells of whichever layout is active, for copy & Excel. */
  const matrix = useMemo<{ headers: string[]; rows: unknown[][]; types: ('text' | 'number')[] }>(
    () => {
      if (layout === 'table') {
        const headers = [...groupBy, COLUMN_HEADER, ...STAT_FIELDS.map((f) => f.label)]
        const types: ('text' | 'number')[] = [
          ...groupBy.map(() => 'text' as const),
          'text',
          ...STAT_FIELDS.map(() => 'number' as const),
        ]
        const rows = summary.rows.map((row) => [
          ...row.labels,
          row.column,
          ...STAT_FIELDS.map((f) => row[f.key]),
        ])
        return { headers, rows, types }
      }

      if (!pivot) return { headers: [], rows: [], types: [] }
      const measureLabel = (m: Measure) => {
        const label = MEASURE_OPERATIONS.find((op) => op.value === m.op)?.label ?? m.op
        return `${label} of ${m.column}`
      }
      const headers = pivotCols.length > 0
        ? [
            ...pivotRows,
            ...pivot.colLines.flatMap((line) =>
              pivot.measures.map((m) => `${formatAxisLabel(line)} · ${measureLabel(m)}`),
            ),
            ...pivot.measures.map((m) => `Total · ${measureLabel(m)}`),
          ]
        : [...pivotRows, ...pivot.measures.map(measureLabel)]
      const types: ('text' | 'number')[] = headers.map((_, index) =>
        index < pivotRows.length ? 'text' : 'number',
      )
      const rows: unknown[][] = []
      for (let r = 0; r < pivot.rowLines.length; r += 1) {
        const line = pivot.rowLines[r]
        if (pivotCols.length === 0) {
          rows.push([
            ...line.values,
            ...pivot.measures.map((_, m) => pivot.rowTotalAt(r, m)),
          ])
          continue
        }
        rows.push([
          ...line.values,
          ...pivot.colLines.flatMap((_, c) => pivot.measures.map((__, m) => pivot.cellAt(r, c, m))),
          ...pivot.measures.map((_, m) => pivot.rowTotalAt(r, m)),
        ])
      }
      rows.push([
        ...pivotRows.map(() => 'Total'),
        ...pivot.colLines.flatMap((_, c) => pivot.measures.map((__, m) => pivot.colTotalAt(c, m))),
        ...pivot.measures.map((_, m) => pivot.grandAt(m)),
      ])
      return { headers, rows, types }
    },
    [layout, groupBy, summary, pivot, pivotRows, pivotCols],
  )

  const handleCopy = useCallback(async () => {
    if (matrix.rows.length === 0) return
    const lines = [
      matrix.headers.join('\t'),
      ...matrix.rows.map((row) => row.map((cell) => formatLabel(cell)).join('\t')),
    ]
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for restricted contexts (e.g. some Electron builds).
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [matrix])

  const handleDownload = async () => {
    if (matrix.rows.length === 0) return
    setExporting(true)
    setExportError(null)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const columns = matrix.headers.map((name, index) => ({ name, type: matrix.types[index] }))
      const rows = matrix.rows.map((row) => {
        const record: Record<string, unknown> = {}
        matrix.headers.forEach((name, index) => {
          record[name] = row[index] ?? null
        })
        return record
      })
      const blob = await api.exportGrid(rows, columns, 'xlsx')
      await downloadBlob(blob, `summary_${stamp}.xlsx`)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  if (!result) {
    return (
      <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
        <Typography color="text.secondary">Run a query to summarize results here.</Typography>
      </Box>
    )
  }

  const empty = result.rows.length === 0
  const noStats = layout === 'table' && !empty && statColumns.length === 0
  const noPivot = layout === 'pivot' && !empty && !pivot

  /** Right-aligned numeric cell with an optional in-cell data bar. */
  const renderValue = (value: number, scaleMax: number) => (
    <Box sx={{ position: 'relative', minWidth: 64, textAlign: 'right' }}>
      {showBars && scaleMax > 0 && Number.isFinite(value) && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: '4px 0',
            right: 0,
            left: 'auto',
            width: `${Math.min(100, (Math.abs(value) / scaleMax) * 100)}%`,
            bgcolor: value < 0 ? 'secondary.main' : 'primary.main',
            opacity: 0.14,
            borderRadius: 0.5,
          }}
        />
      )}
      <Box sx={{ position: 'relative' }}>{formatStat(value)}</Box>
    </Box>
  )

  /** Grain selector shown under a date column's chip on the Rows/Columns shelf. */
  const grainPicker = (name: string) =>
    columnKinds[name] === 'date' ? (
      <Select
        key={`${name}-grain`}
        size="small"
        value={grainOf(name)}
        onChange={(event) =>
          setGrains((prev) => ({ ...prev, [name]: event.target.value as DateGrain }))
        }
        sx={{ minWidth: 110 }}
        inputProps={{ 'aria-label': `Group ${name} by` }}
      >
        {DATE_GRAIN_OPTIONS.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    ) : null

  const drill = (filters: GridDrillFilter[]) => {
    if (!onDrillThrough) return
    onDrillThrough(filters)
  }

  /**
   * Merge the row- and column-axis conditions of a clicked pivot cell, dropping
   * exact duplicates. A field used on both axes yields the same condition twice
   * on the diagonal (and two contradictory ones off it, which correctly matches
   * nothing since the conditions are combined with AND).
   */
  const mergeFilters = (first: GridDrillFilter[], second: GridDrillFilter[]) => {
    const merged = [...first]
    for (const filter of second) {
      const duplicate = merged.some(
        (existing) =>
          existing.column === filter.column &&
          existing.grain === filter.grain &&
          existing.values.join('\u0001') === filter.values.join('\u0001'),
      )
      if (!duplicate) merged.push(filter)
    }
    return merged
  }

  /**
   * Value cells of one pivot body row: one per column line × measure, or just
   * the per-measure row total when no Columns shelf is in use (so the numbers
   * are aggregated over a whole row line rather than summed from the cells).
   */
  const renderBodyCells = (rowIndex: number) => {
    if (!pivot) return null
    const cellSx = { cursor: onDrillThrough ? 'pointer' : 'default' }
    if (pivotCols.length === 0) {
      return pivot.measures.map((measure, measureIndex) => (
        <TableCell
          key={measure.column}
          align="right"
          onClick={() => drill(pivot.rowFilter(rowIndex))}
          sx={cellSx}
        >
          {renderValue(pivot.rowTotalAt(rowIndex, measureIndex), pivot.scale[measureIndex])}
        </TableCell>
      ))
    }
    return pivot.colLines.flatMap((line, colIndex) =>
      pivot.measures.map((measure, measureIndex) => (
        <TableCell
          key={`${line.key}-${measure.column}`}
          align="right"
          onClick={() => drill(mergeFilters(pivot.rowFilter(rowIndex), pivot.colFilter(colIndex)))}
          sx={cellSx}
        >
          {renderValue(pivot.cellAt(rowIndex, colIndex, measureIndex), pivot.scale[measureIndex])}
        </TableCell>
      )),
    )
  }

  return (
    <Stack spacing={1.5} sx={{ width: '100%' }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        useFlexGap
        sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
      >
        <Typography variant="body2" color="text.secondary">
          Summarizing {result.rows.length.toLocaleString()} row
          {result.rows.length === 1 ? '' : 's'}
          {onDrillThrough ? ' · click a group to filter the grid' : ''}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center' }}>
          {/* Below md the palette stacks above the shelves, so the collapse
              toggle has to live here (the side rail is desktop-only). */}
          <Button
            size="small"
            variant="outlined"
            startIcon={fieldsOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
            onClick={() => setFieldsOpen((prev) => !prev)}
            sx={{ display: { xs: 'inline-flex', md: 'none' }, minHeight: 40 }}
          >
            {fieldsOpen ? 'Hide fields' : 'Fields'}
          </Button>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={layout}
            onChange={(_, next: 'table' | 'pivot' | null) => {
              if (next) {
                setLayout(next)
                onDrillThrough?.([])
              }
            }}
            aria-label="Summary layout"
          >
            <ToggleButton value="table" sx={{ minHeight: 40, px: 1.5 }}>
              <TableRowsIcon fontSize="small" sx={{ mr: 0.5 }} />
              Table
            </ToggleButton>
            <ToggleButton value="pivot" sx={{ minHeight: 40, px: 1.5 }}>
              <InsightsIcon fontSize="small" sx={{ mr: 0.5 }} />
              Pivot
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'minmax(0, 1fr)',
            md: fieldsOpen ? '230px minmax(0, 1fr)' : '44px minmax(0, 1fr)',
          },
          gap: 1.5,
          alignItems: 'start',
          width: '100%',
        }}
      >
        {/* Field list — draggable chips; also the touch-friendly fallback source. */}
        {fieldsOpen ? (
        <Paper
          variant="outlined"
          sx={{ p: 1.5, maxHeight: { xs: 220, md: '60vh' }, overflowY: 'auto' }}
        >
          <Stack spacing={1.25}>
            <Stack direction="row" sx={{ alignItems: 'center' }}>
              <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                Fields
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {allNames.length}
              </Typography>
              <IconButton
                size="small"
                onClick={() => setFieldsOpen(false)}
                aria-label="Collapse fields"
                sx={{ display: { xs: 'none', md: 'inline-flex' }, minHeight: 36, minWidth: 36 }}
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </Stack>

            {KIND_ORDER.filter((kind) =>
              allNames.some((name) => columnKinds[name] === kind),
            ).map((kind) => (
              <Box key={kind}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {COLUMN_KIND_LABELS[kind]}
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {allNames
                    .filter((name) => columnKinds[name] === kind)
                    .map((name) => (
                      <Box
                        key={name}
                        draggable
                        onDragStart={(event: ReactDragEvent<HTMLDivElement>) => {
                          event.dataTransfer.setData('text/plain', name)
                          event.dataTransfer.effectAllowed = 'copy'
                        }}
                        sx={{ cursor: 'grab', '&:active': { cursor: 'grabbing' } }}
                      >
                        <Chip
                          size="small"
                          variant="outlined"
                          color={kind === 'number' ? 'primary' : 'default'}
                          label={name}
                          // The wrapper owns the drag gesture so the chip's own
                          // interactive styles don't swallow the mousedown.
                          sx={{
                            pointerEvents: 'none',
                            maxWidth: 190,
                            '& .MuiChip-label': {
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          }}
                        />
                      </Box>
                    ))}
                </Box>
              </Box>
            ))}

            <Typography variant="caption" color="text.disabled">
              On a touch screen, tap + on a shelf to pick a field.
            </Typography>
          </Stack>
        </Paper>
        ) : (
          // Desktop-only collapsed rail: keeps the expand toggle reachable.
          <Paper
            variant="outlined"
            sx={{
              display: { xs: 'none', md: 'flex' },
              flexDirection: 'column',
              alignItems: 'center',
              py: 1,
              gap: 1,
            }}
          >
            <IconButton
              onClick={() => setFieldsOpen(true)}
              aria-label="Expand fields"
              sx={{ minHeight: 44, minWidth: 36 }}
            >
              <ChevronRightIcon fontSize="small" />
            </IconButton>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ writingMode: 'vertical-rl', letterSpacing: 1 }}
            >
              Fields
            </Typography>
          </Paper>
        )}

        <Stack spacing={1.25} sx={{ minWidth: 0 }}>
          {layout === 'table' ? (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                gap: 1,
              }}
            >
              <FieldWell
                label="Group by"
                value={groupBy}
                multi
                options={allNames.map((name) => ({ name, kind: columnKinds[name] }))}
                onChoose={handleGroupToggle}
                onAdd={handleGroupAdd}
                onRemove={handleGroupRemove}
                hint="Drop columns to group by"
              />
              <FieldWell
                label="Statistics (numeric)"
                value={statColumns}
                multi
                options={numericNames.map((name) => ({ name, kind: columnKinds[name] }))}
                onChoose={handleStatToggle}
                onAdd={handleStatAdd}
                onRemove={handleStatRemove}
                hint="Drop numeric columns to summarize"
              />
            </Box>
          ) : (
            <Stack spacing={1}>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                  gap: 1,
                }}
              >
                <FieldWell
                  label="Rows"
                  value={pivotRows}
                  multi
                  options={allNames.map((name) => ({ name, kind: columnKinds[name] }))}
                  onChoose={handleRowToggle}
                  onAdd={handleRowAdd}
                  onRemove={handleRowRemove}
                  hint="Drop columns for the table rows"
                />
                <FieldWell
                  label="Columns"
                  value={pivotCols}
                  multi
                  options={allNames.map((name) => ({ name, kind: columnKinds[name] }))}
                  onChoose={handleColToggle}
                  onAdd={handleColAdd}
                  onRemove={handleColRemove}
                  hint="Drop columns to spread across"
                />
              </Box>

              <FieldWell
                label="Values"
                value={measures.map((m) => m.column)}
                multi
                options={allNames.map((name) => ({ name, kind: columnKinds[name] }))}
                onChoose={(name) =>
                  measures.some((m) => m.column === name)
                    ? handleMeasureRemove(name)
                    : handleMeasureAdd(name)
                }
                onAdd={handleMeasureAdd}
                onRemove={handleMeasureRemove}
                hint="Drop columns to aggregate"
              />

              {measures.length > 0 && (
                <Stack spacing={0.75}>
                  {measures.map((measure) => (
                    <Stack
                      key={measure.column}
                      direction="row"
                      spacing={1}
                      useFlexGap
                      sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                    >
                      <Chip
                        size="small"
                        label={measure.column}
                        onDelete={() => handleMeasureRemove(measure.column)}
                        deleteIcon={<CloseIcon />}
                        sx={{ maxWidth: 220 }}
                      />
                      <Select
                        size="small"
                        value={measure.op}
                        onChange={(event) =>
                          handleMeasureOp(measure.column, event.target.value as ChartOperation)
                        }
                        sx={{ minWidth: 150 }}
                        inputProps={{ 'aria-label': `Aggregation for ${measure.column}` }}
                      >
                        {operationsFor(measure.column).map((op) => (
                          <MenuItem key={op.value} value={op.value}>
                            {op.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </Stack>
                  ))}
                </Stack>
              )}
            </Stack>
          )}

          {/* Date grain pickers for any date column used as an axis. */}
          {(layout === 'table' ? groupBy : [...pivotRows, ...pivotCols])
            .filter((name, index, list) => list.indexOf(name) === index && columnKinds[name] === 'date')
            .map((name) => (
              <Stack
                key={`grain-${name}`}
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Typography variant="caption" color="text.secondary">
                  Group {name} by
                </Typography>
                {grainPicker(name)}
              </Stack>
            ))}

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            useFlexGap
            sx={{
              alignItems: { xs: 'stretch', sm: 'center' },
              justifyContent: 'space-between',
            }}
          >
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showBars}
                  onChange={(event) => setShowBars(event.target.checked)}
                />
              }
              label={<Typography variant="body2">Data bars</Typography>}
            />
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ContentCopyIcon />}
                onClick={() => void handleCopy()}
                disabled={matrix.rows.length === 0}
                sx={{ minHeight: 48 }}
              >
                {copied ? 'Copied!' : 'Copy'}
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={exporting ? <CircularProgress size={16} /> : <FileDownloadIcon />}
                onClick={() => void handleDownload()}
                disabled={matrix.rows.length === 0 || exporting}
                sx={{ minHeight: 48 }}
              >
                Download Excel
              </Button>
            </Stack>
          </Stack>

          {exportError && (
            <Alert severity="error" onClose={() => setExportError(null)}>
              {exportError}
            </Alert>
          )}

          {layout === 'table' && summary.truncated && (
            <Alert severity="warning">
              Showing the first {MAX_GROUPS.toLocaleString()} groups only. Narrow the result (or add
              a filter) to summarize the remaining groups.
            </Alert>
          )}

          {layout === 'pivot' && pivot?.truncated && (
            <Alert severity="warning">
              Showing the first {MAX_PIVOT_ROWS.toLocaleString()} rows ×{' '}
              {MAX_PIVOT_COLS.toLocaleString()} columns. Add a filter to see every combination.
            </Alert>
          )}

          {empty ? (
            <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
              <Typography color="text.secondary">The query returned no rows.</Typography>
            </Box>
          ) : noStats ? (
            <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
              <Typography color="text.secondary">
                Drag a numeric column onto the Statistics shelf to see its summary.
              </Typography>
            </Box>
          ) : noPivot ? (
            <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
              <Typography color="text.secondary">
                Drop a column onto Rows (or Columns), and another onto Values, to build a pivot
                table.
              </Typography>
            </Box>
          ) : layout === 'table' ? (
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 520 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {groupBy.map((name) => (
                      <TableCell key={name} sx={{ fontWeight: 600 }}>
                        {name}
                      </TableCell>
                    ))}
                    <TableCell sx={{ fontWeight: 600 }}>{COLUMN_HEADER}</TableCell>
                    {STAT_FIELDS.map((field) => (
                      <TableCell key={field.key} align="right" sx={{ fontWeight: 600 }}>
                        {field.label}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.rows.map((row, index) => (
                    <TableRow
                      key={`${row.column}-${index}`}
                      hover
                      onClick={() =>
                        drill(
                          groupBy.map((name, labelIndex) => ({
                            column: name,
                            values: [String(row.labels[labelIndex] ?? '')],
                            grain: grainOf(name),
                          })),
                        )
                      }
                      sx={{ cursor: onDrillThrough ? 'pointer' : 'default' }}
                    >
                      {row.labels.map((value, labelIndex) => (
                        <TableCell key={labelIndex}>{displayKey(String(value ?? ''))}</TableCell>
                      ))}
                      <TableCell sx={{ fontWeight: 500 }}>{row.column}</TableCell>
                      {STAT_FIELDS.map((field) => (
                        <TableCell key={field.key} align="right">
                          {formatStat(row[field.key])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            pivot && (
              <>
              <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 560 }}>
                <Table size="small" stickyHeader sx={{ minWidth: 420 }}>
                  <TableHead>
                    {pivotCols.length > 0 ? (
                      <>
                        {/* Axis header row: one item filter per axis. */}
                        <TableRow>
                          <TableCell
                            sx={{ fontWeight: 600, position: 'sticky', left: 0, bgcolor: 'background.paper' }}
                          >
                            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                              <Box sx={{ flexGrow: 1 }}>
                                {pivotRows.length > 0 ? pivotRows.join(' / ') : 'All rows'}
                              </Box>
                              <IconButton
                                size="small"
                                aria-label="Filter rows"
                                onClick={(event) => setRowFilterAnchor(event.currentTarget)}
                                color={rowSelection === null ? 'default' : 'primary'}
                                sx={{ minHeight: 36, minWidth: 36 }}
                              >
                                <FilterAltIcon fontSize="small" />
                              </IconButton>
                            </Stack>
                          </TableCell>
                          <TableCell
                            align="center"
                            colSpan={pivot.colLines.length * pivot.measures.length + pivot.measures.length}
                            sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}
                          >
                            <Stack
                              direction="row"
                              spacing={0.5}
                              sx={{ alignItems: 'center', justifyContent: 'center' }}
                            >
                              <Box>{pivotCols.join(' / ')}</Box>
                              <IconButton
                                size="small"
                                aria-label="Filter columns"
                                onClick={(event) => setColFilterAnchor(event.currentTarget)}
                                color={colSelection === null ? 'default' : 'primary'}
                                sx={{ minHeight: 36, minWidth: 36 }}
                              >
                                <FilterAltIcon fontSize="small" />
                              </IconButton>
                            </Stack>
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell
                            sx={{ position: 'sticky', left: 0, bgcolor: 'background.paper' }}
                          />
                          {pivot.colLines.map((line, colIndex) => (
                            <TableCell
                              key={line.key}
                              colSpan={pivot.measures.length}
                              align="center"
                              onClick={() => drill(pivot.colFilter(colIndex))}
                              sx={{
                                fontWeight: 600,
                                cursor: onDrillThrough ? 'pointer' : 'default',
                              }}
                            >
                              <AxisLabel line={line} />
                            </TableCell>
                          ))}
                          <TableCell
                            align="center"
                            colSpan={pivot.measures.length}
                            sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}
                          >
                            Total
                          </TableCell>
                        </TableRow>
                        {pivot.measures.length > 1 && (
                          <TableRow>
                            <TableCell
                              sx={{ position: 'sticky', left: 0, bgcolor: 'background.paper' }}
                            />
                            {pivot.colLines.flatMap((line) =>
                              pivot.measures.map((measure) => (
                                <TableCell
                                  key={`${line.key}-${measure.column}`}
                                  align="right"
                                  variant="head"
                                  sx={{ fontWeight: 500, whiteSpace: 'nowrap' }}
                                >
                                  {measure.op}
                                </TableCell>
                              )),
                            )}
                            {pivot.measures.map((measure) => (
                              <TableCell
                                key={`total-${measure.column}`}
                                align="right"
                                variant="head"
                                sx={{ fontWeight: 500 }}
                              >
                                {measure.op}
                              </TableCell>
                            ))}
                          </TableRow>
                        )}
                      </>
                    ) : (
                      <TableRow>
                        <TableCell
                          sx={{ fontWeight: 600, position: 'sticky', left: 0, bgcolor: 'background.paper' }}
                        >
                          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                            <Box sx={{ flexGrow: 1 }}>
                              {pivotRows.length > 0 ? pivotRows.join(' / ') : 'All rows'}
                            </Box>
                            <IconButton
                              size="small"
                              aria-label="Filter rows"
                              onClick={(event) => setRowFilterAnchor(event.currentTarget)}
                              color={rowSelection === null ? 'default' : 'primary'}
                              sx={{ minHeight: 36, minWidth: 36 }}
                            >
                              <FilterAltIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        </TableCell>
                        {pivot.measures.map((measure) => (
                          <TableCell key={measure.column} align="right" sx={{ fontWeight: 600 }}>
                            <Box>{measure.column}</Box>
                            <Typography variant="caption" color="text.secondary">
                              {measure.op}
                            </Typography>
                          </TableCell>
                        ))}
                      </TableRow>
                    )}
                  </TableHead>
                  <TableBody>
                    {pivot.rowLines.map((line, rowIndex) => (
                      <TableRow key={line.key} hover>
                        <TableCell
                          onClick={() => drill(pivot.rowFilter(rowIndex))}
                          sx={{
                            fontWeight: 500,
                            position: 'sticky',
                            left: 0,
                            bgcolor: 'background.paper',
                            cursor: onDrillThrough ? 'pointer' : 'default',
                          }}
                        >
                          <AxisLabel line={line} />
                        </TableCell>
                        {renderBodyCells(rowIndex)}
                        {pivotCols.length > 0 &&
                          pivot.measures.map((measure, measureIndex) => (
                            <TableCell
                              key={`row-total-${measure.column}`}
                              align="right"
                              sx={{ fontWeight: 600, bgcolor: 'action.hover' }}
                              onClick={() => drill(pivot.rowFilter(rowIndex))}
                            >
                              {renderValue(
                                pivot.rowTotalAt(rowIndex, measureIndex),
                                pivot.scale[measureIndex],
                              )}
                            </TableCell>
                          ))}
                      </TableRow>
                    ))}
                  </TableBody>
                  {pivotCols.length > 0 && (
                    <TableFooter>
                      <TableRow>
                        <TableCell
                          sx={{
                            fontWeight: 700,
                            position: 'sticky',
                            left: 0,
                            bgcolor: 'background.paper',
                          }}
                        >
                          Total
                        </TableCell>
                        {pivot.colLines.flatMap((line, colIndex) =>
                          pivot.measures.map((measure, measureIndex) => (
                            <TableCell
                              key={`${line.key}-${measure.column}`}
                              align="right"
                              sx={{ bgcolor: 'action.selected' }}
                              onClick={() => drill(pivot.colFilter(colIndex))}
                            >
                              {renderValue(
                                pivot.colTotalAt(colIndex, measureIndex),
                                pivot.scale[measureIndex],
                              )}
                            </TableCell>
                          )),
                        )}
                        {pivot.measures.map((measure, measureIndex) => (
                          <TableCell
                            key={`grand-${measure.column}`}
                            align="right"
                            sx={{ fontWeight: 700, bgcolor: 'action.selected' }}
                          >
                            {renderValue(pivot.grandAt(measureIndex), pivot.scale[measureIndex])}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </TableContainer>
              <AxisFilterMenu
                title={`Row labels (${pivotRows.join(' / ') || 'All rows'})`}
                anchorEl={rowFilterAnchor}
                items={axisItems.rows}
                selection={rowSelection}
                onChange={setRowSelection}
                onClose={() => setRowFilterAnchor(null)}
              />
              <AxisFilterMenu
                title={`Column labels (${pivotCols.join(' / ')})`}
                anchorEl={colFilterAnchor}
                items={axisItems.cols}
                selection={colSelection}
                onChange={setColSelection}
                onClose={() => setColFilterAnchor(null)}
              />
              </>
            )
          )}
        </Stack>
      </Box>
    </Stack>
  )
}
