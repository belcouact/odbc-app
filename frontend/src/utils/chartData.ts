import type { ChartDataResponse, ChartOperation } from '../api/client'
import type { ChartType } from '../types'
import { SECONDARY_AXIS_TYPES, SINGLE_SERIES_TYPES } from './chartCatalog'
import type { ColumnKind } from './columns'

/**
 * Client-side chart aggregation. The Charts panel always has the full grid
 * result in memory, so every aggregation runs synchronously in the browser —
 * no network round-trip, no request races, and re-renders are instant when
 * the user tweaks chart options.
 */

type Row = Record<string, unknown>

/** Where the chart legend sits relative to the plot area. */
export type ChartLegendPosition = 'top' | 'bottom' | 'left' | 'right'
/** Where per-point data labels are drawn. */
export type ChartLabelPosition = 'auto' | 'inside' | 'outside' | 'top'
/** Named categorical color palettes (plus the ECharts default). */
export type ChartPaletteId = 'default' | 'warm' | 'cool' | 'colorblind'
/**
 * How numeric values are rendered across axes, tooltips and labels.
 * `'auto'` leaves the chart type's existing formatting untouched.
 */
export type ChartNumberFormat = 'auto' | 'compact' | 'full' | 'percent'
/** Rotation of category axis labels; 'auto' keeps the built-in heuristic. */
export type ChartLabelRotate = 'auto' | 0 | 45 | 90
/**
 * Point symbol shape for line / scatter series, using the ECharts symbol names.
 * `'auto'` keeps the chart type's built-in shape, `'none'` hides the points.
 */
export type ChartMarkerShape =
  | 'auto'
  | 'circle'
  | 'rect'
  | 'roundRect'
  | 'triangle'
  | 'diamond'
  | 'pin'
  | 'arrow'
  | 'none'

/** Line stroke patterns for a single series. 'auto' keeps the built-in solid. */
export type ChartLineType = 'auto' | 'solid' | 'dashed' | 'dotted'

/**
 * Style overrides for a single Y / Y2 column, keyed by column name. Every field
 * is optional and falls back to the chart-wide appearance option, so a chart can
 * be tuned column by column while the globals keep applying to the rest.
 * Axis ranges deliberately stay per-axis, not per-series.
 */
export interface ChartSeriesStyle {
  /** Line stroke pattern. 'auto' keeps the built-in solid stroke. */
  lineType?: ChartLineType
  /** Explicit series color (line + marks). Empty = palette color. */
  color?: string
  /** Line / area smoothing for this series. 'auto' = chart-wide setting. */
  smooth?: boolean | 'auto'
  /** Stroke width for this series. 'auto' = chart-wide width. */
  lineWidth?: number | 'auto'
  /** Show point symbols for this series. 'auto' = chart-wide setting. */
  markers?: boolean | 'auto'
  /** Point symbol shape for this series. 'auto' = chart-wide setting. */
  markerShape?: ChartMarkerShape
}

