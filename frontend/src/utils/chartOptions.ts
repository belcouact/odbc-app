import type { EChartsOption } from 'echarts'
import type { ChartDataResponse } from '../api/client'
import type { ChartType } from '../types'
import {
  CHART_PALETTES,
  formatCompactNumber,
  type ChartDisplayOptions,
  type ChartLabelPosition,
  type ChartNumberFormat,
  type ChartSeriesStyle,
} from './chartData'

/** Minimal shape of ECharts tooltip formatter params used below. */
interface TooltipParam {
  marker?: string
  axisValueLabel?: string | number
  axisValue?: string | number
  seriesName?: string
  dataIndex?: number
  data?: unknown
  value?: unknown
}

/** Loose object view used to patch a computed option without fighting ECharts types. */
type OptionRecord = Record<string, unknown>

/** Value formatter derived from the display options. */
type ValueFormatter = (value: unknown) => string

const isRecord = (value: unknown): value is OptionRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** ECharts accepts a bare object or an array for most option lists. */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Format a single number according to the chosen number format + decimals. */
function formatNumeric(value: number, format: ChartNumberFormat, decimals: number | 'auto'): string {
  const fixed = decimals !== 'auto'
  if (format === 'percent') {
    const pct = value * 100
    return fixed ? `${pct.toFixed(decimals)}%` : `${formatCompactNumber(pct)}%`
  }
  if (format === 'full' || (format === 'auto' && fixed)) {
    return value.toLocaleString(
      'en-US',
      fixed ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : undefined,
    )
  }
  // 'auto' (untouched by default) and 'compact' both mirror the app-wide
  // compact formatting.
  return formatCompactNumber(value)
}

/** Build the shared value formatter used by axes, tooltips and data labels. */
function makeValueFormatter(display?: ChartDisplayOptions): ValueFormatter {
  const format = display?.numberFormat ?? 'compact'
  const decimals = display?.decimals ?? 'auto'
  return (value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—'
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return String(value)
    return formatNumeric(n, format, decimals)
  }
}

/**
 * Axis tooltip for a chart with a color-by (breakdown) series. Only the X
 * category (header) and a single aggregate Y value are shown — the per-series
 * breakdown info is deliberately hidden so "color by" details never appear on
 * hover. The aggregate is the sum of every breakdown series at that X point.
 */
function yMetricTooltip(yName: string, fmt: ValueFormatter, suffix = '') {
  return {
    trigger: 'axis' as const,
    formatter: (params: unknown): string => {
      const list = (Array.isArray(params) ? params : [params]) as TooltipParam[]
      const head = list[0]
      const header = head ? String(head.axisValueLabel ?? head.axisValue ?? '') : ''
      const total = list.reduce((acc, p) => {
        const v = Number(p.data)
        return acc + (Number.isFinite(v) ? v : 0)
      }, 0)
      const text = list.length ? fmt(total) + suffix : '—'
      return [header, `${yName}: ${text}`].filter(Boolean).join('<br/>')
    },
  }
}

/** Scatter tooltip showing the raw X / Y values of the hovered point. */
function scatterTooltip(xName: string, yName: string, fmt: ValueFormatter) {
  return {
    trigger: 'item' as const,
    formatter: (params: unknown): string => {
      const p = (Array.isArray(params) ? params[0] : params) as TooltipParam | undefined
      const v = p?.value
      const xv = Array.isArray(v) ? v[0] : v
      const yv = Array.isArray(v) ? v[1] : undefined
      const fmtValue = (n: unknown): string =>
        typeof n === 'number' && Number.isFinite(n) ? fmt(n) : String(n ?? '—')
      return `${xName}: ${fmtValue(xv)}<br/>${yName}: ${fmtValue(yv)}`
    },
  }
}

/** Names of the series the aggregation routed to the secondary (right) axis. */
function secondaryNames(data: ChartDataResponse): string[] {
  return Array.isArray(data.extra?.secondary_series)
    ? (data.extra!.secondary_series as string[])
    : []
}

/**
 * Map a bubble's size value onto a marker diameter in pixels. The interpolation
 * runs on the *area* (not the diameter) so a value twice as large looks about
 * twice as heavy; the diameter therefore stays inside [minPx, maxPx].
 */
function bubblePixels(value: number, min: number, max: number, minPx = 8, maxPx = 40): number {
  if (!Number.isFinite(value)) return (minPx + maxPx) / 2
  if (max <= min) return (minPx + maxPx) / 2
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)))
  const area = minPx * minPx + t * (maxPx * maxPx - minPx * minPx)
  return Math.sqrt(area)
}

/** Resolve the concrete label position for a series type. */
function labelPositionFor(type: string, position?: ChartLabelPosition): string {
  if (position === 'inside') return 'inside'
  if (position === 'top') return 'top'
  if (position === 'outside') {
    // 'outside' is only meaningful for pie / funnel; bar / line use 'top'.
    return type === 'pie' || type === 'funnel' ? 'outside' : 'top'
  }
  // 'auto' / undefined: sensible per-type default.
  if (type === 'pie') return 'outside'
  if (type === 'funnel' || type === 'treemap') return 'inside'
  return 'top'
}

/** Data-label formatter that reuses the shared value formatter. */
function labelFormatter(type: string, fmt: ValueFormatter) {
  return (params: { value?: unknown; name?: string }): string => {
    if (type === 'treemap') {
      return params.name ? `${params.name}: ${fmt(params.value)}` : ''
    }
    const value = params.value
    if (Array.isArray(value)) return fmt(value[value.length - 1])
    return fmt(value)
  }
}

/**
 * Resolve the per-series style override for an ECharts series by its name.
 * Most series are named after their Y / Y2 column, but scatter-family series
 * are named `"<column> vs <x>"`, so a prefix match recovers the originating
 * column. Returns undefined when no override applies.
 */
