import type { EChartsOption } from 'echarts'
import type { ChartDataResponse } from '../api/client'
import type { ChartType } from '../types'
import { formatCompactNumber, type ChartDisplayOptions } from './chartData'

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

/**
 * Axis tooltip for a chart with a color-by (breakdown) series. Only the X
 * category (header) and a single aggregate Y value are shown — the per-series
 * breakdown info is deliberately hidden so "color by" details never appear on
 * hover. The aggregate is the sum of every breakdown series at that X point.
 */
function yMetricTooltip(yName: string, suffix = '') {
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
      const text = list.length ? formatCompactNumber(total) + suffix : '—'
      return [header, `${yName}: ${text}`].filter(Boolean).join('<br/>')
    },
  }
}

/** Scatter tooltip showing the raw X / Y values of the hovered point. */
function scatterTooltip(xName: string, yName: string) {
  return {
    trigger: 'item' as const,
    formatter: (params: unknown): string => {
      const p = (Array.isArray(params) ? params[0] : params) as TooltipParam | undefined
      const v = p?.value
      const xv = Array.isArray(v) ? v[0] : v
      const yv = Array.isArray(v) ? v[1] : undefined
      const fmt = (n: unknown): string =>
        typeof n === 'number' && Number.isFinite(n) ? formatCompactNumber(n) : String(n ?? '—')
      return `${xName}: ${fmt(xv)}<br/>${yName}: ${fmt(yv)}`
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
    return {
      tooltip: display?.hasSeries ? yMetricTooltip(yName) : { trigger: 'axis' },
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
  }

  if (chartType === 'pareto') {
    const barData = first.data as number[]
    const cumulativePct = Array.isArray(data.extra?.cumulative_pct)
      ? (data.extra!.cumulative_pct as number[])
      : barData.map((_, i) => {
          const total = barData.reduce((a, b) => a + b, 0)
          return total === 0 ? 0 : (barData.slice(0, i + 1).reduce((a, b) => a + b, 0) / total) * 100
        })
    return {
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
  }

  if (chartType === 'histogram') {
    return {
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
  }

  if (chartType === 'bar' || chartType === 'stackbar') {
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
    return {
      tooltip: display?.hasSeries
        ? yMetricTooltip(yName, stackOn && mode === 'percent' ? '%' : '')
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
  }

  if (chartType === 'pie' || chartType === 'doughnut' || chartType === 'rose') {
    const items = labels.map((label, index) => ({
      name: String(label),
      value: Number(first.data[index] ?? 0),
    }))
    // A doughnut just opens up the pie centre; a rose / Nightingale chart
    // varies each slice's radius by value instead of only its angle.
    const radius = chartType === 'doughnut' ? ['45%', '70%'] : ['35%', '65%']
    return {
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
  }

  if (chartType === 'box') {
    return {
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
  }

  if (chartType === 'combo') {
    // Primary Y columns draw as bars on the left axis; secondary (y2) as lines
    // on the right axis. The aggregation layer tags secondary series in extra.
    const tagged = secondaryNames(data)
    const isSecondary = (name: string) => tagged.includes(name)
    const bars = data.series.filter((s) => !isSecondary(s.name))
    const lines = data.series.filter((s) => isSecondary(s.name))
    const leftName = bars[0]?.name ?? (Array.isArray(y) ? y[0] : y) ?? 'Value'
    const rightName = lines[0]?.name ?? 'Secondary'
    return {
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
  }

  if (chartType === 'radar') {
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
    return {
      tooltip: { trigger: 'item' },
      legend: { top: 0, type: 'scroll' },
      radar: { indicator: indicators, radius: '65%' },
      series: polygons,
    }
  }

  if (chartType === 'waterfall') {
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
    return {
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
            `Change: ${sign}${formatCompactNumber(Math.abs(v))}`,
            `Running: ${formatCompactNumber(totals[idx] ?? 0)}`,
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
  }

  if (chartType === 'funnel') {
    const items = labels.map((label, index) => ({
      name: String(label),
      // Funnel widths are relative, so negative aggregates have no meaning.
      value: Math.max(0, Number(first.data[index]) || 0),
    }))
    return {
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
  }

  if (chartType === 'treemap') {
    const items = labels.map((label, index) => ({
      name: String(label),
      value: Math.max(0, Number(first.data[index]) || 0),
    }))
    return {
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
  }

  if (chartType === 'heatmap') {
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
    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown): string => {
          const p = (Array.isArray(params) ? params[0] : params) as TooltipParam | undefined
          const v = p?.value
          if (!Array.isArray(v)) return ''
          const [xi, yi, cell] = v as [number, number, number]
          return `${labels[xi]}<br/>${rowNames[yi]}: ${formatCompactNumber(Number(cell))}`
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
  }

  if (chartType === 'gauge') {
    const value = Number(first.data[0]) || 0
    const min = Math.min(0, value)
    const max = Math.max(min + 1, value * 1.25, 1)
    return {
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
            formatter: (v: number) => formatCompactNumber(v),
          },
          data: [{ value, name: first.name }],
        },
      ],
    }
  }

  // scatter: [x, y] pairs arrive pre-grouped from the aggregation layer.
  const yName = Array.isArray(y) ? y.join(', ') : y
  return {
    tooltip: scatterTooltip(x, yName),
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
