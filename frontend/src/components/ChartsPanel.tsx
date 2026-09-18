import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, DragEvent as ReactDragEvent, ReactElement } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import AbcIcon from '@mui/icons-material/Abc'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import AlignVerticalBottomIcon from '@mui/icons-material/AlignVerticalBottom'
import AreaChartIcon from '@mui/icons-material/AreaChart'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BarChartIcon from '@mui/icons-material/BarChart'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import DataUsageIcon from '@mui/icons-material/DataUsage'
import DonutLargeIcon from '@mui/icons-material/DonutLarge'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import GridViewIcon from '@mui/icons-material/GridView'
import MultilineChartIcon from '@mui/icons-material/MultilineChart'
import NumbersIcon from '@mui/icons-material/Numbers'
import PieChartIcon from '@mui/icons-material/PieChart'
import RadarIcon from '@mui/icons-material/Radar'
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt'
import SpeedIcon from '@mui/icons-material/Speed'
import StackedBarChartIcon from '@mui/icons-material/StackedBarChart'
import StackedLineChartIcon from '@mui/icons-material/StackedLineChart'
import TimelineIcon from '@mui/icons-material/Timeline'
import ToggleOnIcon from '@mui/icons-material/ToggleOn'
import WaterfallChartIcon from '@mui/icons-material/WaterfallChart'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Slider from '@mui/material/Slider'
import Stack from '@mui/material/Stack'
import { alpha } from '@mui/material/styles'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type { QueryResult, QuerySource } from '../types'
import { type ChartDataResponse, type ChartOperation, type ChartType } from '../api/client'
import { COLUMN_KIND_LABELS, detectColumnKind, type ColumnKind } from '../utils/columns'
import {
  autoPickAxes,
  axisFits,
  buildChartData,
  computeKpiCards,
  DEFAULT_BINS,
  MAX_BINS,
  type ChartDisplayOptions,
  type ChartSort,
} from '../utils/chartData'
import { buildChartOption } from '../utils/chartOptions'
import {
  CATEGORICAL_OPERATIONS,
  DEFAULT_OPERATION,
  NUMERIC_Y_TYPES,
  OPERATIONS,
  SERIES_CAPABLE_TYPES,
  SINGLE_SERIES_TYPES,
} from '../utils/chartCatalog'
import FieldWell from './ChartFieldWell'

/** Every chart family the builder can render, shown as a colored icon + tooltip. */
const CHART_TYPES: { value: ChartType; label: string; icon: ReactElement; color: string }[] = [
  { value: 'bar', label: 'Bar', color: '#1e88e5', icon: <BarChartIcon /> },
  { value: 'stackbar', label: 'Stacked bar', color: '#1565c0', icon: <StackedBarChartIcon /> },
  { value: 'trend', label: 'Line', color: '#00897b', icon: <ShowChartIcon /> },
  { value: 'stepline', label: 'Step line', color: '#26c6da', icon: <TimelineIcon /> },
  { value: 'area', label: 'Area', color: '#43a047', icon: <AreaChartIcon /> },
  { value: 'stackarea', label: 'Stacked area', color: '#2e7d32', icon: <StackedLineChartIcon /> },
  { value: 'combo', label: 'Combo (bar + line)', color: '#5e35b1', icon: <MultilineChartIcon /> },
  { value: 'pie', label: 'Pie', color: '#fb8c00', icon: <PieChartIcon /> },
  { value: 'doughnut', label: 'Doughnut', color: '#f4511e', icon: <DonutLargeIcon /> },
  { value: 'rose', label: 'Rose', color: '#e53935', icon: <DataUsageIcon /> },
  { value: 'radar', label: 'Radar', color: '#d81b60', icon: <RadarIcon /> },
  { value: 'pareto', label: 'Pareto', color: '#8e24aa', icon: <AlignVerticalBottomIcon /> },
  { value: 'waterfall', label: 'Waterfall', color: '#00838f', icon: <WaterfallChartIcon /> },
  { value: 'funnel', label: 'Funnel', color: '#f9a825', icon: <FilterAltIcon /> },
  { value: 'treemap', label: 'Treemap', color: '#6d4c41', icon: <AccountTreeIcon /> },
  { value: 'heatmap', label: 'Heatmap', color: '#ef6c00', icon: <GridViewIcon /> },
  { value: 'histogram', label: 'Histogram', color: '#3949ab', icon: <SignalCellularAltIcon /> },
  { value: 'box', label: 'Box plot', color: '#546e7a', icon: <CandlestickChartIcon /> },
  { value: 'scatter', label: 'Scatter', color: '#7cb342', icon: <ScatterPlotIcon /> },
  { value: 'gauge', label: 'Gauge', color: '#0288d1', icon: <SpeedIcon /> },
]