/** Named color palettes offered for categorical charts. */
export const CHART_PALETTES: Record<Exclude<ChartPaletteId, 'default'>, string[]> = {
  warm: ['#e53935', '#fb8c00', '#f9a825', '#d81b60', '#8e24aa', '#6d4c41'],
  cool: ['#1e88e5', '#26c6da', '#00897b', '#3949ab', '#5e35b1', '#0288d1'],
  colorblind: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442', '#000000'],
}

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
  /** Chart title rendered centred above the plot (empty = none). */
  title?: string
  /** Chart subtitle rendered under the title (empty = none). */
  subtitle?: string
  /** Show the legend. Default true. */
  legendShow?: boolean
  /** Legend alignment. Default 'top'. */
  legendPosition?: ChartLegendPosition
  /** Categorical color palette. Default 'default' (ECharts colors). */
  palette?: ChartPaletteId
  /** Overrides the single-series color (no color-by breakdown). Empty = palette. */
  customColor?: string
  /** Show per-point data labels. Unset keeps the chart type's built-in labels. */
  dataLabels?: boolean
  /** Data-label placement. Default 'auto'. */
  labelPosition?: ChartLabelPosition
  /** Value formatting used by axes, tooltips and data labels. Default 'auto'. */
  numberFormat?: ChartNumberFormat
  /** Fixed decimal places, or 'auto' for the built-in rounding. Default 'auto'. */
  decimals?: number | 'auto'
  /** Show value-axis names. Default true. */
  axisTitles?: boolean
  /** Custom category X-axis title (empty = keep the built-in name). */
  xAxisTitle?: string
  /** Custom primary value-axis title (empty = keep the built-in name). */
  yAxisTitle?: string
  /** Custom secondary (right) value-axis title (empty = keep the built-in name). */
  y2AxisTitle?: string
  /** Category label rotation; 'auto' keeps the built-in heuristic. */
  labelRotate?: ChartLabelRotate
  /** Primary value-axis minimum (null = auto). */
  yMin?: number | null
  /** Primary value-axis maximum (null = auto). */
  yMax?: number | null
  /** Anchor the primary value axis at zero. Default false (auto-scaling). */
  startAtZero?: boolean
  /** Draw value-axis split lines. Default true. */
  gridlines?: boolean
  /** Line/area smoothing; 'auto' keeps each chart type's built-in behavior. */
  smooth?: boolean | 'auto'
  /** Show line/area/scatter point symbols. Default true. */
  markers?: boolean
  /** Point symbol shape; 'auto' keeps each chart type's built-in symbol. */
  markerShape?: ChartMarkerShape
  /** Line stroke width. Default 2. */
  lineWidth?: number
  /** Tighten grid margins. Default false. */
  trimWhitespace?: boolean
  /** Show tooltips. Default true. */
  tooltipShow?: boolean
  /** Chart background color. Empty = theme default. */
  background?: string
  /** Per-series style overrides, keyed by Y / Y2 column name. */
  seriesStyles?: Record<string, ChartSeriesStyle>
}

/** Label ordering for bar / pie categories. */
export type ChartSort = 'none' | 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc'

export interface ChartBuildConfig {
  chartType: ChartType
  x: string
  y: string[]
  /** Default aggregation for the primary Y columns (per-column overrides win). */
  operation: ChartOperation
  /** Per-column primary-Y aggregations, keyed by column name. */
  yOperations?: Record<string, ChartOperation>
  /** Breakdown (color-by) column; uses the first Y column when active. */
  series?: string
  /** Max categories for bar / pie; the rest are dropped (0 = keep all). */
  topN?: number
  /** Histogram bucket width (empty = 10 even buckets across the domain). */
  binSize?: number
  /** Histogram domain start (empty = the data minimum). Values below it are dropped. */
  rangeStart?: number
  /** Histogram domain end (empty = the data maximum). Values above it are dropped. */
  rangeEnd?: number
  sort?: ChartSort
  /** Secondary-axis columns (combo / bar / line charts): drawn on the right axis. */
  y2?: string[]
  /** Default aggregation applied to the secondary (right) axis columns. */
  y2Operation?: ChartOperation
  /** Per-column secondary-Y aggregations, keyed by column name. */
  y2Operations?: Record<string, ChartOperation>
  /** Bubble size column (bubble charts); empty = a constant marker size. */
  z?: string
  /** Flow target column (sankey charts). */
  target?: string
  /** Error-bar spread: sample std dev or the 95% CI of the mean. Default 'ci95'. */
  errorBarMode?: 'std' | 'ci95'
}

/** Fallback histogram bucket count when no bin size is supplied. */
export const DEFAULT_BIN_COUNT = 10
/** Safety cap on histogram bucket count when a tiny bin size is supplied. */
export const MAX_BINS = 200
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

/**
 * Aggregate every (series × label) bucket into named data series.
 * `ops` holds per-column operation overrides (keyed by column name); any column
 * without an entry falls back to the default `op`.
 */
