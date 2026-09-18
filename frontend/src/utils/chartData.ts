import type { ChartDataResponse, ChartOperation } from '../api/client'
import type { ChartType } from '../types'
import { SINGLE_SERIES_TYPES } from './chartCatalog'
import type { ColumnKind } from './columns'

/**
 * Client-side chart aggregation. The Charts panel always has the full grid
 * result in memory, so every aggregation runs synchronously in the browser —
 * no network round-trip, no request races, and re-renders are instant when
 * the user tweaks chart options.
 */

type Row = Record<string, unknown>

/** Display-level options that only affect how a chart is drawn. */
export interface ChartDisplayOptions {
  /** Bar rendering when a series breakdown is active. */
  barMode?: 'grouped' | 'stacked' | 'percent'
  /** Draw category bars horizontally. */
  horizontal?: boolean
  /** Fill the area under trend lines. */
  area?: boolean
  /** Whether a series breakdown column is active (enables stacking). */
  hasSeries?: boolean
}

/** Label ordering for bar / pie categories. */
export type ChartSort = 'none' | 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc'

export interface ChartBuildConfig {
  chartType: ChartType
  x: string
  y: string[]
  operation: ChartOperation
  /** Breakdown (color-by) column; uses the first Y column when active. */
  series?: string
  /** Max categories for bar / pie; the rest are dropped (0 = keep all). */
  topN?: number
  /** Histogram bin count. */
  bins?: number
  sort?: ChartSort
  /** Secondary-axis columns (combo charts): drawn as lines on the right axis. */
  y2?: string[]
  /** Aggregation applied to the secondary (right) axis of combo charts. */
  y2Operation?: ChartOperation
}

export const DEFAULT_BINS = 10
export const MAX_BINS = 50
/** Cap scatter points per series; beyond it, points are stride-sampled. */
const MAX_SCATTER_POINTS = 5000

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** Coerce a cell value to a finite number, or null when not numeric. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '')
    if (cleaned === '') return null
    const parsed = Number(cleaned)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Stringify an X / series cell for grouping, keeping blanks visible. */
function labelValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(blank)'
  return String(value)
}

/** Compact, human-friendly number formatting (axis labels, KPI cards, bins). */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 10000 ? 1 : 2,
  }).format(value)
}

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = sorted.length - 1 - base
  return rest === 0 ? sorted[base] : sorted[base] + (sorted[base + 1] - sorted[base]) * rest
}

/** Numeric aggregation over non-empty values (population std/var, like pandas). */
function aggregateNumbers(values: number[], op: ChartOperation): number {
  let total = 0
  for (const v of values) total += v
  switch (op) {
    case 'sum':
    case 'share':
      return total
    case 'min': {
      let m = values[0]
      for (const v of values) if (v < m) m = v
      return m
    }
    case 'max': {
      let m = values[0]
      for (const v of values) if (v > m) m = v
      return m
    }
    case 'median':
    case 'p25':
    case 'p75':
    case 'p90': {
      const sorted = [...values].sort((a, b) => a - b)
      const q = op === 'median' ? 0.5 : op === 'p25' ? 0.25 : op === 'p75' ? 0.75 : 0.9
      return quantileSorted(sorted, q)
    }
    case 'std':
    case 'var': {
      const mean = total / values.length
      let sq = 0
      for (const v of values) sq += (v - mean) * (v - mean)
      const variance = sq / values.length
      return op === 'var' ? variance : Math.sqrt(variance)
    }
    // 'mean' and raw 'none' (duplicate X values are averaged, like the backend).
    default:
      return total / values.length
  }
}

/** Aggregate one column over a bucket of rows for any operation. Also used by
 *  the Summary tab's pivot cells, so charts and pivots never disagree. */
