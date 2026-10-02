import type { EChartsOption } from 'echarts'
import type { AiDashboardChart, ChartDataResponse, ChartOperation, ChartType } from '../api/client'
import {
  buildChartData,
  computeKpiCards,
  type ChartLabelPosition,
  type ChartLabelRotate,
  type ChartLegendPosition,
  type ChartMarkerShape,
  type ChartNumberFormat,
  type ChartPaletteId,
  type ChartSeriesStyle,
  type ChartSort,
  type KpiCard,
} from './chartData'
import { buildChartOption } from './chartOptions'
import { CHART_TYPE_LABELS, SECONDARY_AXIS_TYPES, SERIES_CAPABLE_TYPES } from './chartCatalog'

/**
 * A dashboard visual's configuration: everything needed to rebuild one chart
 * from a snapshot's rows. This is the shape that gets persisted per snapshot,
 * so it deliberately holds no data — only choices.
 *
 * The chart builder (ChartsPanel) and a pinned tile (VisualTile) render through
 * the same {@link buildVisualChart}, which keeps "what you previewed" and "what
 * the dashboard shows" identical by construction.
 */
export interface VisualConfig {
  chartType: ChartType
  x: string
  y: string[]
  operation: ChartOperation
  /** Per-column operation overrides on the primary axis, keyed by column name. */
  yOperations?: Record<string, ChartOperation>
  /** Breakdown (color-by) column, for series-capable chart types only. */
  series?: string
  sort?: ChartSort
  /** Keep only the top-N categories (0 = all). */
  topN?: number
  /** Histogram bucket width (empty = auto). */
  binSize?: number
  /** Histogram domain start (empty = data minimum). */
  rangeStart?: number
  /** Histogram domain end (empty = data maximum). */
  rangeEnd?: number
  barMode?: 'grouped' | 'stacked' | 'percent'
  horizontal?: boolean
  area?: boolean
  /** Secondary (right) axis columns, for dual-axis chart types only. */
  y2?: string[]
  y2Operation?: ChartOperation
  /** Per-column operation overrides on the secondary axis, keyed by column name. */
  y2Operations?: Record<string, ChartOperation>
  /** Bubble size column (bubble charts). */
  z?: string
  /** Flow target column (sankey charts). */
  target?: string
  /** Error-bar spread: sample std dev or the 95% CI of the mean. */
  errorBarMode?: 'std' | 'ci95'
  // ---- Appearance options (see ChartDisplayOptions) ----
  title?: string
  subtitle?: string
  legendShow?: boolean
  legendPosition?: ChartLegendPosition
  palette?: ChartPaletteId
  customColor?: string
  dataLabels?: boolean
  labelPosition?: ChartLabelPosition
  numberFormat?: ChartNumberFormat
  decimals?: number | 'auto'
  axisTitles?: boolean
  xAxisTitle?: string
  yAxisTitle?: string
  y2AxisTitle?: string
  labelRotate?: ChartLabelRotate
  yMin?: number | null
  yMax?: number | null
  startAtZero?: boolean
  gridlines?: boolean
  smooth?: boolean | 'auto'
  markers?: boolean
  markerShape?: ChartMarkerShape
  lineWidth?: number
  /** Per-column style overrides (line type/width, color, smooth, markers),
   *  keyed by column name. Supersedes the global appearance options above. */
  seriesStyles?: Record<string, ChartSeriesStyle>
  trimWhitespace?: boolean
  tooltipShow?: boolean
  background?: string
}

/** How many dashboard grid columns a visual spans. */
export type VisualSize = 'small' | 'medium' | 'large'

/** Grid span per tile size. Clamped at each breakpoint so a large tile never
 *  forces an implicit extra column into the grid. */
export const VISUAL_SPAN: Record<VisualSize, { xs: string; sm: string; lg: string }> = {
  small: { xs: 'span 1', sm: 'span 1', lg: 'span 1' },
  medium: { xs: 'span 1', sm: 'span 2', lg: 'span 2' },
  large: { xs: 'span 1', sm: 'span 2', lg: 'span 3' },
}

export const VISUAL_SIZE_LABELS: Record<VisualSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
}

/** One pinned chart on a snapshot's dashboard. */
export interface DashboardVisual {
  id: string
  title: string
  size: VisualSize
  config: VisualConfig
}