function matrixFromBuckets(
  buckets: Buckets,
  yCols: string[],
  op: ChartOperation,
  ops?: Record<string, ChartOperation>,
): { name: string; data: (number | null)[] }[] {
  const labelCount = buckets.labels.length
  const cellAggregate = (si: number, li: number, col: string): number | null => {
    const columnOp = ops?.[col] ?? op
    const rowsIn = buckets.cells[si]?.[li]
    if (!rowsIn || rowsIn.length === 0) return columnOp === 'none' ? null : 0
    return aggregateGroup(rowsIn, col, columnOp)
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
  // Secondary-axis columns are a separate measure; a breakdown column already
  // owns the series list, so the two never combine.
  const y2Cols =
    !series && SECONDARY_AXIS_TYPES.includes(chartType) ? (cfg.y2 ?? []).filter(Boolean) : []
  if (!x || (yCols.length === 0 && y2Cols.length === 0)) return null

  const buckets = buildBuckets(rows, x, series ?? '')
  const matrix = [
    ...matrixFromBuckets(buckets, yCols, operation, cfg.yOperations),
    ...(y2Cols.length > 0
      ? matrixFromBuckets(buckets, y2Cols, cfg.y2Operation ?? operation, cfg.y2Operations)
      : []),
  ]
  const finalized = finalizeCategory(buckets.labels, matrix, sort, topN)
  if (y2Cols.length === 0) return { labels: finalized.labels, series: finalized.matrix }
  // The option builder tags these names so it can route them to the right axis.
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

/**
 * Histogram: one shared, user-controlled binning across all selected Y columns.
 * `binSize` sets the bucket width (empty = {@link DEFAULT_BIN_COUNT} even buckets
 * across the domain); `rangeStart` / `rangeEnd` clip that domain, and values
 * outside it are dropped.
 */
function histogramData(
  rows: Row[],
  yCols: string[],
  opts: { binSize?: number; rangeStart?: number; rangeEnd?: number },
): ChartDataResponse | null {
  if (yCols.length === 0) return null
  const perColumn: number[][] = yCols.map(() => [])
  for (const row of rows) {
    yCols.forEach((col, i) => {
      const n = toNumber(row[col])
      if (n !== null) perColumn[i].push(n)
    })
  }
  const all = perColumn.flat()
  if (all.length === 0) return null

  // Domain: an explicit start / end overrides the data extent.
  let dataMin = all[0]
  let dataMax = all[0]
  for (const v of all) {
    if (v < dataMin) dataMin = v
    if (v > dataMax) dataMax = v
  }
  const min = opts.rangeStart ?? dataMin
  const max = opts.rangeEnd ?? dataMax

  // Values outside the requested range are excluded — that is what a range means.
  const inRange = perColumn.map((values) => values.filter((v) => v >= min && v <= max))

  // Degenerate domain (start === end, or a single distinct value): one bucket.
  if (!(max > min)) {
    return {
      labels: [formatCompactNumber(min)],
      series: yCols.map((name, i) => ({ name, data: [inRange[i].length] })),
    }
  }

  const step = opts.binSize && opts.binSize > 0 ? opts.binSize : (max - min) / DEFAULT_BIN_COUNT
  const binCount = Math.min(MAX_BINS, Math.max(1, Math.ceil((max - min) / step)))
  const counts = inRange.map(() => new Array<number>(binCount).fill(0))
  inRange.forEach((values, i) => {
    for (const v of values) {
      let b = Math.floor((v - min) / step)
      if (b >= binCount) b = binCount - 1
      if (b < 0) b = 0
      counts[i][b] += 1
    }
  })
  return {
    labels: Array.from({ length: binCount }, (_, i) =>
      `${formatCompactNumber(min + i * step)} – ${formatCompactNumber(min + (i + 1) * step)}`,
    ),
    series: yCols.map((name, i) => ({ name, data: counts[i] })),
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

/** Cap a point list with stride sampling so very large results stay responsive. */
function samplePoints(points: number[][]): number[][] {
  if (points.length <= MAX_SCATTER_POINTS) return points
  const step = Math.ceil(points.length / MAX_SCATTER_POINTS)
  return points.filter((_, i) => i % step === 0)
}

/**
 * Raw, unsampled [x, y] points per series, grouped by the breakdown column when
 * active. Shared by the scatter family so the fit and the plotted points always
 * come from the same rows.
 */
function scatterGroups(
  rows: Row[],
  x: string,
  yCols: string[],
  series?: string,
): { name: string; points: number[][] }[] {
  if (!x || yCols.length === 0) return []
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
    return [...groups.entries()].map(([name, points]) => ({ name, points }))
  }
  return yCols.map((col) => {
    const points: number[][] = []
    for (const row of rows) {
      const xv = toNumber(row[x])
      const yv = toNumber(row[col])
      if (xv !== null && yv !== null) points.push([xv, yv])
    }
    return { name: col, points }
  })
}

/** Scatter: [x, y] pairs; grouped by the breakdown column when active. */
function scatterData(rows: Row[], x: string, yCols: string[], series?: string): ChartDataResponse | null {
  const groups = scatterGroups(rows, x, yCols, series)
  if (groups.length === 0) return null
  return {
    labels: [],
    series: groups.map((g) => ({ name: g.name, data: samplePoints(g.points) })),
  }
}

/** Least-squares fit of a point cloud, used for the trendline overlay. */
interface LinearFit {
  slope: number
  intercept: number
  /** Coefficient of determination (0–1). */
  r2: number
  /** Number of points the fit was computed from. */
  n: number
}

function linearFit(points: number[][]): LinearFit | null {
  const n = points.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [xv, yv] of points) {
    sx += xv
    sy += yv
    sxx += xv * xv
    sxy += xv * yv
    syy += yv * yv
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const slope = (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  const rDen = Math.sqrt(denom * (n * syy - sy * sy))
  const r = rDen === 0 ? 0 : (n * sxy - sx * sy) / rDen
  return { slope, intercept, r2: r * r, n }
}

/** Trendline: scatter points plus an OLS fit per series (carried on extra.fits). */
function trendlineData(rows: Row[], x: string, yCols: string[], series?: string): ChartDataResponse | null {
  const groups = scatterGroups(rows, x, yCols, series)
  if (groups.length === 0) return null
  // Fit on the full point cloud, then sample only the plotted markers.
  const fits: Record<string, LinearFit> = {}
  for (const g of groups) {
    const fit = linearFit(g.points)
    if (fit) fits[g.name] = fit
  }
  return {
    labels: [],
    series: groups.map((g) => ({ name: g.name, data: samplePoints(g.points) })),
    extra: { fits },
  }
}

/** Bubble: [x, y, size] triples; the size column is optional (extra.has_size). */
function bubbleData(
  rows: Row[],
  x: string,
  yCols: string[],
  z: string | undefined,
  series?: string,
): ChartDataResponse | null {
  if (!x || yCols.length === 0) return null
  const toPoint = (row: Row, col: string): number[] | null => {
    const xv = toNumber(row[x])
    const yv = toNumber(row[col])
    if (xv === null || yv === null) return null
    return [xv, yv, z ? (toNumber(row[z]) ?? 0) : 0]
  }
  let groups: { name: string; points: number[][] }[]
  if (series) {
    const col = yCols[0]
    const byName = new Map<string, number[][]>()
    for (const row of rows) {
      const point = toPoint(row, col)
      if (!point) continue
      const key = labelValue(row[series])
      const points = byName.get(key) ?? (byName.set(key, []), byName.get(key)!)
      points.push(point)
    }
    groups = [...byName.entries()].map(([name, points]) => ({ name, points }))
  } else {
    groups = yCols.map((col) => {
      const points: number[][] = []
      for (const row of rows) {
        const point = toPoint(row, col)
        if (point) points.push(point)
      }
      return { name: col, points }
    })
  }
  if (groups.length === 0) return null
  return {
    labels: [],
    series: groups.map((g) => ({ name: g.name, data: samplePoints(g.points) })),
    extra: { has_size: !!z, size_name: z ?? '' },
  }
}

/**
 * Error bars: per X category, the mean of the first Y column plus a symmetric
 * spread — the sample std dev or the 95% confidence interval of the mean. The
 * spread always comes from the raw values, so `operation` is ignored.
 */
function errorBarData(
  rows: Row[],
  x: string,
  yCols: string[],
  mode?: 'std' | 'ci95',
): ChartDataResponse | null {
  const col = yCols[0]
  if (!x || !col) return null
  const useCi = mode !== 'std'
  const buckets = buildBuckets(rows, x, '')
  const means: number[] = []
  const lows: number[] = []
  const highs: number[] = []
  for (let li = 0; li < buckets.labels.length; li += 1) {
    const rowsIn = buckets.cells[0]?.[li] ?? []
    const values = rowsIn
      .map((r) => toNumber(r[col]))
      .filter((n): n is number => n !== null)
    const n = values.length
    let mean = 0
    let spread = 0
    if (n > 0) {
      mean = values.reduce((a, v) => a + v, 0) / n
      if (n > 1) {
        const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1)
        const sd = Math.sqrt(variance)
        // 95% CI of the mean: 1.96 · s / √n (normal approximation).
        spread = useCi ? (1.96 * sd) / Math.sqrt(n) : sd
      }
    }
    means.push(mean)
    lows.push(mean - spread)
    highs.push(mean + spread)
  }
  return {
    labels: buckets.labels,
    series: [{ name: col, data: means }],
    extra: { error_low: lows, error_high: highs, error_op: useCi ? '95% CI' : 'Std dev' },
  }
}

/**
 * Control chart (I-MR): one point per X group in row order, with the centre
 * line and ±3σ limits from the moving-range estimate (d2 = 1.128). Falls back
 * to the sample std dev when there are fewer than two points.
 */
function spcData(rows: Row[], x: string, yCols: string[], op: ChartOperation): ChartDataResponse | null {
  const col = yCols[0]
  if (!col) return null
  const labels: string[] = []
  const values: number[] = []
  if (x) {
    const buckets = buildBuckets(rows, x, '')
    buckets.labels.forEach((label, li) => {
      const rowsIn = buckets.cells[0]?.[li] ?? []
      if (rowsIn.length === 0) return
      labels.push(label)
      values.push(aggregateGroup(rowsIn, col, op))
    })
  } else {
    rows.forEach((row, i) => {
      const n = toNumber(row[col])
      if (n === null) return
      labels.push(String(i + 1))
      values.push(n)
    })
  }
  if (values.length === 0) return null
  const cl = values.reduce((a, v) => a + v, 0) / values.length
  let sigma = 0
  if (values.length >= 2) {
    let sumMr = 0
    for (let i = 1; i < values.length; i += 1) sumMr += Math.abs(values[i] - values[i - 1])
    sigma = sumMr / (values.length - 1) / 1.128
  }
  if (sigma === 0 && values.length > 1) {
    let sq = 0
    for (const v of values) sq += (v - cl) * (v - cl)
    sigma = Math.sqrt(sq / (values.length - 1))
  }
  const ucl = cl + 3 * sigma
  const lcl = cl - 3 * sigma
  const ooc: number[] = []
  values.forEach((v, i) => {
    if (v > ucl || v < lcl) ooc.push(i)
  })
  return {
    labels,
    series: [{ name: col, data: values }],
    extra: { cl, ucl, lcl, sigma, ooc },
  }
}

/** One aggregated link of a Sankey diagram. */
interface SankeyLink {
  source: string
  target: string
  value: number
}

/** Sankey: flow volumes between two categorical columns (sum of the first Y). */
function sankeyData(
  rows: Row[],
  source: string,
  target: string,
  yCols: string[],
  op: ChartOperation,
): ChartDataResponse | null {
  if (!source || !target || source === target) return null
  const useValue = yCols.length > 0
  const nodes = new Set<string>()
  const links = new Map<string, SankeyLink>()
  for (const row of rows) {
    const sv = row[source]
    const tv = row[target]
    if (sv === null || sv === undefined || sv === '' || tv === null || tv === undefined || tv === '') continue
    const src = labelValue(sv)
    const dst = labelValue(tv)
    nodes.add(src)
    nodes.add(dst)
    const value = useValue ? aggregateGroup([row], yCols[0], op) : 1
    const key = `${src}\u0000${dst}`
    const existing = links.get(key)
    if (existing) existing.value += value
    else links.set(key, { source: src, target: dst, value })
  }
  if (links.size === 0) return null
  return {
    // A placeholder series keeps the shared "no data" guard satisfied; the real
    // payload lives on extra.sankey (nodes + links), which is how ECharts wants it.
    labels: [],
    series: [{ name: 'flow', data: [] }],
    extra: {
      sankey: {
        nodes: [...nodes].map((name) => ({ name })),
        links: [...links.values()],
      },
    },
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
      return histogramData(rows, yCols, {
        binSize: cfg.binSize,
        rangeStart: cfg.rangeStart,
        rangeEnd: cfg.rangeEnd,
      })
    case 'box':
      return boxData(rows, cfg.x, yCols)
    case 'scatter':
      return scatterData(rows, cfg.x, yCols, cfg.series)
    case 'bubble':
      return bubbleData(rows, cfg.x, yCols, cfg.z, cfg.series)
    case 'trendline':
      return trendlineData(rows, cfg.x, yCols, cfg.series)
    case 'errorbar':
      return errorBarData(rows, cfg.x, yCols, cfg.errorBarMode)
    case 'spc':
      return spcData(rows, cfg.x, yCols, cfg.operation)
    case 'sankey':
      return sankeyData(rows, cfg.x, cfg.target ?? '', yCols, cfg.operation)
    case 'pareto':
      return paretoData(rows, cfg.x, yCols[0] ?? '', cfg.operation)
    case 'gauge':
      return gaugeData(rows, yCols, cfg.operation)
    default: // trend / stepline / area / stackarea / bar / stackbar / combo / pie /
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
  // Sankey plots a source → target flow; the Y measure is optional (row counts).
  if (chartType === 'sankey') return !!x
  if (yCols.length === 0) return false
  // Gauge / histogram / KPI aggregate the Y column only — no X category.
  if (chartType === 'histogram' || chartType === 'kpi' || chartType === 'gauge') {
    return yCols.every((c) => kinds[c] === 'number')
  }
  // The control chart can fall back to plain row order, so its X is optional.
  if (chartType === 'spc') return yCols.every((c) => kinds[c] === 'number')
  if (!x) return false
  if (chartType === 'scatter' || chartType === 'bubble' || chartType === 'trendline') {
    return kinds[x] === 'number' && yCols.every((c) => kinds[c] === 'number')
  }
  if (chartType === 'box' || chartType === 'errorbar') {
    return yCols.every((c) => kinds[c] === 'number')
  }
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
    case 'scatter':
    case 'bubble':
    case 'trendline': {
      const yName = numeric[0] ?? fallbackY
      const xName = numeric.find((n) => n !== yName) ?? dates[0] ?? names[0] ?? ''
      return { x: xName, y: yName ? [yName] : [] }
    }
    case 'histogram':
      return { x: '', y: yList }
    case 'box':
    case 'errorbar':
    case 'spc':
      return { x: pickCategory(), y: yList }
    case 'sankey':
      // The panel picks a distinct target column from the same categorical list.
      return { x: pickCategory(), y: [] }
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
