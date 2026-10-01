import type { ChartOperation, ChartType } from '../api/client'

/**
 * Chart catalogs shared by every chart surface (the built-in ECharts panel, the
 * summary panel, ...). Kept out of the components so the panels only export
 * components and the builders cannot drift apart.
 */

/** Human-readable name for every chart family, shared by the builder and the
 *  dashboard tiles so a pinned visual is labelled the same way everywhere. */
export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: 'Bar',
  stackbar: 'Stacked bar',
  trend: 'Line',
  stepline: 'Step line',
  area: 'Area',
  stackarea: 'Stacked area',
  combo: 'Combo (bar + line)',
  pie: 'Pie',
  doughnut: 'Doughnut',
  rose: 'Rose',
  radar: 'Radar',
  pareto: 'Pareto',
  waterfall: 'Waterfall',
  funnel: 'Funnel',
  treemap: 'Treemap',
  heatmap: 'Heatmap',
  histogram: 'Histogram',
  box: 'Box plot',
  scatter: 'Scatter',
  bubble: 'Bubble',
  trendline: 'Scatter + trendline',
  errorbar: 'Error bars',
  spc: 'Control chart (SPC)',
  sankey: 'Sankey',
  gauge: 'Gauge',
  kpi: 'KPI cards',
}

/** Aggregation operations offered for the Y axis (None = raw values). */
export const OPERATIONS: { value: ChartOperation; label: string }[] = [
  { value: 'none', label: 'None (raw)' },
  { value: 'sum', label: 'Sum' },
  { value: 'mean', label: 'Mean' },
  { value: 'count', label: 'Count' },
  { value: 'distinct', label: 'Distinct count' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'median', label: 'Median' },
  { value: 'std', label: 'Std dev' },
  { value: 'var', label: 'Variance' },
  { value: 'first', label: 'First' },
  { value: 'last', label: 'Last' },
  { value: 'p25', label: 'Percentile 25' },
  { value: 'p75', label: 'Percentile 75' },
  { value: 'p90', label: 'Percentile 90' },
  { value: 'share', label: '% of total' },
]

/** Default Y-axis operation per chart type. */
export const DEFAULT_OPERATION: Record<ChartType, ChartOperation> = {
  trend: 'none',
  stepline: 'none',
  area: 'none',
  stackarea: 'none',
  bar: 'sum',
  stackbar: 'sum',
  pie: 'sum',
  doughnut: 'sum',
  rose: 'sum',
  combo: 'sum',
  radar: 'sum',
  pareto: 'sum',
  waterfall: 'sum',
  funnel: 'sum',
  treemap: 'sum',
  heatmap: 'sum',
  histogram: 'sum',
  box: 'sum',
  scatter: 'none',
  bubble: 'none',
  trendline: 'none',
  errorbar: 'mean',
  spc: 'mean',
  sankey: 'sum',
  gauge: 'sum',
  kpi: 'sum',
}

/** Aggregation operations that work for a categorical (non-numeric) Y axis. */
export const CATEGORICAL_OPERATIONS: ChartOperation[] = ['count', 'distinct']

/** Chart types whose Y axis must be numeric. */
export const NUMERIC_Y_TYPES: ChartType[] = [
  'histogram',
  'box',
  'scatter',
  'bubble',
  'trendline',
  'errorbar',
  'spc',
  'kpi',
  'gauge',
]

/** Chart types that draw exactly one series. */
export const SINGLE_SERIES_TYPES: ChartType[] = [
  'pie',
  'doughnut',
  'rose',
  'pareto',
  'funnel',
  'treemap',
  'gauge',
  'sankey',
]

/**
 * Chart types that can plot a second measure on a right-hand value axis
 * (the "Y2" shelf). Combo already splits bars and lines across the two axes;
 * the rest draw their secondary columns as lines beside their primary marks.
 */
export const SECONDARY_AXIS_TYPES: ChartType[] = [
  'bar',
  'stackbar',
  'trend',
  'stepline',
  'area',
  'stackarea',
  'combo',
]

/** Chart types that support a breakdown (color-by) dimension. */
export const SERIES_CAPABLE_TYPES: ChartType[] = [
  'bar',
  'stackbar',
  'trend',
  'stepline',
  'area',
  'stackarea',
  'waterfall',
  'scatter',
  'bubble',
  'trendline',
]