export function aggregateGroup(subset: Row[], column: string, op: ChartOperation): number {
  switch (op) {
    case 'count':
      return subset.length
    case 'distinct': {
      const seen = new Set<unknown>()
      for (const row of subset) {
        const v = row[column]
        if (v !== null && v !== undefined && v !== '') seen.add(v)
      }
      return seen.size
    }
    case 'first':
      return toNumber(subset[0]?.[column]) ?? 0
    case 'last':
      return toNumber(subset[subset.length - 1]?.[column]) ?? 0
    default: {
      const values: number[] = []
      for (const row of subset) {
        const n = toNumber(row[column])
        if (n !== null) values.push(n)
      }
      if (values.length === 0) return 0
      return aggregateNumbers(values, op)
    }
  }
}

// ---------------------------------------------------------------------------
// Grouping core
// ---------------------------------------------------------------------------

/**
 * Bucket rows by X label (and optionally by series value) preserving
 * first-appearance order. Cells hold row references, so aggregations never
 * copy more data than needed.
 */
interface Buckets {
  labels: string[]
  seriesNames: string[]
  /** cells[seriesIndex][labelIndex] = rows in that cell. */
  cells: Row[][][]
}

function buildBuckets(rows: Row[], x: string, series: string): Buckets {
  const labels: string[] = []
  const labelIdx = new Map<string, number>()
  const seriesNames: string[] = []
  const seriesIdx = new Map<string, number>()
  const cells: Row[][][] = [[]]

  for (const row of rows) {
    const lKey = labelValue(row[x])
    let li = labelIdx.get(lKey)
    if (li === undefined) {
      li = labels.length
      labelIdx.set(lKey, li)
      labels.push(lKey)
    }
    let si = 0
    if (series) {
      const sKey = labelValue(row[series])
      si = seriesIdx.get(sKey) ?? -1
      if (si === -1) {
        si = seriesNames.length
        seriesIdx.set(sKey, si)
        seriesNames.push(sKey)
        cells.push([])
      }
    }
    const bucket = cells[si][li] ?? (cells[si][li] = [])
    bucket.push(row)
  }
  return { labels, seriesNames, cells }
}

/** Aggregate every (series × label) bucket into named data series. */
function matrixFromBuckets(
  buckets: Buckets,
  yCols: string[],
  op: ChartOperation,
): { name: string; data: (number | null)[] }[] {
  const labelCount = buckets.labels.length
  const emptyValue = op === 'none' ? null : 0
  const cellAggregate = (si: number, li: number, col: string): number | null => {
    const rowsIn = buckets.cells[si]?.[li]
    if (!rowsIn || rowsIn.length === 0) return emptyValue
    return aggregateGroup(rowsIn, col, op)
  }

  // With a breakdown column, each series value becomes a chart series that
  // aggregates the first Y column.
  if (buckets.seriesNames.length > 0 && yCols.length > 0) {
    const col = yCols[0]
    return buckets.seriesNames.map((name, si) => ({
      name,
      data: Array.from({ length: labelCount }, (_, li) => cellAggregate(si, li, col)),
    }))
  }
  // Otherwise one series per selected Y column.
  return yCols.map((col) => ({
    name: col,
    data: Array.from({ length: labelCount }, (_, li) => cellAggregate(0, li, col)),
  }))
}

/** Reorder labels + aligned series data by value or label. */
function applyLabelSort(
  labels: string[],
  matrix: { name: string; data: (number | null)[] }[],
  sort: ChartSort,
): { labels: string[]; matrix: typeof matrix } {
  if (sort === 'none') return { labels, matrix }
  const first = matrix[0]?.data ?? []
  const order = labels.map((_, i) => i)
  order.sort((a, b) => {
    switch (sort) {
      case 'value_asc':
        return (Number(first[a]) || 0) - (Number(first[b]) || 0)
      case 'value_desc':
        return (Number(first[b]) || 0) - (Number(first[a]) || 0)
      case 'label_asc':
        return labels[a].localeCompare(labels[b], undefined, { numeric: true })
      case 'label_desc':
        return labels[b].localeCompare(labels[a], undefined, { numeric: true })
      default:
        return 0
    }
  })
  return {
    labels: order.map((i) => labels[i]),
    matrix: matrix.map((s) => ({ name: s.name, data: order.map((i) => s.data[i]) })),
  }
}