/** Everything derived from a visual config, ready to render. */
export interface VisualChart {
  data: ChartDataResponse | null
  option: EChartsOption | null
  kpiCards: KpiCard[]
  /** True when the aggregation produced at least one non-empty series. */
  hasData: boolean
}

/**
 * Turn a visual config into chart data + an ECharts option (or KPI cards).
 * Pure and synchronous — callers memoize on rows + config.
 */
export function buildVisualChart(rows: Record<string, unknown>[], config: VisualConfig): VisualChart {
  const seriesCapable = SERIES_CAPABLE_TYPES.includes(config.chartType)
  // A breakdown (Legend) column already owns the series list, so the secondary
  // axis only applies when no breakdown is set.
  const secondaryCapable =
    SECONDARY_AXIS_TYPES.includes(config.chartType) && !(seriesCapable && config.series)
  const y2 = secondaryCapable && config.y2?.length ? config.y2 : undefined

  const data =
    config.chartType === 'kpi'
      ? null
      : buildChartData(rows, {
          chartType: config.chartType,
          x: config.x,
          y: config.y,
          operation: config.operation,
          yOperations: config.yOperations,
          series: seriesCapable && config.series ? config.series : undefined,
          topN: config.topN,
          binSize: config.binSize,
          rangeStart: config.rangeStart,
          rangeEnd: config.rangeEnd,
          sort: config.sort,
          y2,
          y2Operation: y2 ? config.y2Operation : undefined,
          y2Operations: y2 ? config.y2Operations : undefined,
          z: config.z,
          target: config.target,
          errorBarMode: config.errorBarMode,
        })

  const option = buildChartOption(config.chartType, config.x, config.y, data, null, {
    barMode: config.barMode,
    horizontal: config.horizontal,
    area: config.area,
    xAxisTitle: config.xAxisTitle,
    yAxisTitle: config.yAxisTitle,
    y2AxisTitle: config.y2AxisTitle,
    hasSeries: seriesCapable && !!config.series,
    title: config.title,
    subtitle: config.subtitle,
    legendShow: config.legendShow,
    legendPosition: config.legendPosition,
    palette: config.palette,
    customColor: config.customColor,
    dataLabels: config.dataLabels,
    labelPosition: config.labelPosition,
    numberFormat: config.numberFormat,
    decimals: config.decimals,
    axisTitles: config.axisTitles,
    labelRotate: config.labelRotate,
    yMin: config.yMin,
    yMax: config.yMax,
    startAtZero: config.startAtZero,
    gridlines: config.gridlines,
    smooth: config.smooth,
    markers: config.markers,
    markerShape: config.markerShape,
    lineWidth: config.lineWidth,
    seriesStyles: config.seriesStyles,
    trimWhitespace: config.trimWhitespace,
    tooltipShow: config.tooltipShow,
    background: config.background,
  })

  // Sankey carries its payload on extra (nodes + links) rather than on a series,
  // so the shared per-series emptiness check would wrongly report "no data".
  const sankeyLinks = (data?.extra?.sankey as { links?: unknown[] } | undefined)?.links
  const hasData =
    !!data &&
    (data.series.some((s) => (s.data as unknown[]).length > 0) ||
      (Array.isArray(sankeyLinks) && sankeyLinks.length > 0))

  return {
    data,
    option,
    kpiCards:
      config.chartType === 'kpi' ? computeKpiCards(rows, config.y, config.operation) : [],
    hasData,
  }
}

/** Default tile title — the chart family plus the fields it plots. */
export function visualTitle(config: VisualConfig): string {
  const family = CHART_TYPE_LABELS[config.chartType] ?? config.chartType
  const parts = [config.x, ...config.y].filter(Boolean)
  return parts.length > 0 ? `${family} — ${parts.join(' × ')}` : family
}

/** A short, collision-resistant id for a new tile (no crypto dependency). */
export function newVisualId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Map an AI-designed chart spec onto a full {@link VisualConfig} for the shared
 * {@link buildVisualChart} pipeline. Only the fields the AI returns are set;
 * every appearance option keeps its builder default.
 */
export function aiChartToVisual(spec: AiDashboardChart): VisualConfig {
  return {
    chartType: spec.chartType,
    x: spec.x,
    y: spec.y,
    operation: spec.operation,
    series: spec.series,
    title: spec.title,
    subtitle: spec.subtitle,
    // AI-designed dashboard charts always put the legend at the bottom; the
    // spec itself carries no appearance options, so it is forced here.
    legendPosition: 'bottom',
  }
}
