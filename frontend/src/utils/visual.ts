import type { EChartsOption } from 'echarts'
import type { ChartDataResponse, ChartOperation, ChartType } from '../api/client'
import { buildChartData, computeKpiCards, type ChartSort, type KpiCard } from './chartData'
import { buildChartOption } from './chartOptions'
import { CHART_TYPE_LABELS, SERIES_CAPABLE_TYPES } from './chartCatalog'

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
  /** Breakdown (color-by) column, for series-capable chart types only. */
  series?: string
  sort?: ChartSort
  /** Keep only the top-N categories (0 = all). */
  topN?: number
  /** Histogram bucket count. */
  bins?: number
  barMode?: 'grouped' | 'stacked' | 'percent'
  horizontal?: boolean
  area?: boolean
  /** Secondary (right) axis columns, combo charts only. */
  y2?: string[]
  y2Operation?: ChartOperation
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
  const combo = config.chartType === 'combo'
  const y2 = combo && config.y2?.length ? config.y2 : undefined

  const data =
    config.chartType === 'kpi'
      ? null
      : buildChartData(rows, {
          chartType: config.chartType,
          x: config.x,
          y: config.y,
          operation: config.operation,
          series: seriesCapable && config.series ? config.series : undefined,
          topN: config.topN,
          bins: config.bins,
          sort: config.sort,
          y2,
          y2Operation: y2 ? config.y2Operation : undefined,
        })

  const option = buildChartOption(config.chartType, config.x, config.y, data, null, {
    barMode: config.barMode,
    horizontal: config.horizontal,
    area: config.area,
    hasSeries: seriesCapable && !!config.series,
  })

  return {
    data,
    option,
    kpiCards:
      config.chartType === 'kpi' ? computeKpiCards(rows, config.y, config.operation) : [],
    hasData: !!data && data.series.some((s) => (s.data as unknown[]).length > 0),
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