// ---------------------------------------------------------------------------
// Per-chart-type aggregation
// ---------------------------------------------------------------------------

/**
 * Keep the top-N largest categories when a limit is set (the remaining
 * categories are dropped, not folded into an "Other" bucket), then sort the
 * resolved labels + series. Shared by every category-based chart.
 */
function finalizeCategory(
  labels: string[],
  matrix: { name: string; data: (number | null)[] }[],
  sort: ChartSort,
  topN: number,
): { labels: string[]; matrix: { name: string; data: (number | null)[] }[] } {
  if (topN > 0 && labels.length > topN) {
    const first = matrix[0].data
    const order = labels
      .map((_, i) => i)
      .sort((a, b) => (Number(first[b]) || 0) - (Number(first[a]) || 0))
    const kept = order.slice(0, topN)
    labels = kept.map((i) => labels[i])
    matrix = matrix.map((s) => ({ name: s.name, data: kept.map((i) => s.data[i]) }))
  }
  const sorted = applyLabelSort(labels, matrix, sort)
  return { labels: sorted.labels, matrix: sorted.matrix }
}

/** Trend / bar / pie-like: group by X (+ optional breakdown), aggregate, sort, top-N. */
function categoryData(rows: Row[], cfg: ChartBuildConfig): ChartDataResponse | null {
  const { chartType, x, y, operation, series, sort = 'none', topN = 0 } = cfg
  // Pie / funnel / treemap are single-series by definition; a breakdown column
  // claims the first Y.
  const singleSeries = SINGLE_SERIES_TYPES.includes(chartType)
  const yCols = (singleSeries ? y.slice(0, 1) : series ? y.slice(0, 1) : y).filter(Boolean)
  if (!x || yCols.length === 0) return null

  const buckets = buildBuckets(rows, x, series ?? '')
  const matrix = matrixFromBuckets(buckets, yCols, operation)
  const finalized = finalizeCategory(buckets.labels, matrix, sort, topN)
  return { labels: finalized.labels, series: finalized.matrix }
}

/** Combo: primary Y columns as bars on the left axis, secondary (y2) as lines on the right. */
function comboData(rows: Row[], cfg: ChartBuildConfig): ChartDataResponse | null {
  const { x, y, y2, operation, y2Operation = operation, sort = 'none', topN = 0 } = cfg
  const yCols = (y ?? []).filter(Boolean)
  const y2Cols = (y2 ?? []).filter(Boolean)
  if (!x || (yCols.length === 0 && y2Cols.length === 0)) return null

  const buckets = buildBuckets(rows, x, '')
  // Bars aggregate with the primary operation; lines with their own operation.
  const matrix = [
    ...matrixFromBuckets(buckets, yCols, operation),
    ...matrixFromBuckets(buckets, y2Cols, y2Operation),
  ]
  const finalized = finalizeCategory(buckets.labels, matrix, sort, topN)
  const secondarySet = new Set(y2Cols)
  return {
    labels: finalized.labels,
    series: finalized.matrix,
    extra: {
      secondary_series: finalized.matrix
        .filter((s) => secondarySet.has(s.name))
        .map((s) => s.name),
    },
  }
}

/** Pareto: single Y sorted descending with a cumulative-% line. */
function paretoData(rows: Row[], x: string, yCol: string, op: ChartOperation): ChartDataResponse | null {
  if (!x || !yCol) return null
  const buckets = buildBuckets(rows, x, '')
  const aggregated = matrixFromBuckets(buckets, [yCol], op)[0]
  const order = buckets.labels
    .map((_, i) => i)
    .sort((a, b) => (Number(aggregated.data[b]) || 0) - (Number(aggregated.data[a]) || 0))
  const data = order.map((i) => Number(aggregated.data[i]) || 0)
  const total = data.reduce((a, v) => a + v, 0)
  let running = 0
  const cumulative = data.map((v) => {
    running += v
    return total === 0 ? 0 : (running / total) * 100
  })
  return {
    labels: order.map((i) => buckets.labels[i]),
    series: [{ name: aggregated.name, data }],
    extra: { cumulative_pct: cumulative },
  }
}