/** Sorts offered for the aggregated categories. */
const SORT_OPTIONS: { value: ChartSort; label: string }[] = [
  { value: 'none', label: 'Original order' },
  { value: 'value_desc', label: 'Value (high → low)' },
  { value: 'value_asc', label: 'Value (low → high)' },
  { value: 'label_asc', label: 'Label (A → Z)' },
  { value: 'label_desc', label: 'Label (Z → A)' },
]

const TOPN_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'All categories' },
  { value: 5, label: 'Top 5' },
  { value: 10, label: 'Top 10' },
  { value: 15, label: 'Top 15' },
  { value: 20, label: 'Top 20' },
]

/** Chart types that render categories on the X axis with a sortable / top-N breakdown. */
const AGGREGATE_SORTABLE_TYPES: ChartType[] = [
  'bar',
  'stackbar',
  'pie',
  'doughnut',
  'rose',
  'combo',
  'waterfall',
  'funnel',
  'treemap',
  'heatmap',
]

/** Line-like families where raw (un-aggregated) Y values are meaningful. */
const LINE_TYPES: ChartType[] = ['trend', 'stepline', 'area', 'stackarea', 'scatter']

/** Types that aggregate a single measure and need no X category. */
const NO_X_AXIS_TYPES: ChartType[] = ['histogram', 'kpi', 'gauge']

/** Order the field list groups its columns in. */
const KIND_ORDER: ColumnKind[] = ['number', 'text', 'date', 'boolean']

/** Chips carry the field's detected kind at a glance, like PyGWalker's types. */
const KIND_ICONS: Record<ColumnKind, ReactElement> = {
  number: <NumbersIcon fontSize="small" />,
  text: <AbcIcon fontSize="small" />,
  date: <CalendarMonthIcon fontSize="small" />,
  boolean: <ToggleOnIcon fontSize="small" />,
}

const KIND_CHIP_COLOR: Record<ColumnKind, 'primary' | 'default' | 'secondary' | 'info'> = {
  number: 'primary',
  text: 'default',
  date: 'secondary',
  boolean: 'info',
}

interface ChartsPanelProps {
  source: QuerySource
  result: QueryResult
  /** Optional chart configuration pushed in from outside (e.g. an analysis template). */
  preset?: { chartType?: ChartType; x?: string; y?: string; nonce: number } | null
  /** Externally generated ECharts option (e.g. from the AI chart assistant). */
  aiOption?: { option: EChartsOption; nonce: number } | null
  /** Called when the user takes over with the manual chart builder. */
  onClearAi?: () => void
  /** Opens the AI chart assistant dialog. */
  onAiChart?: () => void
  /** Disables the AI chart button (e.g. while an upload is in progress). */
  aiDisabled?: boolean
}