function seriesStyleFor(
  name: unknown,
  styles?: Record<string, ChartSeriesStyle>,
): ChartSeriesStyle | undefined {
  if (!styles || typeof name !== 'string') return undefined
  const direct = styles[name]
  if (direct) return direct
  const suffix = ' vs '
  for (const [column, style] of Object.entries(styles)) {
    if (style && name.startsWith(`${column}${suffix}`)) return style
  }
  return undefined
}

/**
 * Apply the shared appearance options to a fully built option. Kept as a single
 * post-processing pass so the per-chart-type branches never repeat this logic.
 * Every field is optional: when it is undefined the corresponding behaviour is
 * left exactly as the per-type builder produced it.
 */
function applyAppearance(
  option: EChartsOption,
  display: ChartDisplayOptions | undefined,
  chartType: ChartType,
): EChartsOption {
  if (!display) return option
  const opt = option as OptionRecord
  const fmt = makeValueFormatter(display)
  const hasTitle = !!(display.title || display.subtitle)
  // Custom axis titles are opt-in and also obey the axisTitles master switch.
  // Empty / undefined leaves every axis name exactly as the builder set it.
  const axisTitlesOn = display.axisTitles !== false
  const xTitleText = axisTitlesOn ? (display.xAxisTitle ?? '').trim() : ''
  const yTitleText = axisTitlesOn ? (display.yAxisTitle ?? '').trim() : ''
  const y2TitleText = axisTitlesOn ? (display.y2AxisTitle ?? '').trim() : ''

  // Root-level appearance ---------------------------------------------------
  if (display.background) opt.backgroundColor = display.background

  if (display.palette !== undefined) {
    if (display.palette === 'default') delete opt.color
    else opt.color = CHART_PALETTES[display.palette]
  }

  if (display.tooltipShow === false && isRecord(opt.tooltip)) {
    opt.tooltip = { ...opt.tooltip, show: false }
  }

  if (hasTitle) {
    opt.title = {
      text: display.title ?? '',
      subtext: display.subtitle ?? '',
      left: 'center',
      top: 0,
    }
  }

  // Legend ------------------------------------------------------------------
  const hasLegend = opt.legend !== undefined
  const legendVisible = hasLegend && display.legendShow !== false
  const legendPos =
    display.legendPosition ??
    (isRecord(opt.legend) && opt.legend.top !== undefined ? 'top' : undefined)
  if (hasLegend) {
    const legend: OptionRecord = isRecord(opt.legend) ? { ...opt.legend } : {}
    if (display.legendShow !== undefined) legend.show = display.legendShow
    if (display.legendPosition) {
      delete legend.bottom
      delete legend.right
      if (display.legendPosition === 'top') {
        legend.top = hasTitle ? (display.subtitle ? 62 : 48) : 0
        legend.left = 'center'
        legend.orient = 'horizontal'
      } else if (display.legendPosition === 'bottom') {
        delete legend.top
        legend.bottom = 0
        legend.left = 'center'
        legend.orient = 'horizontal'
      } else if (display.legendPosition === 'left') {
        delete legend.top
        legend.left = 0
        legend.top = 'middle'
        legend.orient = 'vertical'
      } else {
        legend.top = 'middle'
        legend.right = 0
        legend.orient = 'vertical'
      }
    }
    opt.legend = legend
  }

  // Grid margins driven by title / legend position / whitespace trimming -----
  if (isRecord(opt.grid)) {
    const grid: OptionRecord = { ...opt.grid }
    const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)
    const baseTop = num(grid.top)
    const baseBottom = num(grid.bottom)
    const baseLeft = num(grid.left)
    const baseRight = num(grid.right)
    const titleBand = hasTitle ? (display.subtitle ? 62 : 48) : 0
    const legendOnTop = legendVisible && legendPos === 'top'
    const legendOnBottom = legendVisible && legendPos === 'bottom'
    const legendOnSide = legendVisible && (legendPos === 'left' || legendPos === 'right')

    let top: number
    if (titleBand > 0) top = titleBand + (legendOnTop ? 28 : 0)
    else if (legendOnBottom || legendOnSide) top = 8
    else top = baseTop
    let bottom = legendOnBottom ? Math.max(baseBottom, 40) : baseBottom
    let left = legendVisible && legendPos === 'left' ? Math.max(baseLeft, 90) : baseLeft
    let right = legendVisible && legendPos === 'right' ? Math.max(baseRight, 90) : baseRight

    if (display.trimWhitespace) {
      left = legendVisible && legendPos === 'left' ? Math.max(left, 90) : 8
      right = legendVisible && legendPos === 'right' ? Math.max(right, 90) : 8
      bottom = legendOnBottom ? Math.max(bottom, 40) : 8
    }

    // Room for the custom axis names. Taken last and via Math.max so the title
    // band, legend margins and whitespace trimming are never shrunk. A vertical
    // name is rotated, so it needs its own line height plus the nameGap that
    // separates it from the tick numbers.
    if (xTitleText) bottom = Math.max(bottom, 52)
    if (yTitleText) left = Math.max(left, 72)
    if (y2TitleText) right = Math.max(right, 72)

    grid.top = top
    grid.bottom = bottom
    grid.left = left
    grid.right = right
    opt.grid = grid
  }

  // Axes --------------------------------------------------------------------
  const xAxes = toArray(opt.xAxis as OptionRecord | OptionRecord[])
  const yAxes = toArray(opt.yAxis as OptionRecord | OptionRecord[])
  const valueAxes = [...xAxes, ...yAxes].filter((axis) => axis.type === 'value')
  // Scatter has value axes on both sides; its "primary" is the Y (vertical) one.
  const primaryValueAxis =
    chartType === 'scatter'
      ? yAxes.find((axis) => axis.type === 'value') ?? valueAxes[0]
      : valueAxes[0]

  for (const axis of valueAxes) {
    if (display.gridlines === false) axis.splitLine = { show: false }
    if (display.axisTitles === false) delete axis.name
    const label = isRecord(axis.axisLabel) ? { ...axis.axisLabel } : {}
    // Preserve any per-type custom formatter (e.g. the 0–100% axis) and only
    // touch the formatter when the caller actually chose a number format.
    const chosenFormat =
      display.numberFormat !== undefined && display.numberFormat !== 'auto'
    const chosenDecimals = typeof display.decimals === 'number'
    if (label.formatter === undefined && (chosenFormat || chosenDecimals)) {
      label.formatter = (value: number): string => fmt(value)
    }
    if (Object.keys(label).length > 0) axis.axisLabel = label
  }

  if (primaryValueAxis) {
    if (display.yMin !== undefined && display.yMin !== null) primaryValueAxis.min = display.yMin
    if (display.yMax !== undefined && display.yMax !== null) primaryValueAxis.max = display.yMax
    if (display.startAtZero === true && (display.yMin === undefined || display.yMin === null)) {
      primaryValueAxis.min = 0
    }
  }

  for (const axis of [...xAxes, ...yAxes]) {
    if (axis.type !== 'category') continue
    if (display.axisTitles === false) delete axis.name
    if (display.labelRotate !== undefined && display.labelRotate !== 'auto') {
      const label = isRecord(axis.axisLabel) ? { ...axis.axisLabel } : {}
      label.rotate = display.labelRotate
      axis.axisLabel = label
    }
  }

  // Breathing room between every axis' labels and the plot area. ECharts' 8px
  // default reads cramped, especially for the Y value labels. `margin` is the
  // distance from the label text to the axis line, so it — not `grid.left` —
  // is what separates the tick numbers from the plot (every grid here uses
  // `containLabel: true`, which lays the labels out inside `grid.left`).
  for (const axis of [...xAxes, ...yAxes]) {
    const label = isRecord(axis.axisLabel) ? { ...axis.axisLabel } : {}
    if (label.margin === undefined) label.margin = 16
    axis.axisLabel = label
  }

  // Custom axis titles, applied last so they override the built-in names.
  // Only the category X axis gets a custom title (scatter's numeric X keeps its
  // built-in name), and nameLocation 'middle' centres it along the axis.
  if (xTitleText) {
    const categoryAxis = xAxes.find((axis) => axis.type === 'category')
    if (categoryAxis) {
      categoryAxis.name = xTitleText
      categoryAxis.nameLocation = 'middle'
      // Sit below the rotated category labels rather than over them.
      categoryAxis.nameGap = 34
    }
  }

  if (yTitleText && primaryValueAxis) {
    primaryValueAxis.name = yTitleText
    primaryValueAxis.nameLocation = 'middle'
    // ECharts' 15px default puts the rotated title on top of the tick numbers
    // (they sit `axisLabel.margin` from the axis line). Clear them.
    primaryValueAxis.nameGap = 48
  }

  // The secondary axis is the value axis parked on the right; fall back to a
  // second value axis (e.g. Pareto's cumulative %) when no right axis exists.
  const secondaryValueAxis =
    yAxes.find((axis) => axis.position === 'right' && axis.type === 'value') ??
    (yAxes[1]?.type === 'value' ? yAxes[1] : valueAxes[1])
  if (y2TitleText && secondaryValueAxis && secondaryValueAxis !== primaryValueAxis) {
    secondaryValueAxis.name = y2TitleText
    secondaryValueAxis.nameLocation = 'middle'
    secondaryValueAxis.nameGap = 48
  }

  // Series-level appearance -------------------------------------------------
  const hasSeries = display.hasSeries === true
  for (const series of toArray(opt.series as OptionRecord | OptionRecord[])) {
    if (!isRecord(series)) continue
    const type = typeof series.type === 'string' ? series.type : ''
    const silent = series.silent === true

    if (type === 'line' || type === 'scatter') {
      const shape = display.markerShape
      if (shape !== undefined && shape !== 'auto') {
        series.symbol = shape
        // The 4px default symbol is too small to read a non-circular glyph, so
        // bump lines to a legible size unless the type sized its own symbols.
        if (type === 'line' && shape !== 'none' && series.symbolSize === undefined) {
          series.symbolSize = 8
        }
      }
    }

    if (type === 'line') {
      if (display.smooth !== undefined && display.smooth !== 'auto') series.smooth = display.smooth
      if (display.markers === false) series.showSymbol = false
      if (display.lineWidth !== undefined) {
        series.lineStyle = {
          ...(isRecord(series.lineStyle) ? series.lineStyle : {}),
          width: display.lineWidth,
        }
      }
    } else if (type === 'scatter' && display.markers === false) {
      series.showSymbol = false
    }

    if (display.dataLabels === false) {
      if (!silent && type !== 'radar') {
        series.label = { ...(isRecord(series.label) ? series.label : {}), show: false }
      }
    } else if (display.dataLabels === true) {
      // Sankey labels are node names (custom formatter would blank them) and a
      // 'custom' overlay carries no datum of its own.
      if (!silent && type !== 'radar' && type !== 'gauge' && type !== 'sankey' && type !== 'custom') {
        series.label = {
          show: true,
          position: labelPositionFor(type, display.labelPosition),
          formatter: labelFormatter(type, fmt),
        }
      }
    }

    // Single-series color override (no color-by breakdown).
    const colorable =
      type === 'bar' ||
      type === 'line' ||
      type === 'scatter' ||
      type === 'pie' ||
      type === 'heatmap' ||
      type === 'funnel' ||
      type === 'treemap' ||
      type === 'gauge'
    if (display.customColor && !hasSeries && !silent && colorable) {
      if (type === 'line') {
        series.lineStyle = { ...(isRecord(series.lineStyle) ? series.lineStyle : {}), color: display.customColor }
      }
      series.itemStyle = { ...(isRecord(series.itemStyle) ? series.itemStyle : {}), color: display.customColor }
    }

    // Per-series overrides keyed by Y / Y2 column. Applied last so a single
    // column can be tuned while the chart-wide settings keep applying to the
    // rest. Skipped when a color-by breakdown is active: series then map to
    // categories, not columns.
    if (!hasSeries && !silent) {
      const style = seriesStyleFor(series.name, display.seriesStyles)
      if (style) {
        const isLine = type === 'line'
        const lineLike = isLine || type === 'scatter'

        if (style.color) {
          series.itemStyle = { ...(isRecord(series.itemStyle) ? series.itemStyle : {}), color: style.color }
          if (isLine) {
            series.lineStyle = { ...(isRecord(series.lineStyle) ? series.lineStyle : {}), color: style.color }
          }
        }

        if (isLine) {
          if (style.lineType && style.lineType !== 'auto') {
            series.lineStyle = { ...(isRecord(series.lineStyle) ? series.lineStyle : {}), type: style.lineType }
          }
          if (style.lineWidth !== undefined && style.lineWidth !== 'auto') {
            series.lineStyle = { ...(isRecord(series.lineStyle) ? series.lineStyle : {}), width: style.lineWidth }
          }
          if (style.smooth !== undefined && style.smooth !== 'auto') series.smooth = style.smooth
        }

        if (lineLike && style.markers !== undefined && style.markers !== 'auto') {
          series.showSymbol = style.markers
        }

        const shapeOverride =
          style.markerShape && style.markerShape !== 'auto' ? style.markerShape : undefined
        if (lineLike) {
          if (shapeOverride) {
            series.symbol = shapeOverride
            // Match the global rule: a legible glyph for lines unless sized.
            if (isLine && shapeOverride !== 'none' && series.symbolSize === undefined) {
              series.symbolSize = 8
            }
          } else if (style.markers === true && series.symbol === 'none') {
            // Markers re-enabled per series while the global shape was 'none'.
            series.symbol = 'circle'
          }
        }
      }
    }
  }

  // Gauge's scalar readout lives on the series detail, not an axis. ----------
  if (chartType === 'gauge') {
    for (const series of toArray(opt.series as OptionRecord | OptionRecord[])) {
      if (!isRecord(series) || !isRecord(series.detail)) continue
      series.detail = { ...series.detail, formatter: (value: number): string => fmt(value) }
    }
  }

  return option
}