/** Histogram: shared bins across all selected Y columns, configurable count. */
function histogramData(rows: Row[], yCols: string[], binsRaw?: number): ChartDataResponse | null {
  if (yCols.length === 0) return null
  const bins = Math.min(MAX_BINS, Math.max(1, Math.round(binsRaw ?? DEFAULT_BINS)))
  const perColumn: number[][] = yCols.map(() => [])
  for (const row of rows) {
    yCols.forEach((col, i) => {
      const n = toNumber(row[col])
      if (n !== null) perColumn[i].push(n)
    })
  }
  const all = perColumn.flat()
  if (all.length === 0) return null

  let min = all[0]
  let max = all[0]
  for (const v of all) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (bins === 1 || min === max) {
    return {
      labels: [formatCompactNumber(min)],
      series: perColumn.map((values, i) => ({ name: yCols[i], data: [values.length] })),
    }
  }
  const width = (max - min) / bins
  const counts = perColumn.map(() => new Array<number>(bins).fill(0))
  perColumn.forEach((values, i) => {
    for (const v of values) {
      let b = Math.floor((v - min) / width)
      if (b >= bins) b = bins - 1
      if (b < 0) b = 0
      counts[i][b] += 1
    }
  })
  return {
    labels: Array.from({ length: bins }, (_, i) =>
      `${formatCompactNumber(min + i * width)} – ${formatCompactNumber(min + (i + 1) * width)}`,
    ),
    series: perColumn.map((_, i) => ({ name: yCols[i], data: counts[i] })),
  }
}

/** Box plot: min / q1 / median / q3 / max per X group for each Y column. */
function boxData(rows: Row[], x: string, yCols: string[]): ChartDataResponse | null {
  if (!x || yCols.length === 0) return null
  const buckets = buildBuckets(rows, x, '')
  return {
    labels: buckets.labels,
    series: yCols.map((col) => ({
      name: col,
      data: buckets.labels.map((_, li) => {
        const rowsIn = buckets.cells[0]?.[li] ?? []
        const values = rowsIn
          .map((r) => toNumber(r[col]))
          .filter((n): n is number => n !== null)
          .sort((a, b) => a - b)
        if (values.length === 0) return [0, 0, 0, 0, 0]
        return [
          values[0],
          quantileSorted(values, 0.25),
          quantileSorted(values, 0.5),
          quantileSorted(values, 0.75),
          values[values.length - 1],
        ]
      }),
    })),
  }
}

/** Scatter: [x, y] pairs; grouped by the breakdown column when active. */
function scatterData(rows: Row[], x: string, yCols: string[], series?: string): ChartDataResponse | null {
  if (!x || yCols.length === 0) return null

  const strideSample = (points: number[][]): number[][] => {
    if (points.length <= MAX_SCATTER_POINTS) return points
    const step = Math.ceil(points.length / MAX_SCATTER_POINTS)
    return points.filter((_, i) => i % step === 0)
  }

  if (series) {
    const col = yCols[0]
    const groups = new Map<string, number[][]>()
    for (const row of rows) {
      const xv = toNumber(row[x])
      const yv = toNumber(row[col])
      if (xv === null || yv === null) continue
      const key = labelValue(row[series])
      const points = groups.get(key) ?? (groups.set(key, []), groups.get(key)!)
      points.push([xv, yv])
    }
    return {
      labels: [],
      series: [...groups.entries()].map(([name, points]) => ({ name, data: strideSample(points) })),
    }
  }
  return {
    labels: [],
    series: yCols.map((col) => {
      const points: number[][] = []
      for (const row of rows) {
        const xv = toNumber(row[x])
        const yv = toNumber(row[col])
        if (xv !== null && yv !== null) points.push([xv, yv])
      }
      return { name: col, data: strideSample(points) }
    }),
  }
}