export default function ChartsPanel({
  result,
  preset,
  aiOption,
  onClearAi,
  onAiChart,
  aiDisabled,
}: ChartsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  // Tracks the last Y-column toggle so a fast double-click doesn't immediately
  // reverse the selection (which made the dropdown feel "too sensitive").
  const lastYToggle = useRef<{ name: string; at: number }>({ name: '', at: 0 })
  const lastY2Toggle = useRef<{ name: string; at: number }>({ name: '', at: 0 })
  const [chartReady, setChartReady] = useState(false)

  const [chartType, setChartType] = useState<ChartType>('bar')
  const [x, setX] = useState('')
  const [y, setY] = useState<string[]>([])
  const [operation, setOperation] = useState<ChartOperation>('sum')
  const [series, setSeries] = useState('')
  const [sort, setSort] = useState<ChartSort>('none')
  const [topN, setTopN] = useState(0)
  const [bins, setBins] = useState(DEFAULT_BINS)
  const [barMode, setBarMode] = useState<'grouped' | 'stacked' | 'percent'>('grouped')
  const [horizontal, setHorizontal] = useState(false)
  const [area, setArea] = useState(false)
  // Secondary-axis column(s) for combo charts (drawn as lines on the right axis).
  const [y2, setY2] = useState<string[]>([])
  // Aggregation applied to the secondary (right) axis of combo charts.
  const [y2Operation, setY2Operation] = useState<ChartOperation>('sum')

  // The draggable column list starts open but can be collapsed to give the
  // chart more room on small screens.
  const [fieldsOpen, setFieldsOpen] = useState(true)

  // The chart type picker + X/Y shelves can be collapsed the same way.
  const [setupOpen, setSetupOpen] = useState(true)

  /** Auto-detected data kind for each column (Number / Text / Boolean / Date). */
  const columnKinds = useMemo(() => {
    const map: Record<string, ColumnKind> = {}
    for (const c of result.columns) map[c.name] = detectColumnKind(c.name, c.type, result.rows)
    return map
  }, [result])

  /** The field list, grouped by detected kind like PyGWalker's data pane. */
  const fieldsByKind = useMemo(() => {
    const map: Record<ColumnKind, string[]> = { number: [], text: [], date: [], boolean: [] }
    for (const c of result.columns) map[columnKinds[c.name]].push(c.name)
    return map
  }, [result, columnKinds])

  /** Makes a field chip draggable onto a shelf. */
  const dragProps = (name: string) => ({
    draggable: true,
    onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
      event.dataTransfer.setData('text/plain', name)
      event.dataTransfer.effectAllowed = 'copy'
    },
  })

  /** True when the current X / Y selection satisfies the chart type's data-type needs. */
  const fits = (type: ChartType, xv: string, yv: string[]): boolean =>
    axisFits(type, xv, yv, columnKinds, y2.length > 0)

  // Smart defaults whenever the chart type changes: columns that no longer fit
  // the type's data requirements are re-picked automatically (e.g. scatter
  // gets a numeric X + numeric Y, trend gets a date X).
  const handleChartType = (value: ChartType) => {
    if (value === chartType) return
    onClearAi?.()
    setChartType(value)
    if (value !== 'trend' && value !== 'area') setArea(false)
    if (value !== 'bar' && value !== 'stackbar') {
      setHorizontal(false)
      setBarMode('grouped')
    }
    if (!AGGREGATE_SORTABLE_TYPES.includes(value)) {
      setSort('none')
      setTopN(0)
    }
    // Single-series families (pie / doughnut / rose / funnel / treemap / gauge /
    // pareto) only ever draw one measure.
    if (SINGLE_SERIES_TYPES.includes(value)) setY((cur) => cur.slice(0, 1))
    if (value !== 'combo') setY2([])
    if (!fits(value, x, y)) {
      const picked = autoPickAxes(value, result.columns, columnKinds, result.rows)
      setX(picked.x)
      setY(picked.y)
    }
    // Combo needs a secondary column to draw its line series.
    if (value === 'combo' && y2.length === 0) {
      const numericCols = result.columns.filter((c) => columnKinds[c.name] === 'number')
      const candidate = numericCols.find((c) => c.name !== x && !y.includes(c.name))?.name ?? ''
      if (candidate) setY2([candidate])
    }
  }

  // Persist the chart configuration across query re-runs: keep chartType,
  // x, y and operation, and only re-pick columns that no longer exist in
  // the new result set.
  useEffect(() => {
    const validY = y.filter((col) => result.columns.some((c) => c.name === col))
    if (fits(chartType, x, validY)) {
      if (validY.length !== y.length) setY(validY)
    } else {
      const picked = autoPickAxes(chartType, result.columns, columnKinds, result.rows)
      setX(picked.x)
      setY(picked.y)
    }
    if (series && !result.columns.some((c) => c.name === series)) setSeries('')
    const validY2 = y2.filter((col) => result.columns.some((c) => c.name === col))
    if (validY2.length !== y2.length) setY2(validY2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  // Apply an externally-provided chart configuration (best-effort: only use
  // keys that are valid for the current result columns).
  useEffect(() => {
    if (!preset) return
    if (preset.chartType) setChartType(preset.chartType)
    if (preset.x && result.columns.some((c) => c.name === preset.x)) setX(preset.x)
    if (preset.y && result.columns.some((c) => c.name === preset.y)) setY([preset.y])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset])

  const yIsNumeric = y.length > 0 && y.every((col) => columnKinds[col] === 'number')

  const availableOperations = useMemo(
    () =>
      OPERATIONS.filter((item) => {
        // Raw values are only meaningful against a numeric Y on line-ish types.
        if (item.value === 'none') {
          return yIsNumeric && LINE_TYPES.includes(chartType)
        }
        if (item.value === 'share') return yIsNumeric
        // Numeric aggregations need a numeric Y; count & distinct work on any Y.
        if (!CATEGORICAL_OPERATIONS.includes(item.value)) return yIsNumeric
        return true
      }),
    [yIsNumeric, chartType],
  )

  // The secondary axis is always numeric, so offer every aggregation except raw.
  const y2OperationOptions = useMemo(
    () => OPERATIONS.filter((item) => item.value !== 'none'),
    [],
  )

  const defaultOperationFor = (chart: ChartType, numericY: boolean): ChartOperation => {
    if (!numericY) return 'count'
    if (LINE_TYPES.includes(chart)) return 'none'
    return DEFAULT_OPERATION[chart] ?? 'sum'
  }

  // Keep the operation valid when the Y columns / chart type change.
  useEffect(() => {
    if (!availableOperations.some((item) => item.value === operation)) {
      setOperation(defaultOperationFor(chartType, yIsNumeric))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableOperations, operation])

  // Columns offered for the X axis — numeric only for scatter.
  const xColumns = useMemo(
    () =>
      chartType === 'scatter'
        ? result.columns.filter((c) => columnKinds[c.name] === 'number')
        : result.columns,
    [result, columnKinds, chartType],
  )

  // Columns offered for the Y axis — numeric only for distribution-style types.
  const yColumns = useMemo(
    () =>
      NUMERIC_Y_TYPES.includes(chartType)
        ? result.columns.filter((c) => columnKinds[c.name] === 'number')
        : result.columns,
    [result, columnKinds, chartType],
  )

  // Secondary-axis columns (combo lines) are numeric for a meaningful dual
  // axis; exclude the X axis and the primary Y columns to keep series distinct.
  const y2Columns = useMemo(
    () =>
      result.columns.filter(
        (c) => columnKinds[c.name] === 'number' && c.name !== x && !y.includes(c.name),
      ),
    [result, columnKinds, x, y],
  )

  const singleSeriesChart = SINGLE_SERIES_TYPES.includes(chartType)
  const seriesCapable = SERIES_CAPABLE_TYPES.includes(chartType)

  // Breakdown candidates: low-cardinality columns excluding the X axis.
  const seriesCandidates = useMemo(() => {
    if (!seriesCapable) return []
    return result.columns
      .filter((c) => c.name !== x)
      .filter((c) => {
        const seen = new Set<unknown>()
        for (const row of result.rows.slice(0, 300)) {
          const v = row[c.name]
          if (v !== null && v !== undefined && v !== '') seen.add(v)
        }
        const size = seen.size
        return size >= 2 && size <= 30
      })
      .map((c) => c.name)
  }, [result, x, seriesCapable])

  /** Aggregated chart data — computed synchronously, no network round-trip. */
  const data = useMemo<ChartDataResponse | null>(() => {
    if (chartType === 'kpi') return null
    return buildChartData(result.rows, {
      chartType,
      x,
      y,
      operation,
      series: seriesCapable && series ? series : undefined,
      topN,
      bins,
      sort,
      y2: chartType === 'combo' && y2.length > 0 ? y2 : undefined,
      y2Operation: chartType === 'combo' && y2.length > 0 ? y2Operation : undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, chartType, x, y, operation, series, topN, bins, sort, y2, y2Operation])

  const display = useMemo<ChartDisplayOptions>(
    () => ({
      barMode,
      horizontal,
      area,
      hasSeries: !!series && seriesCapable,
    }),
    [barMode, horizontal, area, series, seriesCapable],
  )

  const option = useMemo<EChartsOption | null>(
    () => buildChartOption(chartType, x, y, data, aiOption?.option ?? null, display),
    [chartType, x, y, data, aiOption, display],
  )

  const hasData = !!data && data.series.some((s) => (s.data as unknown[]).length > 0)

  /** KPI big-number cards. */
  const kpiCards = useMemo(
    () => (chartType === 'kpi' ? computeKpiCards(result.rows, y, operation) : []),
    [chartType, result, y, operation],
  )

  // Create / resize / dispose the ECharts instance (skipped for KPI cards).
  const showCanvas = chartType !== 'kpi'
  useEffect(() => {
    if (!showCanvas) return
    const el = containerRef.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart
    setChartReady(true)
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
      setChartReady(false)
    }
  }, [showCanvas])

  // Push the option into the chart when it changes.
  useEffect(() => {
    if (chartReady && chartRef.current && option) {
      chartRef.current.setOption(option, true)
      // The chart may have been created/resized while its tab was hidden
      // (0-sized container); force a redraw so the option is actually painted.
      chartRef.current.resize()
    }
  }, [option, chartReady])

  const missingAxes = (!NO_X_AXIS_TYPES.includes(chartType) && !x) || y.length === 0

  // Y-axis assignment. In multi-select mode choosing a column toggles it; a fast
  // double-click would toggle it on then immediately off, so we swallow a
  // same-item toggle that arrives within a short window to make it "stick".
  const handleYChoose = (name: string) => {
    const now = Date.now()
    if (name === lastYToggle.current.name && now - lastYToggle.current.at < 280) return
    lastYToggle.current = { name, at: now }
    setY((cur) => (cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name]))
  }

  /** Add a column to the Y shelf via drag-and-drop (never removes). */
  const handleYAdd = (name: string) => {
    setY((cur) => (cur.includes(name) ? cur : [...cur, name]))
  }

  /** Remove a column from the Y shelf. */
  const handleYRemove = (name: string) => {
    setY((cur) => cur.filter((v) => v !== name))
  }

  // Secondary (right) axis — same multi-select toggle behavior as Y.
  const handleY2Choose = (name: string) => {
    const now = Date.now()
    if (name === lastY2Toggle.current.name && now - lastY2Toggle.current.at < 280) return
    lastY2Toggle.current = { name, at: now }
    setY2((cur) => (cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name]))
  }

  /** Add a column to the Y2 shelf via drag-and-drop (never removes). */
  const handleY2Add = (name: string) => {
    setY2((cur) => (cur.includes(name) ? cur : [...cur, name]))
  }

  /** Remove a column from the Y2 shelf. */
  const handleY2Remove = (name: string) => {
    setY2((cur) => cur.filter((v) => v !== name))
  }

  const selectSx = { minHeight: 48 } as const

  return (
    <Stack spacing={1.5} sx={{ width: '100%' }}>
      {/* Row context banner */}
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        Charting {result.rows.length.toLocaleString()} rows
        {result.elapsed_ms ? ` · ${result.elapsed_ms} ms` : ''}
        {chartType === 'kpi' ? ' · aggregated' : ''}
      </Typography>

      {/* Two-column builder: the draggable field list sits on the left, the
          chart type picker / field shelves / display options stack on the right.
          Collapsing the field list shrinks it to a slim rail on the left so the
          chart gains the width. On phones the columns collapse into a single
          vertical stack. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            md: fieldsOpen ? '240px minmax(0, 1fr)' : '52px minmax(0, 1fr)',
          },
          gap: 1.5,
          alignItems: 'start',
        }}
      >
        {/* Column fields — draggable chips grouped by detected kind. Collapsed it
            becomes a slim rail on the left that reopens the panel on click. */}
        <Paper
          variant="outlined"
          sx={{
            width: '100%',
            position: { md: 'sticky' },
            top: { md: 8 },
            overflow: 'hidden',
          }}
        >
          {fieldsOpen ? (
            <>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', px: 1.5, minHeight: 48, cursor: 'pointer' }}
                onClick={() => setFieldsOpen(false)}
                role="button"
                aria-expanded
                aria-label="Collapse fields"
                title="Collapse fields"
              >
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                  Fields
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {result.columns.length}
                </Typography>
                <IconButton size="small" aria-hidden tabIndex={-1} sx={{ pointerEvents: 'none' }}>
                  <ChevronLeftIcon />
                </IconButton>
              </Stack>
              <Box
                sx={{
                  px: 1.5,
                  pb: 1.5,
                  maxHeight: { xs: 240, md: '60vh' },
                  overflowY: 'auto',
                }}
              >
                <Stack spacing={1.25}>
                  {KIND_ORDER.filter((kind) => fieldsByKind[kind].length > 0).map((kind) => (
                    <Box key={kind}>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 0.5 }}
                      >
                        {COLUMN_KIND_LABELS[kind]}
                      </Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                        {fieldsByKind[kind].map((name) => (
                          <Box
                            key={name}
                            {...dragProps(name)}
                            sx={{ cursor: 'grab', '&:active': { cursor: 'grabbing' } }}
                          >
                            <Chip
                              size="small"
                              variant="outlined"
                              color={KIND_CHIP_COLOR[kind]}
                              icon={KIND_ICONS[kind]}
                              label={name}
                              // The wrapper owns the drag gesture so the chip's own
                              // interactive styles don't swallow the mousedown.
                              sx={{
                                pointerEvents: 'none',
                                maxWidth: { xs: 190, md: 180 },
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
                    Drag a field onto a shelf. On a touch screen, tap + on a shelf to pick a field.
                  </Typography>
                </Stack>
              </Box>
            </>
          ) : (
            /* Collapsed: a slim rail beside the chart on desktop, a short strip
               above it on phones. Both reopen the panel when tapped. */
            <Stack
              spacing={0.5}
              onClick={() => setFieldsOpen(true)}
              role="button"
              aria-expanded={false}
              aria-label="Expand fields"
              title="Expand fields"
              sx={{
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: { xs: 48, md: 180 },
                px: { xs: 1.5, md: 0 },
                py: { xs: 0, md: 1.5 },
                cursor: 'pointer',
              }}
            >
              <ChevronRightIcon
                fontSize="small"
                sx={{ transform: { xs: 'rotate(90deg)', md: 'none' } }}
              />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  writingMode: { xs: 'horizontal-tb', md: 'vertical-rl' },
                  transform: { md: 'rotate(180deg)' },
                  letterSpacing: { md: 2 },
                }}
              >
                Fields ({result.columns.length})
              </Typography>
            </Stack>
          )}
        </Paper>

        {/* Right column — chart type picker, field shelves and display options. */}
        <Stack spacing={1.5} sx={{ minWidth: 0 }}>

      {/* Chart setup — icon picker + X/Y shelves, collapsible so the chart can
          take the full height. The active family stays visible in the header. */}
      <Stack
        direction="row"
        spacing={1}
        onClick={() => setSetupOpen((cur) => !cur)}
        role="button"
        aria-expanded={setupOpen}
        aria-label={setupOpen ? 'Collapse chart setup' : 'Expand chart setup'}
        title={setupOpen ? 'Collapse chart setup' : 'Expand chart setup'}
        sx={{ alignItems: 'center', minHeight: 40, cursor: 'pointer' }}
      >
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Chart setup
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {CHART_TYPES.find((t) => t.value === chartType)?.label ?? 'KPI cards'}
        </Typography>
        <IconButton size="small" aria-hidden tabIndex={-1} sx={{ pointerEvents: 'none' }}>
          {setupOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </Stack>

      <Collapse in={setupOpen} unmountOnExit>
        <Stack spacing={1.5} sx={{ minWidth: 0 }}>

      {/* Row 1 — chart type picker + AI action. */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        useFlexGap
        sx={{ alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}
      >
        {/* Chart type picker — every family on a single row, each icon with a
            tooltip label. On narrow screens the row scrolls sideways so the
            touch targets keep their size. */}
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'nowrap',
            gap: 0.5,
            flex: '1 1 320px',
            minWidth: 0,
            overflowX: 'auto',
            scrollbarWidth: 'thin',
          }}
        >
          {CHART_TYPES.map((type) => (
            <Tooltip key={type.value} title={type.label} arrow>
              <ToggleButton
                value={type.value}
                selected={chartType === type.value}
                onChange={() => handleChartType(type.value)}
                aria-label={type.label}
                sx={{
                  flex: '1 1 0',
                  minWidth: { xs: 48, md: 44 },
                  minHeight: 48,
                  px: 0,
                  // Each family keeps its own hue; the selected button tints its
                  // background and border with that same hue.
                  color: type.color,
                  borderColor: alpha(type.color, 0.4),
                  '&:hover': { bgcolor: alpha(type.color, 0.08) },
                  '&.Mui-selected': {
                    color: type.color,
                    bgcolor: alpha(type.color, 0.16),
                    borderColor: type.color,
                    '&:hover': { bgcolor: alpha(type.color, 0.24) },
                  },
                }}
              >
                {type.icon}
              </ToggleButton>
            </Tooltip>
          ))}
        </Box>

        <Button
          size="small"
          variant="outlined"
          color="primary"
          startIcon={<AutoAwesomeIcon />}
          onClick={onAiChart}
          disabled={aiDisabled}
          sx={{ minHeight: 48, flexShrink: 0, alignSelf: 'center', ml: { sm: 'auto' } }}
        >
          AI Chart
        </Button>
      </Stack>

      {/* Row 2 — X / Y field shelves, on their own line below the icon row. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(auto-fit, minmax(180px, 1fr))' },
          gap: 1,
          width: '100%',
        }}
      >
          {!NO_X_AXIS_TYPES.includes(chartType) && (
            <FieldWell
              label={chartType === 'scatter' ? 'X (numeric)' : 'X axis'}
              value={x ? [x] : []}
              options={xColumns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
              onChoose={setX}
              onAdd={setX}
              onRemove={() => setX('')}
              hint={chartType === 'scatter' ? 'Drop a numeric column for X' : 'Drop a column for X'}
            />
          )}
          <FieldWell
            label={NUMERIC_Y_TYPES.includes(chartType) ? 'Y (numeric)' : 'Y (primary)'}
            value={singleSeriesChart ? y.slice(0, 1) : y}
            multi={!singleSeriesChart}
            options={yColumns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
            onChoose={(name) => (singleSeriesChart ? setY([name]) : handleYChoose(name))}
            onAdd={(name) => (singleSeriesChart ? setY([name]) : handleYAdd(name))}
            onRemove={handleYRemove}
            hint={singleSeriesChart ? 'Drop a column for Y' : 'Drop columns for Y'}
          />
          {chartType === 'combo' && (
            <FieldWell
              label="Y2 (secondary)"
              value={y2}
              multi
              options={y2Columns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
              onChoose={handleY2Choose}
              onAdd={handleY2Add}
              onRemove={handleY2Remove}
              hint="Drop columns for the right axis"
            />
          )}
          {seriesCapable && seriesCandidates.length > 0 && (
            <FieldWell
              label="Color by"
              value={series ? [series] : []}
              options={seriesCandidates.map((n) => ({ name: n, kind: columnKinds[n] }))}
              onChoose={setSeries}
              onAdd={setSeries}
              onRemove={() => setSeries('')}
              hint="Drop to color by series"
            />
          )}

          {/* Aggregation — the primary Y operation always shows; combo adds a secondary.
              Uses the same caption + control layout as FieldWell so the dropdowns
              top-align with the field shelves. */}
          <Box sx={{ minWidth: { xs: '100%', sm: 180 }, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography variant="caption" color="text.secondary" noWrap>Y operation</Typography>
            <Select
              size="small"
              value={operation}
              onChange={(event: SelectChangeEvent) => setOperation(event.target.value as ChartOperation)}
              sx={{ minHeight: 48, width: '100%' }}
            >
              {availableOperations.map((item) => (
                <MenuItem key={item.value} value={item.value}>
                  {item.label}
                </MenuItem>
              ))}
            </Select>
          </Box>
          {chartType === 'combo' && (
            <Box sx={{ minWidth: { xs: '100%', sm: 180 }, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary" noWrap>Y2 operation</Typography>
              <Select
                size="small"
                value={y2Operation}
                onChange={(event: SelectChangeEvent) => setY2Operation(event.target.value as ChartOperation)}
                sx={{ minHeight: 48, width: '100%' }}
              >
                {y2OperationOptions.map((item) => (
                  <MenuItem key={item.value} value={item.value}>
                    {item.label}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          )}
        </Box>

      {/* Contextual display options + actions */}
      <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          useFlexGap
          sx={{ alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
        >
          {(chartType === 'bar' || chartType === 'stackbar') && (
            <>
              {chartType === 'bar' && !!series && (
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={barMode}
                  onChange={(_e: ReactMouseEvent<HTMLElement>, v: 'grouped' | 'stacked' | 'percent' | null) => {
                    if (v) setBarMode(v)
                  }}
                >
                  <ToggleButton value="grouped" sx={{ minHeight: 48 }}>Grouped</ToggleButton>
                  <ToggleButton value="stacked" sx={{ minHeight: 48 }}>Stacked</ToggleButton>
                  <ToggleButton value="percent" sx={{ minHeight: 48 }}>100%</ToggleButton>
                </ToggleButtonGroup>
              )}
              <ToggleButtonGroup
                exclusive
                size="small"
                value={horizontal ? 'h' : 'v'}
                onChange={(_e: ReactMouseEvent<HTMLElement>, v: string | null) => {
                  if (v) setHorizontal(v === 'h')
                }}
              >
                <ToggleButton value="v" sx={{ minHeight: 48 }}>Vertical</ToggleButton>
                <ToggleButton value="h" sx={{ minHeight: 48 }}>Horizontal</ToggleButton>
              </ToggleButtonGroup>
            </>
          )}

          {chartType === 'trend' && (
            <ToggleButtonGroup
              exclusive
              size="small"
              value={area ? 'area' : 'line'}
              onChange={(_e: ReactMouseEvent<HTMLElement>, v: string | null) => {
                if (v) setArea(v === 'area')
              }}
            >
              <ToggleButton value="line" sx={{ minHeight: 48 }}>Line</ToggleButton>
              <ToggleButton value="area" sx={{ minHeight: 48 }}>Area</ToggleButton>
            </ToggleButtonGroup>
          )}

          {AGGREGATE_SORTABLE_TYPES.includes(chartType) && (
            <>
              <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 180 } }}>
                <InputLabel id="chart-sort-label">Sort</InputLabel>
                <Select
                  labelId="chart-sort-label"
                  label="Sort"
                  value={sort}
                  onChange={(event: SelectChangeEvent) => setSort(event.target.value as ChartSort)}
                  sx={selectSx}
                >
                  {SORT_OPTIONS.map((item) => (
                    <MenuItem key={item.value} value={item.value}>
                      {item.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 160 } }}>
                <InputLabel id="chart-topn-label">Categories</InputLabel>
                <Select
                  labelId="chart-topn-label"
                  label="Categories"
                  value={String(topN)}
                  onChange={(event: SelectChangeEvent) => setTopN(Number(event.target.value))}
                  sx={selectSx}
                >
                  {TOPN_OPTIONS.map((item) => (
                    <MenuItem key={item.value} value={String(item.value)}>
                      {item.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </>
          )}

          {chartType === 'histogram' && (
            <Box sx={{ minWidth: { xs: '100%', sm: 220 }, px: { xs: 0.5, sm: 1 } }}>
              <Typography variant="caption" color="text.secondary">
                Bins: {bins}
              </Typography>
              <Slider
                size="small"
                min={2}
                max={MAX_BINS}
                step={1}
                value={bins}
                onChange={(_e, v: number | number[]) => setBins(Array.isArray(v) ? v[0] : v)}
                valueLabelDisplay="auto"
                sx={{ '& .MuiSlider-thumb': { width: 22, height: 22 } }}
              />
            </Box>
          )}

        </Stack>
        </Stack>
      </Collapse>

      {aiOption && (
        <Alert severity="info" onClose={onClearAi}>
          AI chart applied. Edit the script in the AI assistant and re-apply to update it.
        </Alert>
      )}

      {chartType === 'kpi' ? (
        kpiCards.length > 0 ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(auto-fit, minmax(180px, 1fr))' },
              gap: 1.5,
            }}
          >
            {kpiCards.map((card) => {
              const opLabel = OPERATIONS.find((o) => o.value === card.op)?.label
              return (
                <Paper
                  key={card.label}
                  variant="outlined"
                  sx={{ p: 1.5, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    sx={{ display: 'block' }}
                    title={opLabel && card.stats.length > 0 ? `${card.label} · ${opLabel}` : card.label}
                  >
                    {card.label}
                    {opLabel && card.stats.length > 0 ? ` · ${opLabel}` : ''}
                  </Typography>
                  <Typography
                    variant="h5"
                    noWrap
                    sx={{ fontWeight: 700 }}
                    title={card.formatted}
                  >
                    {card.formatted}
                  </Typography>
                  {card.stats.length > 0 && (
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                        columnGap: 1,
                        rowGap: 0.25,
                        mt: 0.5,
                      }}
                    >
                      {card.stats.map((stat) => (
                        <Box key={stat.label} sx={{ minWidth: 0 }}>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block', lineHeight: 1.2 }}
                          >
                            {stat.label}
                          </Typography>
                          <Typography variant="body2" noWrap title={stat.formatted}>
                            {stat.formatted}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Paper>
              )
            })}
          </Box>
        ) : (
          <Typography color="text.secondary">Select numeric columns to show KPI cards.</Typography>
        )
      ) : (
        <Box sx={{ position: 'relative' }}>
          <Box
            ref={containerRef}
            sx={{ height: { xs: 320, sm: 420, md: 480 }, minHeight: 300, width: '100%' }}
          />
          {!hasData && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'background.paper',
                px: 2,
                textAlign: 'center',
              }}
            >
              <Typography color="text.secondary">
                {missingAxes
                  ? NO_X_AXIS_TYPES.includes(chartType)
                    ? 'Select a numeric column to plot.'
                    : 'Select an X and Y column to build the chart.'
                  : 'No data to chart with the selected columns — try different columns or operation.'}
              </Typography>
            </Box>
          )}
        </Box>
      )}
        </Stack>
      </Box>
    </Stack>
  )
}