/**
 * Build an ECharts option from aggregated chart data. Used by the ChartsPanel
 * so charts render consistently. Returns null when there is no data to draw.
 */
export function buildChartOption(
  chartType: ChartType,
  x: string,
  y: string | string[],
  data: ChartDataResponse | null,
  aiOption?: EChartsOption | null,
  display?: ChartDisplayOptions,
): EChartsOption | null {
  // An AI-generated option always takes precedence over the built-in builder.
  if (aiOption) return aiOption
  if (!data || data.series.length === 0) return null
  // KPI charts render as big-number cards in ChartsPanel, not ECharts.
  if (chartType === 'kpi') return null
  const labels = data.labels
  const first = data.series[0]
  const rotate = labels.length > 8 ? 30 : 0
  // Long category lists get a zoom slider instead of unreadable labels.
  const manyLabels = labels.length > 30
  const zoom = manyLabels
    ? ([
        { type: 'inside' },
        { type: 'slider', height: 20, bottom: 10 },
      ] as EChartsOption['dataZoom'])
    : undefined
  const gridBottom = manyLabels ? 48 : 16
  const fmt = makeValueFormatter(display)

  let option: EChartsOption | null = null

  if (
    chartType === 'trend' ||
    chartType === 'stepline' ||
    chartType === 'area' ||
    chartType === 'stackarea'
  ) {
    // With a color-by breakdown, tooltip lines show the Y metric instead of
    // the breakdown value; the X category is the tooltip header.
    const yName = (Array.isArray(y) ? y[0] : y) || data.series[0]?.name || 'Value'
    // "area"/"stackarea" always fill beneath the line; "trend" exposes it as a toggle.
    const fillArea = chartType === 'area' || chartType === 'stackarea' || !!display?.area
    const stacked = chartType === 'stackarea'
    const step = chartType === 'stepline' ? ('middle' as const) : false
    // Secondary (Y2) columns get their own right-hand value axis.
    const secondary = secondaryNames(data)
    const isSecondary = (name: string) => secondary.includes(name)
    const primary = data.series.filter((s) => !isSecondary(s.name))
    const secondarySeries = data.series.filter((s) => isSecondary(s.name))
    const hasSecondary = secondarySeries.length > 0
    const yAxis: EChartsOption['yAxis'] = hasSecondary
      ? [
          { type: 'value', name: primary[0]?.name, position: 'left' },
          { type: 'value', name: secondarySeries[0]?.name, position: 'right' },
        ]
      : { type: 'value' }
    option = {
      tooltip: display?.hasSeries ? yMetricTooltip(yName, fmt) : { trigger: 'axis' },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 16, right: 16, top: 40, bottom: gridBottom, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { rotate },
      },
      yAxis,
      dataZoom: zoom,
      series: [...primary, ...secondarySeries].map((s) => ({
        name: s.name,
        type: 'line',
        data: s.data,
        smooth: !step,
        step,
        ...(hasSecondary && isSecondary(s.name) ? { yAxisIndex: 1 } : {}),
        // Only the primary lines stack; the secondary axis has its own scale.
        ...(stacked && !isSecondary(s.name) ? { stack: 'total' } : {}),
        // Area fill is a display-only toggle (single-series looks best).
        ...(fillArea ? { areaStyle: { opacity: 0.15 } } : {}),
      })),
    }
  } else if (chartType === 'pareto') {
    const barData = first.data as number[]
    const cumulativePct = Array.isArray(data.extra?.cumulative_pct)
      ? (data.extra!.cumulative_pct as number[])
      : barData.map((_, i) => {
          const total = barData.reduce((a, b) => a + b, 0)
          return total === 0 ? 0 : (barData.slice(0, i + 1).reduce((a, b) => a + b, 0) / total) * 100
        })
    option = {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 16, right: 48, top: 40, bottom: gridBottom, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { rotate },
      },
      yAxis: [
        { type: 'value', name: first.name },
        { type: 'value', name: 'Cumulative %', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      ],
      dataZoom: zoom,
      series: [
        { name: first.name, type: 'bar', data: first.data, barMaxWidth: 40 },
        {
          name: 'Cumulative %',
          type: 'line',
          yAxisIndex: 1,
          data: cumulativePct,
          smooth: true,
          symbol: 'circle',
          lineStyle: { width: 2 },
        },
      ],
    }
  } else if (chartType === 'histogram') {
    option = {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 16, right: 16, top: 40, bottom: gridBottom, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { rotate },
      },
      yAxis: { type: 'value' },
      series: data.series.map((s) => ({
        name: s.name,
        type: 'bar',
        data: s.data,
        barMaxWidth: 48,
      })),
    }
  } else if (chartType === 'bar' || chartType === 'stackbar') {
    const isStackbar = chartType === 'stackbar'
    const mode = isStackbar ? 'stacked' : (display?.barMode ?? 'grouped')
    const stackOn = isStackbar || (!!display?.hasSeries && mode !== 'grouped')
    // Secondary (Y2) columns draw as lines on the opposite value axis.
    const secondary = secondaryNames(data)
    const isSecondary = (name: string) => secondary.includes(name)
    const primary = data.series.filter((s) => !isSecondary(s.name))
    const secondarySeries = data.series.filter((s) => isSecondary(s.name))
    const hasSecondary = secondarySeries.length > 0
    let seriesData = primary.map((s) => (s.data as number[]).map((v) => Number(v) || 0))
    // 100% stacked: rescale each category to its own total.
    if (stackOn && mode === 'percent') {
      const totals = labels.map((_, i) =>
        seriesData.reduce((acc, arr) => acc + (Number(arr[i]) || 0), 0),
      )
      seriesData = seriesData.map((arr) =>
        arr.map((v, i) => (totals[i] === 0 ? 0 : (v / totals[i]) * 100)),
      )
    }
    // Plain axis literals (not EChartsOption['xAxis'] / ['yAxis']) so the same
    // value-axis object can sit on either axis when bars go horizontal.
    const valueAxis = {
      type: 'value' as const,
      ...(stackOn && mode === 'percent'
        ? { max: 100, axisLabel: { formatter: '{value}%' } }
        : {}),
    }
    // Vertical bars put the second value axis on the right; horizontal bars
    // put it on top, mirroring the primary axis.
    const secondaryAxis = {
      type: 'value' as const,
      name: secondarySeries[0]?.name,
      position: (display?.horizontal ? 'top' : 'right') as 'top' | 'right',
    }
    const categoryAxis = {
      type: 'category' as const,
      data: labels,
      axisLabel: { rotate: display?.horizontal ? 0 : rotate },
    }
    // Horizontal bars: category axis on Y (first category on top).
    const axes = display?.horizontal
      ? {
          xAxis: hasSecondary ? [valueAxis, secondaryAxis] : valueAxis,
          yAxis: { ...categoryAxis, inverse: true },
        }
      : {
          xAxis: categoryAxis,
          yAxis: hasSecondary ? [valueAxis, secondaryAxis] : valueAxis,
        }
    const yName = (Array.isArray(y) ? y[0] : y) || data.series[0]?.name || 'Value'
    option = {
      tooltip: display?.hasSeries
        ? yMetricTooltip(yName, fmt, stackOn && mode === 'percent' ? '%' : '')
        : { trigger: 'axis' },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 16, right: 16, top: 40, bottom: display?.horizontal ? 16 : gridBottom, containLabel: true },
      ...axes,
      dataZoom: display?.horizontal ? undefined : zoom,
      series: [
        ...primary.map((s, i) => ({
          name: s.name,
          type: 'bar' as const,
          data: seriesData[i],
          barMaxWidth: 40,
          ...(stackOn ? { stack: 'total' } : {}),
        })),
        ...secondarySeries.map((s) => ({
          name: s.name,
          type: 'line' as const,
          data: s.data,
          smooth: true,
          ...(display?.horizontal ? { xAxisIndex: 1 } : { yAxisIndex: 1 }),
        })),
      ],
    }
  } else if (chartType === 'pie' || chartType === 'doughnut' || chartType === 'rose') {
    const items = labels.map((label, index) => ({
      name: String(label),
      value: Number(first.data[index] ?? 0),
    }))
    // A doughnut just opens up the pie centre; a rose / Nightingale chart
    // varies each slice's radius by value instead of only its angle.
    const radius = chartType === 'doughnut' ? ['45%', '70%'] : ['35%', '65%']
    option = {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { top: 0, type: 'scroll' },
      series: [
        {
          name: first.name,
          type: 'pie',
          radius,
          center: ['50%', '55%'],
          ...(chartType === 'rose' ? { roseType: 'radius' as const } : {}),
          data: items,
        },
      ],
    }
  } else if (chartType === 'box') {
    option = {
      tooltip: { trigger: 'item' },
      grid: { left: 16, right: 16, top: 40, bottom: 16, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate } },
      yAxis: { type: 'value' },
      series: data.series.map((s) => ({
        name: s.name,
        type: 'boxplot',
        data: s.data as number[][],
        itemStyle: { color: 'rgba(63, 133, 250, 0.35)' },
      })),
    }
  } else if (chartType === 'combo') {
    // Primary Y columns draw as bars on the left axis; secondary (y2) as lines
    // on the right axis. The aggregation layer tags secondary series in extra.
    const tagged = secondaryNames(data)
    const isSecondary = (name: string) => tagged.includes(name)
    const bars = data.series.filter((s) => !isSecondary(s.name))
    const lines = data.series.filter((s) => isSecondary(s.name))
    const leftName = bars[0]?.name ?? (Array.isArray(y) ? y[0] : y) ?? 'Value'
    const rightName = lines[0]?.name ?? 'Secondary'
    option = {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 16, right: 16, top: 40, bottom: gridBottom, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { rotate },
      },
      yAxis: [
        { type: 'value', name: leftName },
        { type: 'value', name: rightName },
      ],
      dataZoom: zoom,
      series: [
        ...bars.map((s) => ({
          name: s.name,
          type: 'bar' as const,
          data: s.data,
          barMaxWidth: 40,
        })),
        ...lines.map((s) => ({
          name: s.name,
          type: 'line' as const,
          yAxisIndex: 1,
          data: s.data,
          smooth: true,
        })),
      ],
    }
  } else if (chartType === 'radar') {
    // Each Y column becomes a radar dimension; each X category becomes one
    // polygon whose values are that category's aggregate across dimensions.
    const indicators = data.series.map((s) => {
      const vals = (s.data as number[]).map((v) => Number(v) || 0)
      const max = vals.length ? Math.max(...vals) : 0
      return { name: s.name, max: max === 0 ? 1 : Math.ceil(max * 1.2) }
    })
    const polygons = labels.map((label, li) => ({
      name: String(label),
      type: 'radar' as const,
      data: [indicators.map((_, ci) => Number(data.series[ci]?.data[li]) || 0)],
    }))
    option = {
      tooltip: { trigger: 'item' },
      legend: { top: 0, type: 'scroll' },
      radar: { indicator: indicators, radius: '65%' },
      series: polygons,
    }
  } else if (chartType === 'waterfall') {
    // ECharts has no native waterfall: a transparent "base" bar is stacked
    // under a visible "delta" bar so each column floats at its running total.
    const values = labels.map((_, i) => Number(first.data[i]) || 0)
    const base: number[] = []
    const deltas: number[] = []
    const totals: number[] = []
    let running = 0
    for (const v of values) {
      const next = running + v
      base.push(Math.min(running, next))
      deltas.push(Math.abs(v))
      totals.push(next)
      running = next
    }
    option = {
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown): string => {
          const list = (Array.isArray(params) ? params : [params]) as TooltipParam[]
          const head = list[0]
          const header = head ? String(head.axisValueLabel ?? head.axisValue ?? '') : ''
          const idx = head?.dataIndex ?? 0
          const v = values[idx] ?? 0
          const sign = v >= 0 ? '+' : '-'
          return [
            header,
            `Change: ${sign}${fmt(Math.abs(v))}`,
            `Running: ${fmt(totals[idx] ?? 0)}`,
          ]
            .filter(Boolean)
            .join('<br/>')
        },
      },
      grid: { left: 16, right: 16, top: 24, bottom: gridBottom, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate } },
      yAxis: { type: 'value' },
      dataZoom: zoom,
      series: [
        {
          name: 'Base',
          type: 'bar',
          stack: 'waterfall',
          silent: true,
          itemStyle: { color: 'transparent' },
          emphasis: { itemStyle: { color: 'transparent' } },
          data: base,
        },
        {
          name: first.name,
          type: 'bar',
          stack: 'waterfall',
          barMaxWidth: 40,
          itemStyle: {
            color: (params: { dataIndex?: number }) =>
              (values[params.dataIndex ?? 0] ?? 0) < 0 ? '#e15759' : '#4c9f70',
          },
          data: deltas,
        },
      ],
    }
  } else if (chartType === 'funnel') {
    const items = labels.map((label, index) => ({
      name: String(label),
      // Funnel widths are relative, so negative aggregates have no meaning.
      value: Math.max(0, Number(first.data[index]) || 0),
    }))
    option = {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { top: 0, type: 'scroll' },
      series: [
        {
          name: first.name,
          type: 'funnel',
          left: '8%',
          right: '8%',
          top: 48,
          bottom: 16,
          minSize: '0%',
          maxSize: '100%',
          sort: 'descending',
          gap: 2,
          label: { show: true, position: 'inside' },
          data: items,
        },
      ],
    }
  } else if (chartType === 'treemap') {
    const items = labels.map((label, index) => ({
      name: String(label),
      value: Math.max(0, Number(first.data[index]) || 0),
    }))
    option = {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [
        {
          name: first.name,
          type: 'treemap',
          top: 8,
          left: 8,
          right: 8,
          bottom: 8,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          label: { show: true, formatter: '{b}' },
          data: items,
        },
      ],
    }
  } else if (chartType === 'heatmap') {
    // X categories are the columns, each Y column is a row band, and the cell
    // holds that column's aggregate for the category.
    const rowNames = data.series.map((s) => s.name)
    const points: [number, number, number][] = []
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    data.series.forEach((s, si) => {
      ;(s.data as (number | null)[]).forEach((raw, xi) => {
        if (raw === null || raw === undefined) return
        const v = Number(raw)
        if (!Number.isFinite(v)) return
        points.push([xi, si, v])
        if (v < min) min = v
        if (v > max) max = v
      })
    })
    if (points.length === 0) return null
    // A flat matrix would collapse the visualMap gradient into a single colour.
    if (min === max) {
      min -= 1
      max += 1
    }
    option = {
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown): string => {
          const p = (Array.isArray(params) ? params[0] : params) as TooltipParam | undefined
          const v = p?.value
          if (!Array.isArray(v)) return ''
          const [xi, yi, cell] = v as [number, number, number]
          return `${labels[xi]}<br/>${rowNames[yi]}: ${fmt(Number(cell))}`
        },
      },
      grid: { left: 16, right: 16, top: 16, bottom: 56, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate }, splitArea: { show: true } },
      yAxis: { type: 'category', data: rowNames, splitArea: { show: true } },
      visualMap: {
        min,
        max,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: { color: ['#e8f3ff', '#5b9bd5', '#1f4e79'] },
      },
      series: [
        {
          name: first?.name ?? 'Value',
          type: 'heatmap',
          data: points,
          label: { show: labels.length <= 12 && rowNames.length <= 12 },
          emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0, 0, 0, 0.4)' } },
        },
      ],
    }
  } else if (chartType === 'gauge') {
    const value = Number(first.data[0]) || 0
    const min = Math.min(0, value)
    const max = Math.max(min + 1, value * 1.25, 1)
    option = {
      tooltip: { formatter: '{b}: {c}' },
      series: [
        {
          name: first.name,
          type: 'gauge',
          min,
          max,
          startAngle: 210,
          endAngle: -30,
          progress: { show: true, width: 18 },
          axisLine: { lineStyle: { width: 18 } },
          axisTick: { show: false },
          splitLine: { length: 12 },
          axisLabel: { distance: 18, fontSize: 11 },
          pointer: { width: 5 },
          detail: {
            valueAnimation: true,
            fontSize: 26,
            offsetCenter: [0, '70%'],
            formatter: (v: number) => fmt(v),
          },
          data: [{ value, name: first.name }],
        },
      ],
    }
  } else if (chartType === 'bubble') {
    // [x, y, size] triples. The size scale is shared across every series so the
    // bubbles stay comparable; an empty size column yields a constant marker.
    const yName = Array.isArray(y) ? y.join(', ') : y
    const hasSize = data.extra?.has_size === true
    const sizeName = typeof data.extra?.size_name === 'string' ? (data.extra!.size_name as string) : ''
    let minSize = Number.POSITIVE_INFINITY
    let maxSize = Number.NEGATIVE_INFINITY
    if (hasSize) {
      for (const s of data.series) {
        for (const point of s.data as number[][]) {
          const v = Number(point?.[2])
          if (!Number.isFinite(v)) continue
          if (v < minSize) minSize = v
          if (v > maxSize) maxSize = v
        }
      }
    }
    const symbolSize = (value: unknown): number => {
      if (!Array.isArray(value)) return 12
      return hasSize ? bubblePixels(Number(value[2]), minSize, maxSize) : 14
    }
    option = {
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown): string => {
          const p = (Array.isArray(params) ? params[0] : params) as TooltipParam | undefined
          const v = p?.value
          if (!Array.isArray(v)) return ''
          const [xv, yv, zv] = v as number[]
          const lines = [`${x}: ${fmt(xv)}`, `${yName}: ${fmt(yv)}`]
          if (hasSize && sizeName) lines.push(`${sizeName}: ${fmt(zv)}`)
          return lines.join('<br/>')
        },
      },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 16, right: 16, top: 40, bottom: 16, containLabel: true },
      xAxis: { type: 'value', name: x },
      yAxis: { type: 'value', name: yName },
      series: data.series.map((s) => ({
        name: `${s.name} vs ${x}`,
        type: 'scatter',
        data: s.data as number[][],
        symbolSize,
      })),
    } as EChartsOption
  } else if (chartType === 'trendline') {
    // Scatter markers plus a dashed least-squares line per series (extra.fits).
    const yName = Array.isArray(y) ? y.join(', ') : y
    const fits = (isRecord(data.extra?.fits) ? data.extra!.fits : {}) as Record<
      string,
      { slope?: number; intercept?: number; r2?: number }
    >
    const series: OptionRecord[] = data.series.map((s) => ({
      name: `${s.name} vs ${x}`,
      type: 'scatter',
      data: s.data as number[][],
      symbolSize: 8,
    }))
    for (const s of data.series) {
      const fit = fits[s.name]
      if (!fit || typeof fit.slope !== 'number' || typeof fit.intercept !== 'number') continue
      const points = (s.data as number[][]).filter((p) => Array.isArray(p) && p.length >= 2)
      if (points.length === 0) continue
      let minX = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      for (const p of points) {
        if (p[0] < minX) minX = p[0]
        if (p[0] > maxX) maxX = p[0]
      }
      const yAt = (xv: number): number => fit.slope! * xv + fit.intercept!
      const r2 = typeof fit.r2 === 'number' ? fit.r2 : 0
      series.push({
        name: `${s.name} (R²=${r2.toFixed(2)})`,
        type: 'line',
        data: [
          [minX, yAt(minX)],
          [maxX, yAt(maxX)],
        ],
        showSymbol: false,
        smooth: false,
        lineStyle: { type: 'dashed', width: 2 },
        z: 3,
      })
    }
    option = {
      tooltip: scatterTooltip(x, yName, fmt),
      legend: { top: 0, type: 'scroll' },
      grid: { left: 16, right: 16, top: 40, bottom: 16, containLabel: true },
      xAxis: { type: 'value', name: x },
      yAxis: { type: 'value', name: yName },
      series,
    } as unknown as EChartsOption
  } else if (chartType === 'errorbar') {
    // A mean bar plus a custom overlay that draws the whisker (a vertical line
    // with two caps) between the low and high bounds carried on extra.
    const low = Array.isArray(data.extra?.error_low) ? (data.extra!.error_low as number[]) : []
    const high = Array.isArray(data.extra?.error_high) ? (data.extra!.error_high as number[]) : []
    const spreadLabel = typeof data.extra?.error_op === 'string' ? (data.extra!.error_op as string) : 'Spread'
    const whisker = '#37474f'
    const points = labels.map((_, i) => [i, low[i] ?? 0, high[i] ?? 0])
    option = {
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown): string => {
          const list = (Array.isArray(params) ? params : [params]) as TooltipParam[]
          const head = list[0]
          const header = head ? String(head.axisValueLabel ?? head.axisValue ?? '') : ''
          const idx = head?.dataIndex ?? 0
          const mean = Number(first.data[idx] ?? 0)
          const half = Math.max(0, (Number(high[idx] ?? 0) - Number(low[idx] ?? 0)) / 2)
          return [
            header,
            `Mean: ${fmt(mean)}`,
            `${spreadLabel}: ±${fmt(half)}`,
          ]
            .filter(Boolean)
            .join('<br/>')
        },
      },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 16, right: 16, top: 40, bottom: gridBottom, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate } },
      yAxis: { type: 'value', scale: true },
      dataZoom: zoom,
      series: [
        { name: first.name, type: 'bar', data: first.data, barMaxWidth: 40 },
        {
          name: spreadLabel,
          type: 'custom',
          silent: true,
          z: 3,
          dimensions: ['x', 'low', 'high'],
          encode: { x: 0, y: [1, 2] },
          data: points,
          renderItem: (_params: unknown, api: unknown) => {
            const a = api as { value: (dim: number) => number; coord: (data: number[]) => number[] }
            const xi = a.value(0)
            const lo = a.coord([xi, a.value(1)])
            const hi = a.coord([xi, a.value(2)])
            const cap = 8
            const stroke = { stroke: whisker, lineWidth: 2 }
            return {
              type: 'group',
              children: [
                { type: 'line', shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: stroke },
                { type: 'line', shape: { x1: lo[0] - cap, y1: lo[1], x2: lo[0] + cap, y2: lo[1] }, style: stroke },
                { type: 'line', shape: { x1: hi[0] - cap, y1: hi[1], x2: hi[0] + cap, y2: hi[1] }, style: stroke },
              ],
            }
          },
        },
      ],
    } as unknown as EChartsOption
  } else if (chartType === 'spc') {
    // Line with the centre line and ±3σ limits as markLines; out-of-control
    // points are flagged with a red item style (extra.ooc holds their indices).
    const cl = Number(data.extra?.cl)
    const ucl = Number(data.extra?.ucl)
    const lcl = Number(data.extra?.lcl)
    const ooc = Array.isArray(data.extra?.ooc) ? (data.extra!.ooc as number[]) : []
    const oocSet = new Set(ooc)
    const markLimit = (value: number, name: string, color: string) => ({
      yAxis: value,
      label: { formatter: `${name} ${fmt(value)}`, position: 'end' as const },
      lineStyle: { color, type: 'dashed' as const, width: 1.5 },
    })
    option = {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 16, right: 16, top: 40, bottom: gridBottom, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate } },
      yAxis: { type: 'value', scale: true },
      dataZoom: zoom,
      series: [
        {
          name: first.name,
          type: 'line',
          symbol: 'circle',
          symbolSize: 7,
          data: (first.data as (number | null)[]).map((v, i) =>
            oocSet.has(i) ? { value: v, itemStyle: { color: '#e53935' } } : v,
          ),
          markLine: {
            silent: true,
            symbol: 'none',
            data: [
              markLimit(cl, 'CL', '#546e7a'),
              markLimit(ucl, 'UCL', '#e53935'),
              markLimit(lcl, 'LCL', '#e53935'),
            ],
          },
        },
      ],
    } as unknown as EChartsOption
  } else if (chartType === 'sankey') {
    const sankey = isRecord(data.extra?.sankey) ? (data.extra!.sankey as OptionRecord) : null
    const links = Array.isArray(sankey?.links) ? (sankey!.links as OptionRecord[]) : []
    if (links.length === 0) return null
    option = {
      tooltip: { trigger: 'item', triggerOn: 'mousemove' },
      series: [
        {
          type: 'sankey',
          data: Array.isArray(sankey?.nodes) ? sankey!.nodes : [],
          links,
          emphasis: { focus: 'adjacency' },
          lineStyle: { color: 'gradient', curveness: 0.5 },
          label: { fontSize: 11 },
          left: 8,
          right: 8,
          top: 16,
          bottom: 8,
        },
      ],
    } as unknown as EChartsOption
  } else {
    // scatter: [x, y] pairs arrive pre-grouped from the aggregation layer.
    const yName = Array.isArray(y) ? y.join(', ') : y
    option = {
      tooltip: scatterTooltip(x, yName, fmt),
      grid: { left: 16, right: 16, top: 24, bottom: 16, containLabel: true },
      xAxis: { type: 'value', name: x },
      yAxis: { type: 'value', name: yName },
      series: data.series.map((s) => ({
        name: `${s.name} vs ${x}`,
        type: 'scatter',
        data: s.data as number[][],
        symbolSize: 8,
      })),
    } as EChartsOption
  }

  if (!option) return null
  return applyAppearance(option, display, chartType)
}