/**
 * Gauge: a single aggregated number for the first Y column. Unlike KPI cards
 * (which show a whole stat block) a gauge needs exactly one scalar value.
 */
function gaugeData(rows: Row[], yCols: string[], op: ChartOperation): ChartDataResponse | null {
  const col = yCols[0]
  if (!col) return null
  return { labels: [col], series: [{ name: col, data: [aggregateGroup(rows, col, op)] }] }
}

/**
 * Aggregate grid rows into chart data for the given configuration.
 * Returns null when there is nothing to draw.
 */
export function buildChartData(rows: Row[], cfg: ChartBuildConfig): ChartDataResponse | null {
  if (rows.length === 0) return null
  const yCols = cfg.y.filter(Boolean)
  switch (cfg.chartType) {
    case 'kpi':
      return null // rendered as big-number cards by the panel
    case 'histogram':
      return histogramData(rows, yCols, cfg.bins)
    case 'box':
      return boxData(rows, cfg.x, yCols)
    case 'scatter':
      return scatterData(rows, cfg.x, yCols, cfg.series)
    case 'pareto':
      return paretoData(rows, cfg.x, yCols[0] ?? '', cfg.operation)
    case 'gauge':
      return gaugeData(rows, yCols, cfg.operation)
    case 'combo':
      return comboData(rows, cfg)
    default: // trend / stepline / area / stackarea / bar / stackbar / pie /
      // doughnut / rose / radar / waterfall / funnel / treemap / heatmap
      return categoryData(rows, cfg)
  }
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

export interface KpiStat {
  label: string
  formatted: string
}

export interface KpiCard {
  label: string
  value: number
  formatted: string
  /** Operation actually used for the primary value. */
  op: ChartOperation
  /** Secondary statistics rendered inside the card. */
  stats: KpiStat[]
}

/** Big-number cards: a rows counter plus a full stat block per Y column. */
export function computeKpiCards(rows: Row[], yCols: string[], op: ChartOperation): KpiCard[] {
  const safeOp: ChartOperation = op === 'none' || op === 'share' ? 'sum' : op
  const cards: KpiCard[] = [
    {
      label: 'Total rows',
      value: rows.length,
      formatted: formatCompactNumber(rows.length),
      op: 'count',
      stats: [],
    },
  ]
  for (const col of yCols) {
    const values: number[] = []
    for (const row of rows) {
      const n = toNumber(row[col])
      if (n !== null) values.push(n)
    }
    if (values.length === 0) {
      cards.push({ label: col, value: 0, formatted: '—', op: safeOp, stats: [] })
      continue
    }
    const sum = values.reduce((a, v) => a + v, 0)
    const mean = sum / values.length
    const sorted = [...values].sort((a, b) => a - b)
    const variance =
      values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length
    const primary = aggregateGroup(rows, col, safeOp)
    cards.push({
      label: col,
      value: primary,
      formatted: formatCompactNumber(primary),
      op: safeOp,
      stats: [
        { label: 'Count', formatted: formatCompactNumber(values.length) },
        { label: 'Nulls', formatted: formatCompactNumber(rows.length - values.length) },
        { label: 'Sum', formatted: formatCompactNumber(sum) },
        { label: 'Mean', formatted: formatCompactNumber(mean) },
        { label: 'Median', formatted: formatCompactNumber(quantileSorted(sorted, 0.5)) },
        { label: 'Min', formatted: formatCompactNumber(sorted[0]) },
        { label: 'Max', formatted: formatCompactNumber(sorted[sorted.length - 1]) },
        { label: 'Std dev', formatted: formatCompactNumber(Math.sqrt(variance)) },
      ],
    })
  }
  return cards
}

// ---------------------------------------------------------------------------
// Axis validation
// ---------------------------------------------------------------------------

/**
 * True when an X / Y selection satisfies the chart type's data-type needs
 * (e.g. scatter needs a numeric X, histogram only needs a numeric Y).
 */
export function axisFits(
  chartType: ChartType,
  x: string,
  y: string[],
  kinds: Record<string, ColumnKind>,
  hasSecondary = false,
): boolean {
  const yCols = y.filter(Boolean)
  if (chartType === 'combo') return !!x && (yCols.length > 0 || hasSecondary)
  if (yCols.length === 0) return false
  // Gauge / histogram / KPI aggregate the Y column only — no X category.
  if (chartType === 'histogram' || chartType === 'kpi' || chartType === 'gauge') {
    return yCols.every((c) => kinds[c] === 'number')
  }
  if (!x) return false
  if (chartType === 'scatter') {
    return kinds[x] === 'number' && yCols.every((c) => kinds[c] === 'number')
  }
  if (chartType === 'box') return yCols.every((c) => kinds[c] === 'number')
  // Everything else (trend / area / bar / pie / funnel / treemap / heatmap ...)
  // accepts any X category.
  return true
}

// ---------------------------------------------------------------------------
// Smart axis auto-population
// ---------------------------------------------------------------------------

/**
 * Pick sensible X / Y columns for a chart type from the result's detected
 * column kinds, e.g. scatter → numeric X + numeric Y, trend → date X +
 * numeric Y, bar/pie → low-cardinality text X + numeric Y.
 */
export function autoPickAxes(
  chartType: ChartType,
  columns: { name: string; type: string }[],
  kinds: Record<string, ColumnKind>,
  rows: Row[],
): { x: string; y: string[] } {
  const names = columns.map((c) => c.name)
  const numeric = names.filter((n) => kinds[n] === 'number')
  const dates = names.filter((n) => kinds[n] === 'date')
  const categorical = names.filter((n) => kinds[n] === 'text' || kinds[n] === 'boolean')

  const fallbackY = numeric[0] ?? names[0] ?? ''
  const yList = fallbackY ? [fallbackY] : []

  // Prefer categorical X columns with a small number of distinct values.
  const cardCache = new Map<string, number>()
  const cardinality = (name: string): number => {
    const cached = cardCache.get(name)
    if (cached !== undefined) return cached
    const seen = new Set<unknown>()
    for (const row of rows.slice(0, 200)) {
      const v = row[name]
      if (v !== null && v !== undefined && v !== '') seen.add(v)
    }
    const count = seen.size
    cardCache.set(name, count)
    return count
  }
  const pickCategory = (): string => {
    const candidates = categorical.length > 0 ? categorical : dates.length > 0 ? dates : names
    if (candidates.length === 0) return ''
    const scored = candidates.map((n) => ({ name: n, card: cardinality(n) }))
    const low = scored.filter((s) => s.card >= 2 && s.card <= 20).sort((a, b) => a.card - b.card)
    if (low.length > 0) return low[0].name
    return [...scored].sort((a, b) => a.card - b.card)[0].name
  }

  switch (chartType) {
    case 'trend':
    case 'stepline':
    case 'area':
    case 'stackarea':
      return { x: dates[0] ?? pickCategory(), y: yList }
    case 'scatter': {
      const yName = numeric[0] ?? fallbackY
      const xName = numeric.find((n) => n !== yName) ?? dates[0] ?? names[0] ?? ''
      return { x: xName, y: yName ? [yName] : [] }
    }
    case 'histogram':
      return { x: '', y: yList }
    case 'box':
      return { x: pickCategory(), y: yList }
    case 'gauge':
      return { x: '', y: numeric.length > 0 ? numeric.slice(0, 1) : yList }
    case 'kpi':
      return { x: '', y: numeric.length > 0 ? numeric.slice(0, 3) : yList }
    case 'radar':
      return { x: pickCategory(), y: numeric.length > 0 ? numeric.slice(0, 5) : yList }
    default: // bar / stackbar / pie / doughnut / rose / combo / pareto /
      // waterfall / funnel / treemap / heatmap
      return { x: pickCategory(), y: yList }
  }
}
