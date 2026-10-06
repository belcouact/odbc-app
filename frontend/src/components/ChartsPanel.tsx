import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent as ReactChangeEvent,
  MouseEvent as ReactMouseEvent,
  DragEvent as ReactDragEvent,
  ReactElement,
} from 'react'
import type { EChartsOption } from 'echarts'
import AbcIcon from '@mui/icons-material/Abc'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import AlignVerticalBottomIcon from '@mui/icons-material/AlignVerticalBottom'
import AreaChartIcon from '@mui/icons-material/AreaChart'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BarChartIcon from '@mui/icons-material/BarChart'
import BubbleChartIcon from '@mui/icons-material/BubbleChart'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ColorizeRoundedIcon from '@mui/icons-material/ColorizeRounded'
import DataUsageIcon from '@mui/icons-material/DataUsage'
import DonutLargeIcon from '@mui/icons-material/DonutLarge'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import GridViewIcon from '@mui/icons-material/GridView'
import HeightIcon from '@mui/icons-material/Height'
import HubIcon from '@mui/icons-material/Hub'
import InsightsIcon from '@mui/icons-material/Insights'
import MultilineChartIcon from '@mui/icons-material/MultilineChart'
import NumbersIcon from '@mui/icons-material/Numbers'
import PieChartIcon from '@mui/icons-material/PieChart'
import PushPinIcon from '@mui/icons-material/PushPin'
import QueryStatsIcon from '@mui/icons-material/QueryStats'
import RadarIcon from '@mui/icons-material/Radar'
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt'
import SpeedIcon from '@mui/icons-material/Speed'
import StackedBarChartIcon from '@mui/icons-material/StackedBarChart'
import StackedLineChartIcon from '@mui/icons-material/StackedLineChart'
import TimelineIcon from '@mui/icons-material/Timeline'
import ToggleOnIcon from '@mui/icons-material/ToggleOn'
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore'
import WaterfallChartIcon from '@mui/icons-material/WaterfallChart'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Slider from '@mui/material/Slider'
import Stack from '@mui/material/Stack'
import { alpha } from '@mui/material/styles'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import type { QueryResult, QuerySource } from '../types'
import { type ChartDataResponse, type ChartOperation, type ChartType } from '../api/client'
import { detectColumnKind, type ColumnKind } from '../utils/columns'
import {
  autoPickAxes,
  axisFits,
  buildChartData,
  computeKpiCards,
  type ChartDisplayOptions,
  type ChartLabelPosition,
  type ChartLabelRotate,
  type ChartLegendPosition,
  type ChartLineType,
  type ChartMarkerShape,
  type ChartNumberFormat,
  type ChartPaletteId,
  type ChartSeriesStyle,
  type ChartSort,
} from '../utils/chartData'
import { buildChartOption } from '../utils/chartOptions'
import {
  CATEGORICAL_OPERATIONS,
  DEFAULT_OPERATION,
  NUMERIC_Y_TYPES,
  OPERATIONS,
  SECONDARY_AXIS_TYPES,
  SERIES_CAPABLE_TYPES,
  SINGLE_SERIES_TYPES,
} from '../utils/chartCatalog'
import FieldWell from './ChartFieldWell'
import EChart from './EChart'
import KpiCards from './KpiCards'
import type { VisualConfig } from '../utils/visual'

/** Every chart family the builder can render, shown as a colored icon + tooltip. */
const CHART_TYPES: { value: ChartType; icon: ReactElement; color: string }[] = [
  { value: 'bar', color: '#1e88e5', icon: <BarChartIcon /> },
  { value: 'stackbar', color: '#1565c0', icon: <StackedBarChartIcon /> },
  { value: 'trend', color: '#00897b', icon: <ShowChartIcon /> },
  { value: 'stepline', color: '#26c6da', icon: <TimelineIcon /> },
  { value: 'area', color: '#43a047', icon: <AreaChartIcon /> },
  { value: 'stackarea', color: '#2e7d32', icon: <StackedLineChartIcon /> },
  { value: 'combo', color: '#5e35b1', icon: <MultilineChartIcon /> },
  { value: 'pie', color: '#fb8c00', icon: <PieChartIcon /> },
  { value: 'doughnut', color: '#f4511e', icon: <DonutLargeIcon /> },
  { value: 'rose', color: '#e53935', icon: <DataUsageIcon /> },
  { value: 'radar', color: '#d81b60', icon: <RadarIcon /> },
  { value: 'pareto', color: '#8e24aa', icon: <AlignVerticalBottomIcon /> },
  { value: 'waterfall', color: '#00838f', icon: <WaterfallChartIcon /> },
  { value: 'funnel', color: '#f9a825', icon: <FilterAltIcon /> },
  { value: 'treemap', color: '#6d4c41', icon: <AccountTreeIcon /> },
  { value: 'heatmap', color: '#ef6c00', icon: <GridViewIcon /> },
  { value: 'histogram', color: '#3949ab', icon: <SignalCellularAltIcon /> },
  { value: 'box', color: '#546e7a', icon: <CandlestickChartIcon /> },
  { value: 'scatter', color: '#7cb342', icon: <ScatterPlotIcon /> },
  { value: 'bubble', color: '#00acc1', icon: <BubbleChartIcon /> },
  { value: 'trendline', color: '#9e9d24', icon: <InsightsIcon /> },
  { value: 'errorbar', color: '#455a64', icon: <HeightIcon /> },
  { value: 'spc', color: '#c62828', icon: <QueryStatsIcon /> },
  { value: 'sankey', color: '#0277bd', icon: <HubIcon /> },
  { value: 'gauge', color: '#0288d1', icon: <SpeedIcon /> },
]

/** Custom drag MIME so chart-type drags never collide with field drags (text/plain). */
const CHART_TYPE_MIME = 'application/x-bi-charttype'

/** Parse an optional numeric field; blank / non-numeric means "auto" (undefined). */
function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Sorts offered for the aggregated categories. */
const SORT_OPTIONS: { value: ChartSort }[] = [
  { value: 'none' },
  { value: 'value_desc' },
  { value: 'value_asc' },
  { value: 'label_asc' },
  { value: 'label_desc' },
]

const TOPN_OPTIONS: { value: number }[] = [
  { value: 0 },
  { value: 5 },
  { value: 10 },
  { value: 15 },
  { value: 20 },
]

/** Point symbol shapes for line / scatter series ('auto' = type default). */
const MARKER_SHAPES: { value: ChartMarkerShape }[] = [
  { value: 'auto' },
  { value: 'circle' },
  { value: 'rect' },
  { value: 'roundRect' },
  { value: 'triangle' },
  { value: 'diamond' },
  { value: 'pin' },
  { value: 'arrow' },
  { value: 'none' },
]

/** Line stroke patterns offered per series ('auto' = the built-in solid stroke). */
const LINE_STYLE_OPTIONS: { value: ChartLineType }[] = [
  { value: 'auto' },
  { value: 'solid' },
  { value: 'dashed' },
  { value: 'dotted' },
]

/** Per-series line smoothing tri-state. */
const SMOOTH_OPTIONS: { value: 'auto' | 'on' | 'off' }[] = [
  { value: 'auto' },
  { value: 'on' },
  { value: 'off' },
]

/** Per-series marker visibility tri-state. */
const MARKER_VISIBILITY_OPTIONS: { value: 'auto' | 'on' | 'off' }[] = [
  { value: 'auto' },
  { value: 'on' },
  { value: 'off' },
]

/** Per-series stroke width ('auto' = the chart-wide width). */
const LINE_WIDTH_OPTIONS: { value: number | 'auto' }[] = [
  { value: 'auto' },
  { value: 1 },
  { value: 2 },
  { value: 3 },
  { value: 4 },
]

/** Drop per-column override entries whose column left the shelf, reusing the
 *  same object when nothing changed so the setState stays a no-op. */
function pruneByColumns<T>(
  map: Record<string, T>,
  valid: Set<string>,
): Record<string, T> {
  const keys = Object.keys(map)
  if (keys.every((key) => valid.has(key))) return map
  const next: Record<string, T> = {}
  for (const key of keys) if (valid.has(key)) next[key] = map[key]
  return next
}

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
const LINE_TYPES: ChartType[] = [
  'trend',
  'stepline',
  'area',
  'stackarea',
  'scatter',
  'bubble',
  'trendline',
]

/** Types that aggregate a single measure and need no X category. */
const NO_X_AXIS_TYPES: ChartType[] = ['histogram', 'kpi', 'gauge']

/** Chart types whose primary measure renders as a line (per-series line controls). */
const LINE_RENDER_TYPES: ChartType[] = ['trend', 'stepline', 'area', 'stackarea']

/** Chart types whose primary measure renders as scatter points. */
const POINT_RENDER_TYPES: ChartType[] = ['scatter', 'bubble', 'trendline']

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

/**
 * A chart configuration pushed in from outside. `y` accepts a single column
 * name for backwards compatibility with analysis templates, while a dashboard
 * tile hands back the full multi-column config.
 */
export type ChartPreset = Partial<Omit<VisualConfig, 'y'>> & {
  y?: string | string[]
  nonce: number
}

/**
 * Rounded color swatch for the chart panel: restyles the native color input
 * (webkit/Firefox pseudo-elements), adds a hover ring + press feedback, and
 * overlays an eyedropper badge that stays readable on any fill color.
 */
function ColorSwatchInput({
  value,
  onChange,
  disabled,
  ...other
}: {
  value: string
  onChange: (event: ReactChangeEvent<HTMLInputElement>) => void
  disabled?: boolean
  'aria-label': string
}) {
  return (
    <Box
      sx={{
        position: 'relative',
        width: 48,
        height: 48,
        flex: '0 0 auto',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Box
        component="input"
        type="color"
        value={value}
        onChange={onChange}
        disabled={disabled}
        {...other}
        sx={{
          width: '100%',
          height: '100%',
          p: 0,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 2,
          bgcolor: 'background.paper',
          cursor: disabled ? 'default' : 'pointer',
          transition: 'border-color 150ms, box-shadow 150ms, transform 120ms',
          '&:hover:not(:disabled)': {
            borderColor: 'primary.main',
            boxShadow: (theme) => `0 0 0 3px ${alpha(theme.palette.primary.main, 0.16)}`,
          },
          '&:active:not(:disabled)': { transform: 'scale(0.95)' },
          '&::-webkit-color-swatch-wrapper': { padding: 0 },
          '&::-webkit-color-swatch': { border: 'none', borderRadius: 8 },
          '&::-moz-color-swatch-wrapper': { padding: 0 },
          '&::-moz-color-swatch': { border: 'none', borderRadius: 8 },
        }}
      />
      <ColorizeRoundedIcon
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: 16,
          p: 0.5,
          borderRadius: '50%',
          color: '#fff',
          bgcolor: 'rgba(0, 0, 0, 0.4)',
          pointerEvents: 'none',
        }}
      />
    </Box>
  )
}

interface ChartsPanelProps {
  source: QuerySource
  result: QueryResult
  /** Optional chart configuration pushed in from outside (e.g. an analysis template). */
  preset?: ChartPreset | null
  /** Externally generated ECharts option (e.g. from the AI chart assistant). */
  aiOption?: { option: EChartsOption; nonce: number } | null
  /** Called when the user takes over with the manual chart builder. */
  onClearAi?: () => void
  /** Opens the AI chart assistant dialog. */
  onAiChart?: () => void
  /** Label for the AI button — the Dashboard page names its pop-up explicitly. */
  aiLabel?: string
  /** Disables the AI chart button (e.g. while an upload is in progress). */
  aiDisabled?: boolean
  /** Pins the current configuration onto the snapshot's dashboard. */
  onAddToDashboard?: (config: VisualConfig) => void
  /** Label for the pin button — "Update" when re-editing a pinned visual. */
  addLabel?: string
}

export default function ChartsPanel({
  result,
  preset,
  aiOption,
  onClearAi,
  onAiChart,
  aiLabel,
  aiDisabled,
  onAddToDashboard,
  addLabel,
}: ChartsPanelProps) {
  const { t } = useTranslation('charts')

  // Tracks the last Y-column toggle so a fast double-click doesn't immediately
  // reverse the selection (which made the dropdown feel "too sensitive").
  const lastYToggle = useRef<{ name: string; at: number }>({ name: '', at: 0 })
  const lastY2Toggle = useRef<{ name: string; at: number }>({ name: '', at: 0 })

  const [chartType, setChartType] = useState<ChartType>('bar')
  const [x, setX] = useState('')
  const [y, setY] = useState<string[]>([])
  const [operation, setOperation] = useState<ChartOperation>('sum')
  const [series, setSeries] = useState('')
  const [sort, setSort] = useState<ChartSort>('none')
  const [topN, setTopN] = useState(0)
  // Histogram binning: bucket width, plus an optional start / end domain clip
  // (both empty = auto-fit the data).
  const [binSizeInput, setBinSizeInput] = useState('')
  const [rangeStartInput, setRangeStartInput] = useState('')
  const [rangeEndInput, setRangeEndInput] = useState('')
  const [barMode, setBarMode] = useState<'grouped' | 'stacked' | 'percent'>('grouped')
  const [horizontal, setHorizontal] = useState(false)
  const [area, setArea] = useState(false)
  // Secondary-axis column(s) for dual-axis chart types (drawn as lines on the
  // right / top axis).
  const [y2, setY2] = useState<string[]>([])
  // Aggregation applied to the secondary (right) axis.
  const [y2Operation, setY2Operation] = useState<ChartOperation>('sum')
  // Per-column overrides of the aggregation, keyed by Y / Y2 column name. Any
  // column without an entry falls back to the shelf-wide operation above.
  const [yOperations, setYOperations] = useState<Record<string, ChartOperation>>({})
  const [y2Operations, setY2Operations] = useState<Record<string, ChartOperation>>({})
  // Bubble charts: the column whose values drive the marker size.
  const [z, setZ] = useState('')
  // Sankey charts: the destination column of the flow.
  const [target, setTarget] = useState('')
  // Error bars: spread around the mean (95% CI of the mean, or sample std dev).
  const [errorBarMode, setErrorBarMode] = useState<'std' | 'ci95'>('ci95')

  // ---- Appearance options (shared by the builder and pinned dashboard tiles) ----
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [legendShow, setLegendShow] = useState(true)
  const [legendPosition, setLegendPosition] = useState<ChartLegendPosition>('top')
  const [palette, setPalette] = useState<ChartPaletteId>('default')
  const [customColor, setCustomColor] = useState('')
  // `undefined` means "leave the data labels exactly as the chart type draws
  // them" (pie / funnel show them by default), so the builder starts unchanged.
  const [dataLabels, setDataLabels] = useState<boolean | undefined>(undefined)
  const [labelPosition, setLabelPosition] = useState<ChartLabelPosition>('auto')
  // 'auto' keeps whatever number formatting the chart type already used.
  const [numberFormat, setNumberFormat] = useState<ChartNumberFormat>('auto')
  const [decimals, setDecimals] = useState<number | 'auto'>('auto')
  const [axisTitles, setAxisTitles] = useState(true)
  // Per-axis custom titles (empty = keep the chart's built-in axis name).
  const [xAxisTitle, setXAxisTitle] = useState('')
  const [yAxisTitle, setYAxisTitle] = useState('')
  const [y2AxisTitle, setY2AxisTitle] = useState('')
  const [labelRotate, setLabelRotate] = useState<ChartLabelRotate>('auto')
  // Axis bounds are kept as strings so the fields can be empty (= auto).
  const [yMinInput, setYMinInput] = useState('')
  const [yMaxInput, setYMaxInput] = useState('')
  // Off by default so the value axis keeps auto-scaling (starting every axis at
  // zero would flatten trends such as a 91-95% yield).
  const [startAtZero, setStartAtZero] = useState(false)
  const [gridlines, setGridlines] = useState(true)
  const [smooth, setSmooth] = useState<boolean | 'auto'>('auto')
  const [markers, setMarkers] = useState(true)
  const [markerShape, setMarkerShape] = useState<ChartMarkerShape>('auto')
  const [lineWidth, setLineWidth] = useState(2)
  const [trimWhitespace, setTrimWhitespace] = useState(false)
  const [tooltipShow, setTooltipShow] = useState(true)
  const [background, setBackground] = useState('')
  // Per-series style overrides keyed by Y / Y2 column name (line type, color,
  // markers, width …). Columns without an entry inherit the global appearance.
  const [seriesStyles, setSeriesStyles] = useState<Record<string, ChartSeriesStyle>>({})

  // The setup pane is split into a Fields tab (default) and an Appearance tab.
  const [setupTab, setSetupTab] = useState<'fields' | 'appearance'>('fields')
  const [axisTitleTarget, setAxisTitleTarget] = useState<'x' | 'y' | 'y2'>('x')

  // The draggable column list starts open but can be collapsed to give the
  // chart more room on small screens.
  const [fieldsOpen, setFieldsOpen] = useState(true)

  // The chart type picker + X/Y shelves can be collapsed the same way.
  const [setupOpen, setSetupOpen] = useState(true)

  // The per-series override list (shown once more than one measure is on a
  // shelf) starts collapsed to keep the Fields tab compact.
  const [perSeriesOpen, setPerSeriesOpen] = useState(false)
  // Within that list, each measure's card is itself a collapsible dropdown so
  // the full set of line/marker controls is never all on screen at once.
  const [perSeriesExpanded, setPerSeriesExpanded] = useState<Record<string, boolean>>({})

  // Drag-and-drop for the chart-type tiles: `typeDragOver` draws the drop frame
  // on the canvas while `draggingType` labels it with the pending family.
  const [typeDragOver, setTypeDragOver] = useState(false)
  const [draggingType, setDraggingType] = useState('')

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

  /** A sankey flow target: a non-numeric column that differs from the source. */
  const pickTargetColumn = (source: string): string =>
    result.columns.find((c) => c.name !== source && columnKinds[c.name] !== 'number')?.name ??
    result.columns.find((c) => c.name !== source)?.name ??
    ''

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
    if (!SECONDARY_AXIS_TYPES.includes(value)) setY2([])
    // The bubble size and the sankey target only mean something for their family.
    if (value !== 'bubble') setZ('')
    if (value !== 'sankey') setTarget('')
    if (!fits(value, x, y)) {
      const picked = autoPickAxes(value, result.columns, columnKinds, result.rows)
      setX(picked.x)
      setY(picked.y)
      // A sankey needs a second, distinct categorical column for the flow target.
      if (value === 'sankey') setTarget(pickTargetColumn(picked.x))
    } else if (value === 'sankey' && !target) {
      setTarget(pickTargetColumn(x))
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
    if (z && !result.columns.some((c) => c.name === z)) setZ('')
    if (target && !result.columns.some((c) => c.name === target)) setTarget('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  // Apply an externally-provided chart configuration (best-effort: only use
  // keys that are valid for the current result columns). A dashboard tile
  // replays its whole config here, so editing a pinned visual starts from
  // exactly what the tile shows.
  useEffect(() => {
    if (!preset) return
    const known = (name: string | undefined) =>
      !!name && result.columns.some((c) => c.name === name)
    const knownList = (names: string[] | undefined) =>
      (names ?? []).filter((name) => result.columns.some((c) => c.name === name))

    if (preset.chartType) setChartType(preset.chartType)
    if (known(preset.x)) setX(preset.x as string)
    const presetY = Array.isArray(preset.y) ? preset.y : preset.y ? [preset.y] : []
    if (presetY.length > 0) setY(knownList(presetY))
    if (preset.operation) setOperation(preset.operation)
    if (preset.series !== undefined) setSeries(known(preset.series) ? (preset.series as string) : '')
    if (preset.sort) setSort(preset.sort)
    if (preset.topN !== undefined) setTopN(preset.topN)
    if (preset.binSize !== undefined) setBinSizeInput(String(preset.binSize))
    if (preset.rangeStart !== undefined) setRangeStartInput(String(preset.rangeStart))
    if (preset.rangeEnd !== undefined) setRangeEndInput(String(preset.rangeEnd))
    if (preset.barMode) setBarMode(preset.barMode)
    if (preset.horizontal !== undefined) setHorizontal(preset.horizontal)
    if (preset.area !== undefined) setArea(preset.area)
    if (preset.y2 !== undefined) setY2(knownList(preset.y2))
    if (preset.y2Operation) setY2Operation(preset.y2Operation)
    // Per-series overrides replace (not merge) so replaying a tile's config
    // never inherits leftovers from the previously edited chart.
    setYOperations(preset.yOperations ?? {})
    setY2Operations(preset.y2Operations ?? {})
    if (preset.z !== undefined) setZ(known(preset.z) ? (preset.z as string) : '')
    if (preset.target !== undefined) setTarget(known(preset.target) ? (preset.target as string) : '')
    if (preset.errorBarMode !== undefined) setErrorBarMode(preset.errorBarMode)
    // Appearance options — guarded with !== undefined so false / 0 / '' apply.
    if (preset.title !== undefined) setTitle(preset.title)
    if (preset.subtitle !== undefined) setSubtitle(preset.subtitle)
    if (preset.legendShow !== undefined) setLegendShow(preset.legendShow)
    if (preset.legendPosition !== undefined) setLegendPosition(preset.legendPosition)
    if (preset.palette !== undefined) setPalette(preset.palette)
    if (preset.customColor !== undefined) setCustomColor(preset.customColor)
    if (preset.dataLabels !== undefined) setDataLabels(preset.dataLabels)
    if (preset.labelPosition !== undefined) setLabelPosition(preset.labelPosition)
    if (preset.numberFormat !== undefined) setNumberFormat(preset.numberFormat)
    if (preset.decimals !== undefined) setDecimals(preset.decimals)
    if (preset.axisTitles !== undefined) setAxisTitles(preset.axisTitles)
    if (preset.xAxisTitle !== undefined) setXAxisTitle(preset.xAxisTitle)
    if (preset.yAxisTitle !== undefined) setYAxisTitle(preset.yAxisTitle)
    if (preset.y2AxisTitle !== undefined) setY2AxisTitle(preset.y2AxisTitle)
    if (preset.labelRotate !== undefined) setLabelRotate(preset.labelRotate)
    if (preset.yMin !== undefined) setYMinInput(preset.yMin === null ? '' : String(preset.yMin))
    if (preset.yMax !== undefined) setYMaxInput(preset.yMax === null ? '' : String(preset.yMax))
    if (preset.startAtZero !== undefined) setStartAtZero(preset.startAtZero)
    if (preset.gridlines !== undefined) setGridlines(preset.gridlines)
    if (preset.smooth !== undefined) setSmooth(preset.smooth)
    if (preset.markers !== undefined) setMarkers(preset.markers)
    if (preset.markerShape !== undefined) setMarkerShape(preset.markerShape)
    if (preset.lineWidth !== undefined) setLineWidth(preset.lineWidth)
    if (preset.trimWhitespace !== undefined) setTrimWhitespace(preset.trimWhitespace)
    if (preset.tooltipShow !== undefined) setTooltipShow(preset.tooltipShow)
    if (preset.background !== undefined) setBackground(preset.background)
    setSeriesStyles(preset.seriesStyles ?? {})
    setPerSeriesExpanded({})
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

  // Aggregations valid for one specific column. Mirrors `availableOperations`
  // but keys off the column's own data kind, so a mixed shelf (a numeric and a
  // text measure) can still aggregate each column sensibly.
  const opsForColumn = (col: string, secondary: boolean): typeof OPERATIONS => {
    const numeric = columnKinds[col] === 'number'
    return OPERATIONS.filter((item) => {
      if (item.value === 'none') return !secondary && numeric && LINE_TYPES.includes(chartType)
      if (item.value === 'share') return numeric
      if (!CATEGORICAL_OPERATIONS.includes(item.value)) return numeric
      return true
    })
  }

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

  // Prune per-column overrides whose column left the shelf, and drop any
  // aggregation no longer valid for its column (the Select would otherwise
  // render blank). Dropped entries fall back to the shelf-wide setting.
  useEffect(() => {
    const validY = new Set(y)
    const validY2 = new Set(y2)
    const dropInvalid = (
      cur: Record<string, ChartOperation>,
      valid: Set<string>,
      secondary: boolean,
    ): Record<string, ChartOperation> => {
      const kept = pruneByColumns(cur, valid)
      let next = kept
      for (const [col, op] of Object.entries(kept)) {
        if (!opsForColumn(col, secondary).some((item) => item.value === op)) {
          if (next === kept) next = { ...kept }
          delete next[col]
        }
      }
      return next
    }
    setYOperations((cur) => dropInvalid(cur, validY, false))
    setY2Operations((cur) => dropInvalid(cur, validY2, true))
    setSeriesStyles((cur) => pruneByColumns(cur, new Set([...y, ...y2])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [y, y2, columnKinds, chartType])

  // Columns offered for the X axis — numeric only for the scatter family.
  const xColumns = useMemo(
    () =>
      chartType === 'scatter' || chartType === 'bubble' || chartType === 'trendline'
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

  // Secondary-axis columns (Y2 lines) are numeric for a meaningful dual axis;
  // exclude the X axis and the primary Y columns to keep series distinct.
  const y2Columns = useMemo(
    () =>
      result.columns.filter(
        (c) => columnKinds[c.name] === 'number' && c.name !== x && !y.includes(c.name),
      ),
    [result, columnKinds, x, y],
  )

  // Bubble size: another numeric column beside the X / Y pair.
  const bubbleSizeColumns = useMemo(
    () =>
      result.columns.filter(
        (c) => columnKinds[c.name] === 'number' && c.name !== x && !y.includes(c.name),
      ),
    [result, columnKinds, x, y],
  )

  // Sankey target: any column except the source (categorical ones first).
  const sankeyTargetColumns = useMemo(
    () =>
      [...result.columns]
        .filter((c) => c.name !== x)
        .sort((a, b) => Number(columnKinds[b.name] !== 'number') - Number(columnKinds[a.name] !== 'number')),
    [result, columnKinds, x],
  )

  const singleSeriesChart = SINGLE_SERIES_TYPES.includes(chartType)
  const seriesCapable = SERIES_CAPABLE_TYPES.includes(chartType)
  // Chart types that can plot a second measure on a right-hand value axis. A
  // breakdown (Legend) column already owns the series list, so the two never
  // combine.
  const secondaryCapable = SECONDARY_AXIS_TYPES.includes(chartType) && !series

  // Measures that get their own override row. Skipped when a color-by breakdown
  // is active: the series then map to categories, not columns.
  const perSeriesColumns = useMemo(() => {
    if (series) return []
    const rows: { col: string; secondary: boolean }[] = y.map((col) => ({ col, secondary: false }))
    if (secondaryCapable) for (const col of y2) rows.push({ col, secondary: true })
    return rows
  }, [series, y, y2, secondaryCapable])

  /** Merge one field into a column's style override. */
  const patchSeriesStyle = (col: string, patch: ChartSeriesStyle) => {
    setSeriesStyles((cur) => ({ ...cur, [col]: { ...cur[col], ...patch } }))
  }

  /** Override one column's aggregation; picking the shelf-wide value clears it. */
  const setColumnOperation = (col: string, secondary: boolean, op: ChartOperation) => {
    const setter = secondary ? setY2Operations : setYOperations
    setter((cur) => {
      const next = { ...cur }
      if (op === (secondary ? y2Operation : operation)) delete next[col]
      else next[col] = op
      return next
    })
  }

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
      yOperations,
      series: seriesCapable && series ? series : undefined,
      topN,
      binSize: parseOptionalNumber(binSizeInput),
      rangeStart: parseOptionalNumber(rangeStartInput),
      rangeEnd: parseOptionalNumber(rangeEndInput),
      sort,
      y2: secondaryCapable && y2.length > 0 ? y2 : undefined,
      y2Operation: secondaryCapable && y2.length > 0 ? y2Operation : undefined,
      y2Operations,
      z: chartType === 'bubble' && z ? z : undefined,
      target: chartType === 'sankey' && target ? target : undefined,
      errorBarMode: chartType === 'errorbar' ? errorBarMode : undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, chartType, x, y, operation, yOperations, series, topN, binSizeInput, rangeStartInput, rangeEndInput, sort, y2, y2Operation, y2Operations, z, target, errorBarMode])

  /** Parse a numeric axis-bound field; empty / non-numeric = auto (null). */
  const parseAxisBound = (value: string): number | null => {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  const display = useMemo<ChartDisplayOptions>(
    () => ({
      barMode,
      horizontal,
      area,
      hasSeries: !!series && seriesCapable,
      title,
      subtitle,
      legendShow,
      legendPosition,
      palette,
      customColor,
      dataLabels,
      labelPosition,
      numberFormat,
      decimals,
      axisTitles,
      xAxisTitle,
      yAxisTitle,
      y2AxisTitle,
      labelRotate,
      yMin: parseAxisBound(yMinInput),
      yMax: parseAxisBound(yMaxInput),
      startAtZero,
      gridlines,
      smooth,
      markers,
      markerShape,
      lineWidth,
      trimWhitespace,
      tooltipShow,
      background,
      seriesStyles,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      barMode,
      horizontal,
      area,
      series,
      seriesCapable,
      title,
      subtitle,
      legendShow,
      legendPosition,
      palette,
      customColor,
      dataLabels,
      labelPosition,
      numberFormat,
      decimals,
      axisTitles,
      xAxisTitle,
      yAxisTitle,
      y2AxisTitle,
      labelRotate,
      yMinInput,
      yMaxInput,
      startAtZero,
      gridlines,
      smooth,
      markers,
      markerShape,
      lineWidth,
      trimWhitespace,
      tooltipShow,
      background,
      seriesStyles,
    ],
  )

  const option = useMemo<EChartsOption | null>(
    () => buildChartOption(chartType, x, y, data, aiOption?.option ?? null, display),
    [chartType, x, y, data, aiOption, display],
  )

  // Sankey keeps its payload on extra (nodes + links), not on a series.
  const sankeyLinks = (data?.extra?.sankey as { links?: unknown[] } | undefined)?.links
  const hasData =
    !!data &&
    (data.series.some((s) => (s.data as unknown[]).length > 0) ||
      (Array.isArray(sankeyLinks) && sankeyLinks.length > 0))

  /** KPI big-number cards. */
  const kpiCards = useMemo(
    () => (chartType === 'kpi' ? computeKpiCards(result.rows, y, operation) : []),
    [chartType, result, y, operation],
  )

  /** What a dashboard tile would store if the user pinned this chart now. */
  const currentConfig: VisualConfig = {
    chartType,
    x,
    y,
    operation,
    yOperations: Object.keys(yOperations).length > 0 ? yOperations : undefined,
    series: seriesCapable && series ? series : undefined,
    sort,
    topN,
    binSize: parseOptionalNumber(binSizeInput),
    rangeStart: parseOptionalNumber(rangeStartInput),
    rangeEnd: parseOptionalNumber(rangeEndInput),
    barMode,
    horizontal,
    area,
    y2: secondaryCapable && y2.length > 0 ? y2 : undefined,
    y2Operation: secondaryCapable && y2.length > 0 ? y2Operation : undefined,
    y2Operations: Object.keys(y2Operations).length > 0 ? y2Operations : undefined,
    z: chartType === 'bubble' && z ? z : undefined,
    target: chartType === 'sankey' && target ? target : undefined,
    errorBarMode: chartType === 'errorbar' ? errorBarMode : undefined,
    // Appearance — persisted so pinned tiles look identical to the preview.
    title,
    subtitle,
    legendShow,
    legendPosition,
    palette,
    customColor,
    dataLabels,
    labelPosition,
    numberFormat,
    decimals,
    axisTitles,
    xAxisTitle,
    yAxisTitle,
    y2AxisTitle,
    labelRotate,
    yMin: parseAxisBound(yMinInput),
    yMax: parseAxisBound(yMaxInput),
    startAtZero,
    gridlines,
    smooth,
    markers,
    markerShape,
    lineWidth,
    trimWhitespace,
    tooltipShow,
    background,
    seriesStyles: Object.keys(seriesStyles).length > 0 ? seriesStyles : undefined,
  }

  /** Restore every appearance option to its default. */
  const resetAppearance = () => {
    setTitle('')
    setSubtitle('')
    setLegendShow(true)
    setLegendPosition('top')
    setPalette('default')
    setCustomColor('')
    setDataLabels(undefined)
    setLabelPosition('auto')
    setNumberFormat('auto')
    setDecimals('auto')
    setAxisTitles(true)
    setXAxisTitle('')
    setYAxisTitle('')
    setY2AxisTitle('')
    setAxisTitleTarget('x')
    setLabelRotate('auto')
    setYMinInput('')
    setYMaxInput('')
    setStartAtZero(false)
    setGridlines(true)
    setSmooth('auto')
    setMarkers(true)
    setMarkerShape('auto')
    setLineWidth(2)
    setTrimWhitespace(false)
    setTooltipShow(true)
    setBackground('')
    setSeriesStyles({})
    setPerSeriesExpanded({})
  }

  // A sankey needs a source and a distinct target (its Y measure is optional);
  // every other type needs its X (unless X-less by design) plus at least one Y.
  const missingAxes =
    chartType === 'sankey'
      ? !x || !target
      : (!NO_X_AXIS_TYPES.includes(chartType) && !x) || y.length === 0

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
  // Dropdown popups portal to document.body, so their item text is compacted
  // via MenuProps instead of the panel-level descendant styles below.
  const selectMenuProps = { sx: { '& .MuiMenuItem-root': { fontSize: 13 } } } as const

  // Axis-title editor: the dropdown picks which axis the input edits.
  const axisTitleTargetLabel =
    axisTitleTarget === 'x'
      ? t('appearance.axisTitleX')
      : axisTitleTarget === 'y'
        ? t('appearance.axisTitleY')
        : t('appearance.axisTitleY2')
  const axisTitleTargetValue =
    axisTitleTarget === 'x' ? xAxisTitle : axisTitleTarget === 'y' ? yAxisTitle : y2AxisTitle
  const setAxisTitleTargetValue = (value: string) => {
    if (axisTitleTarget === 'x') setXAxisTitle(value)
    else if (axisTitleTarget === 'y') setYAxisTitle(value)
    else setY2AxisTitle(value)
  }
  const axisTitleSummary = [
    xAxisTitle ? t('appearance.summaryX', { title: xAxisTitle }) : '',
    yAxisTitle ? t('appearance.summaryY', { title: yAxisTitle }) : '',
    y2AxisTitle ? t('appearance.summaryY2', { title: y2AxisTitle }) : '',
  ]
    .filter(Boolean)
    .join(' · ')

  /** Makes a chart-type tile draggable onto the canvas. */
  const chartTypeDragProps = (value: ChartType, label: string) => ({
    draggable: true,
    onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
      event.dataTransfer.setData(CHART_TYPE_MIME, value)
      event.dataTransfer.effectAllowed = 'copy'
      setDraggingType(label)
    },
    onDragEnd: () => {
      setDraggingType('')
      setTypeDragOver(false)
    },
  })

  /** True when the in-flight drag carries a chart type rather than a field. */
  const isChartTypeDrag = (event: ReactDragEvent<HTMLDivElement>): boolean =>
    Array.from(event.dataTransfer.types).includes(CHART_TYPE_MIME)

  /** Drop a chart type onto the canvas to switch the visualization. */
  const handleCanvasTypeDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isChartTypeDrag(event)) return
    event.preventDefault()
    const dropped = event.dataTransfer.getData(CHART_TYPE_MIME) as ChartType
    setDraggingType('')
    setTypeDragOver(false)
    if (dropped) handleChartType(dropped)
  }

  return (
    <Stack
      spacing={1.5}
      sx={{
        width: '100%',
        // Compact chart-settings text: smaller dropdown and switch-label type
        // so the option columns hold more controls without growing the panel.
        '& .MuiSelect-select': { fontSize: 13 },
        '& .MuiFormControlLabel-label': { fontSize: 13 },
      }}
    >
      {/* Row context banner */}
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('banner.charting', { n: result.rows.length.toLocaleString() })}
        {result.elapsed_ms ? ` · ${result.elapsed_ms} ms` : ''}
        {chartType === 'kpi' ? t('banner.aggregated') : ''}
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
                aria-label={t('fields.collapse')}
                title={t('fields.collapse')}
              >
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                  {t('fields.title')}
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
                        {t(`kind.${kind}`)}
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
                    {t('fields.dragHint')}
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
              aria-label={t('fields.expand')}
              title={t('fields.expand')}
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
                {t('fields.count', { n: result.columns.length })}
              </Typography>
            </Stack>
          )}
        </Paper>

        {/* Canvas + Visualizations pane. The pane docks to the right on desktop
            (Power BI-style) and stacks above the canvas on phones so the field
            wells and chart types stay within reach. Collapsing it shrinks the
            pane to a slim rail on the right, mirroring the fields rail. */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              lg: setupOpen ? 'minmax(0, 1fr) minmax(300px, 360px)' : 'minmax(0, 1fr) 52px',
            },
            gap: 1.5,
            alignItems: 'start',
            minWidth: 0,
          }}
        >

      {/* Visualizations pane — chart type tiles, field wells and display
          options, collapsible so the canvas can take the full height. */}
      <Paper
        variant="outlined"
        sx={{
          order: { xs: 1, lg: 2 },
          position: { lg: 'sticky' },
          top: { lg: 8 },
          minWidth: 0,
          overflow: 'hidden',
          p: setupOpen ? 1.5 : 0,
        }}
      >
      {setupOpen ? (
      <>
      <Stack
        direction="row"
        spacing={1}
        onClick={() => setSetupOpen(false)}
        role="button"
        aria-expanded
        aria-label={t('viz.collapse')}
        title={t('viz.collapse')}
        sx={{ alignItems: 'center', minHeight: 48, cursor: 'pointer' }}
      >
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {t('viz.title')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t(`types.${chartType}`)}
        </Typography>
        <IconButton size="small" aria-hidden tabIndex={-1} sx={{ pointerEvents: 'none' }}>
          <ChevronRightIcon />
        </IconButton>
      </Stack>

        <Stack spacing={1.5} sx={{ minWidth: 0 }}>

      {/* Row 1 — chart type tiles. Tap to switch family, or drag a tile onto
          the canvas. */}
      <Stack spacing={0.5}>
        <Typography variant="caption" color="text.secondary">
          {t('viz.chartType')}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(44px, 1fr))',
            gap: 0.5,
          }}
        >
          {CHART_TYPES.map((type) => (
            <Tooltip
              key={type.value}
              title={t('viz.typeTooltip', { name: t(`types.${type.value}`) })}
              arrow
            >
              <Box
                {...chartTypeDragProps(type.value, t(`types.${type.value}`))}
                sx={{ display: 'flex' }}
              >
                <ToggleButton
                  value={type.value}
                  selected={chartType === type.value}
                  onChange={() => handleChartType(type.value)}
                  aria-label={t(`types.${type.value}`)}
                  sx={{
                    flex: 1,
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
              </Box>
            </Tooltip>
          ))}
        </Box>
        <Typography variant="caption" color="text.disabled">
          {t('viz.typeHint')}
        </Typography>

        {onAiChart && (
          <Button
            size="small"
            variant="outlined"
            color="primary"
            startIcon={<AutoAwesomeIcon />}
            onClick={onAiChart}
            disabled={aiDisabled}
            sx={{ minHeight: 48, width: '100%', mt: 0.5 }}
          >
            {aiLabel ?? t('actions.aiChart')}
          </Button>
        )}

        {onAddToDashboard && (
          <Button
            size="small"
            variant="contained"
            startIcon={<PushPinIcon />}
            onClick={() => onAddToDashboard(currentConfig)}
            disabled={
              chartType === 'sankey'
                ? !x || !target
                : !x && !NO_X_AXIS_TYPES.includes(chartType)
            }
            sx={{ minHeight: 48, width: '100%', mt: 0.5 }}
          >
            {addLabel ?? t('actions.addToDashboard')}
          </Button>
        )}
      </Stack>

      {/* Tab bar — the chart-type tiles + action buttons stay above it. Fields
          is the default tab; fullWidth keeps it from overflowing at 320px. */}
      <Tabs
        value={setupTab}
        onChange={(_e, value: 'fields' | 'appearance') => setSetupTab(value)}
        variant="fullWidth"
        aria-label={t('aria.setupSections')}
        sx={{ minHeight: 48, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab label={t('fields.title')} value="fields" sx={{ minHeight: 48, textTransform: 'none' }} />
        <Tab label={t('appearance.title')} value="appearance" sx={{ minHeight: 48, textTransform: 'none' }} />
      </Tabs>

      {setupTab === 'fields' && (
        <>
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
              label={
                chartType === 'scatter' || chartType === 'bubble' || chartType === 'trendline'
                  ? t('well.xNumeric')
                  : chartType === 'sankey'
                    ? t('well.source')
                    : t('well.x')
              }
              value={x ? [x] : []}
              options={xColumns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
              onChoose={setX}
              onAdd={setX}
              onRemove={() => setX('')}
              hint={
                chartType === 'scatter' || chartType === 'bubble' || chartType === 'trendline'
                  ? t('well.dropXNumeric')
                  : chartType === 'sankey'
                    ? t('well.dropSource')
                    : t('well.dropX')
              }
            />
          )}
          <FieldWell
            label={
              chartType === 'sankey'
                ? t('well.yWeight')
                : NUMERIC_Y_TYPES.includes(chartType)
                  ? t('well.yNumeric')
                  : t('well.yPrimary')
            }
            value={singleSeriesChart ? y.slice(0, 1) : y}
            multi={!singleSeriesChart && chartType !== 'sankey'}
            options={yColumns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
            onChoose={(name) => (singleSeriesChart ? setY([name]) : handleYChoose(name))}
            onAdd={(name) => (singleSeriesChart ? setY([name]) : handleYAdd(name))}
            onRemove={handleYRemove}
            hint={
              chartType === 'sankey'
                ? t('well.dropYWeight')
                : singleSeriesChart
                  ? t('well.dropY')
                  : t('well.dropYMulti')
            }
          />
          {secondaryCapable && (
            <FieldWell
              label={t('well.y2')}
              value={y2}
              multi
              options={y2Columns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
              onChoose={handleY2Choose}
              onAdd={handleY2Add}
              onRemove={handleY2Remove}
              hint={t('well.dropY2')}
            />
          )}
          {seriesCapable && seriesCandidates.length > 0 && (
            <FieldWell
              label={t('well.legend')}
              value={series ? [series] : []}
              options={seriesCandidates.map((n) => ({ name: n, kind: columnKinds[n] }))}
              onChoose={setSeries}
              onAdd={setSeries}
              onRemove={() => setSeries('')}
              hint={t('well.dropLegend')}
            />
          )}
          {chartType === 'bubble' && (
            <FieldWell
              label={t('well.size')}
              value={z ? [z] : []}
              options={bubbleSizeColumns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
              onChoose={setZ}
              onAdd={setZ}
              onRemove={() => setZ('')}
              hint={t('well.dropSize')}
            />
          )}
          {chartType === 'sankey' && (
            <FieldWell
              label={t('well.target')}
              value={target ? [target] : []}
              options={sankeyTargetColumns.map((c) => ({ name: c.name, kind: columnKinds[c.name] }))}
              onChoose={setTarget}
              onAdd={setTarget}
              onRemove={() => setTarget('')}
              hint={t('well.dropTarget')}
            />
          )}

          {/* Aggregation — the primary Y operation always shows; dual-axis types
              add a secondary. Uses the same caption + control layout as FieldWell
              so the dropdowns top-align with the field shelves. */}
          {/* Error bars always plot the mean ± spread, so the Y operation would
              be a no-op; its own Spread selector takes this slot instead. */}
          {chartType !== 'errorbar' && (
            <Box sx={{ minWidth: { xs: '100%', sm: 180 }, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary" noWrap>{t('well.yOperation')}</Typography>
              <Select
                size="small"
                value={operation}
                onChange={(event: SelectChangeEvent) => setOperation(event.target.value as ChartOperation)}
                MenuProps={selectMenuProps}
                sx={{ minHeight: 48, width: '100%' }}
              >
                {availableOperations.map((item) => (
                  <MenuItem key={item.value} value={item.value}>
                    {t(`ops.${item.value}`)}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          )}
          {secondaryCapable && (
            <Box sx={{ minWidth: { xs: '100%', sm: 180 }, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary" noWrap>{t('well.y2Operation')}</Typography>
              <Select
                size="small"
                value={y2Operation}
                onChange={(event: SelectChangeEvent) => setY2Operation(event.target.value as ChartOperation)}
                MenuProps={selectMenuProps}
                sx={{ minHeight: 48, width: '100%' }}
              >
                {y2OperationOptions.map((item) => (
                  <MenuItem key={item.value} value={item.value}>
                    {t(`ops.${item.value}`)}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          )}

          {/* Per-series overrides — one compact control set per measure, offered
              once more than one column sits on the Y / Y2 shelves. */}
          {perSeriesColumns.length > 1 && (
            <Box sx={{ gridColumn: '1 / -1', minWidth: 0 }}>
              <Button
                size="small"
                variant="text"
                onClick={() => setPerSeriesOpen((v) => !v)}
                aria-expanded={perSeriesOpen}
                startIcon={
                  <UnfoldMoreIcon
                    sx={{
                      transform: perSeriesOpen ? 'rotate(180deg)' : 'none',
                      transition: 'transform 150ms',
                    }}
                  />
                }
                sx={{ minHeight: 48, justifyContent: 'flex-start', textTransform: 'none' }}
              >
                {t('perSeries.title')}
                <Chip size="small" label={perSeriesColumns.length} sx={{ ml: 1 }} />
              </Button>
              {perSeriesOpen && (
                <Stack spacing={1} sx={{ mt: 1 }}>
                  {perSeriesColumns.map(({ col, secondary }) => {
                    const style = seriesStyles[col] ?? {}
                    const opValue =
                      (secondary ? y2Operations[col] : yOperations[col]) ??
                      (secondary ? y2Operation : operation)
                    const lineLike = secondary || LINE_RENDER_TYPES.includes(chartType)
                    const shapeLike = lineLike || (!secondary && POINT_RENDER_TYPES.includes(chartType))
                    const smoothValue =
                      style.smooth === true ? 'on' : style.smooth === false ? 'off' : 'auto'
                    const markersValue =
                      style.markers === true ? 'on' : style.markers === false ? 'off' : 'auto'
                    const cellSx = {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 0.5,
                      minWidth: 0,
                    } as const
                    // Each measure collapses to a single header row so the panel
                    // stays short; the header summarises any active overrides.
                    const seriesKey = `${secondary ? 'y2' : 'y'}-${col}`
                    const expanded = !!perSeriesExpanded[seriesKey]
                    const overrideOp = secondary ? y2Operations[col] : yOperations[col]
                    const summaryParts: string[] = []
                    if (overrideOp) {
                      summaryParts.push(t(`ops.${overrideOp}`))
                    }
                    if (style.lineType && style.lineType !== 'auto') {
                      summaryParts.push(t(`lineStyle.${style.lineType}`))
                    }
                    if (style.lineWidth !== undefined && style.lineWidth !== 'auto') {
                      summaryParts.push(`${style.lineWidth}px`)
                    }
                    if (style.smooth === true) summaryParts.push(t('smooth.on'))
                    if (style.smooth === false) summaryParts.push(t('smooth.off'))
                    if (style.markers === true) summaryParts.push(t('perSeries.markersOn'))
                    if (style.markers === false) summaryParts.push(t('perSeries.markersOff'))
                    if (style.markerShape && style.markerShape !== 'auto') {
                      summaryParts.push(t(`markerShape.${style.markerShape}`))
                    }
                    if (style.color) summaryParts.push(t('perSeries.customColor'))
                    const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : t('perSeries.default')
                    return (
                      <Paper key={`${secondary ? 'y2' : 'y'}-${col}`} variant="outlined" sx={{ p: 1 }}>
                        <Button
                          size="small"
                          variant="text"
                          fullWidth
                          onClick={() =>
                            setPerSeriesExpanded((cur) => ({ ...cur, [seriesKey]: !cur[seriesKey] }))
                          }
                          aria-expanded={expanded}
                          sx={{
                            minHeight: 48,
                            px: 0.5,
                            justifyContent: 'space-between',
                            textTransform: 'none',
                            gap: 1,
                          }}
                        >
                          <Stack
                            direction="row"
                            spacing={1}
                            sx={{ alignItems: 'center', minWidth: 0, flexGrow: 1 }}
                          >
                            <Typography
                              variant="body2"
                              title={col}
                              sx={{
                                fontWeight: 600,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {col}
                            </Typography>
                            <Chip
                              size="small"
                              variant="outlined"
                              color={secondary ? 'secondary' : 'primary'}
                              label={secondary ? t('perSeries.y2Right') : t('perSeries.yLeft')}
                            />
                          </Stack>
                          <Stack
                            direction="row"
                            spacing={0.5}
                            sx={{ alignItems: 'center', flex: '0 0 auto', minWidth: 0 }}
                          >
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                              sx={{ maxWidth: 220, display: { xs: 'none', sm: 'block' } }}
                            >
                              {summary}
                            </Typography>
                            <UnfoldMoreIcon
                              sx={{
                                transform: expanded ? 'rotate(180deg)' : 'none',
                                transition: 'transform 150ms',
                                flex: '0 0 auto',
                              }}
                            />
                          </Stack>
                        </Button>
                        {expanded && (
                          <Box
                            sx={{
                              display: 'grid',
                              gap: 1,
                              mt: 1,
                              gridTemplateColumns: {
                                xs: '1fr',
                                sm: 'repeat(auto-fit, minmax(160px, 1fr))',
                              },
                            }}
                          >
                          {chartType !== 'errorbar' && (
                            <Box sx={cellSx}>
                              <Typography variant="caption" color="text.secondary" noWrap>{t('perSeries.operation')}</Typography>
                              <Select
                                size="small"
                                value={opValue}
                                onChange={(event: SelectChangeEvent) =>
                                  setColumnOperation(col, secondary, event.target.value as ChartOperation)
                                }
                                MenuProps={selectMenuProps}
                                sx={{ minHeight: 48, width: '100%' }}
                              >
                                {opsForColumn(col, secondary).map((item) => (
                                  <MenuItem key={item.value} value={item.value}>{t(`ops.${item.value}`)}</MenuItem>
                                ))}
                              </Select>
                            </Box>
                          )}
                          {lineLike && (
                            <Box sx={cellSx}>
                              <Typography variant="caption" color="text.secondary" noWrap>{t('perSeries.lineType')}</Typography>
                              <Select
                                size="small"
                                value={style.lineType ?? 'auto'}
                                onChange={(event: SelectChangeEvent) =>
                                  patchSeriesStyle(col, { lineType: event.target.value as ChartLineType })
                                }
                                MenuProps={selectMenuProps}
                                sx={{ minHeight: 48, width: '100%' }}
                              >
                                {LINE_STYLE_OPTIONS.map((item) => (
                                  <MenuItem key={item.value} value={item.value}>{t(`lineStyle.${item.value}`)}</MenuItem>
                                ))}
                              </Select>
                            </Box>
                          )}
                          {lineLike && (
                            <Box sx={cellSx}>
                              <Typography variant="caption" color="text.secondary" noWrap>{t('perSeries.lineWidth')}</Typography>
                              <Select
                                size="small"
                                value={String(style.lineWidth ?? 'auto')}
                                onChange={(event: SelectChangeEvent) => {
                                  const raw = event.target.value
                                  patchSeriesStyle(col, {
                                    lineWidth: raw === 'auto' ? 'auto' : Number(raw),
                                  })
                                }}
                                MenuProps={selectMenuProps}
                                sx={{ minHeight: 48, width: '100%' }}
                              >
                                {LINE_WIDTH_OPTIONS.map((item) => (
                                  <MenuItem key={String(item.value)} value={item.value}>{t(`lineWidth.${item.value}`)}</MenuItem>
                                ))}
                              </Select>
                            </Box>
                          )}
                          {lineLike && (
                            <Box sx={cellSx}>
                              <Typography variant="caption" color="text.secondary" noWrap>{t('perSeries.smoothing')}</Typography>
                              <Select
                                size="small"
                                value={smoothValue}
                                onChange={(event: SelectChangeEvent) => {
                                  const v = event.target.value
                                  patchSeriesStyle(col, { smooth: v === 'auto' ? 'auto' : v === 'on' })
                                }}
                                MenuProps={selectMenuProps}
                                sx={{ minHeight: 48, width: '100%' }}
                              >
                                {SMOOTH_OPTIONS.map((item) => (
                                  <MenuItem key={item.value} value={item.value}>{t(`smooth.${item.value}`)}</MenuItem>
                                ))}
                              </Select>
                            </Box>
                          )}
                          {shapeLike && (
                            <Box sx={cellSx}>
                              <Typography variant="caption" color="text.secondary" noWrap>{t('perSeries.markers')}</Typography>
                              <Select
                                size="small"
                                value={markersValue}
                                onChange={(event: SelectChangeEvent) => {
                                  const v = event.target.value
                                  patchSeriesStyle(col, { markers: v === 'auto' ? 'auto' : v === 'on' })
                                }}
                                MenuProps={selectMenuProps}
                                sx={{ minHeight: 48, width: '100%' }}
                              >
                                {MARKER_VISIBILITY_OPTIONS.map((item) => (
                                  <MenuItem key={item.value} value={item.value}>{t(`markerVisibility.${item.value}`)}</MenuItem>
                                ))}
                              </Select>
                            </Box>
                          )}
                          {shapeLike && (
                            <Box sx={cellSx}>
                              <Typography variant="caption" color="text.secondary" noWrap>{t('appearance.markerShape')}</Typography>
                              <Select
                                size="small"
                                value={style.markerShape ?? 'auto'}
                                onChange={(event: SelectChangeEvent) =>
                                  patchSeriesStyle(col, { markerShape: event.target.value as ChartMarkerShape })
                                }
                                MenuProps={selectMenuProps}
                                sx={{ minHeight: 48, width: '100%' }}
                              >
                                {MARKER_SHAPES.map((item) => (
                                  <MenuItem key={item.value} value={item.value}>{t(`markerShape.${item.value}`)}</MenuItem>
                                ))}
                              </Select>
                            </Box>
                          )}
                          <Box sx={cellSx}>
                            <Typography variant="caption" color="text.secondary" noWrap>{t('perSeries.color')}</Typography>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                              <ColorSwatchInput
                                value={style.color || '#1e88e5'}
                                onChange={(event: ReactChangeEvent<HTMLInputElement>) =>
                                  patchSeriesStyle(col, { color: event.target.value })
                                }
                                aria-label={t('perSeries.colorAria', { name: col })}
                              />
                              <Button
                                size="small"
                                variant="text"
                                onClick={() => patchSeriesStyle(col, { color: '' })}
                                disabled={!style.color}
                                sx={{ minHeight: 48 }}
                              >
                                {t('perSeries.palette')}
                              </Button>
                            </Stack>
                          </Box>
                        </Box>
                        )}
                      </Paper>
                    )
                  })}
                </Stack>
              )}
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
                  <ToggleButton value="grouped" sx={{ minHeight: 48 }}>{t('controls.grouped')}</ToggleButton>
                  <ToggleButton value="stacked" sx={{ minHeight: 48 }}>{t('controls.stacked')}</ToggleButton>
                  <ToggleButton value="percent" sx={{ minHeight: 48 }}>{t('controls.percent')}</ToggleButton>
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
                <ToggleButton value="v" sx={{ minHeight: 48 }}>{t('controls.vertical')}</ToggleButton>
                <ToggleButton value="h" sx={{ minHeight: 48 }}>{t('controls.horizontal')}</ToggleButton>
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
              <ToggleButton value="line" sx={{ minHeight: 48 }}>{t('controls.line')}</ToggleButton>
              <ToggleButton value="area" sx={{ minHeight: 48 }}>{t('controls.area')}</ToggleButton>
            </ToggleButtonGroup>
          )}

          {AGGREGATE_SORTABLE_TYPES.includes(chartType) && (
            <>
              <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 180 } }}>
                <InputLabel id="chart-sort-label">{t('controls.sort')}</InputLabel>
                <Select
                  labelId="chart-sort-label"
                  label={t('controls.sort')}
                  value={sort}
                  onChange={(event: SelectChangeEvent) => setSort(event.target.value as ChartSort)}
                  MenuProps={selectMenuProps}
                  sx={selectSx}
                >
                  {SORT_OPTIONS.map((item) => (
                    <MenuItem key={item.value} value={item.value}>
                      {t(`sort.${item.value}`)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 160 } }}>
                <InputLabel id="chart-topn-label">{t('controls.categories')}</InputLabel>
                <Select
                  labelId="chart-topn-label"
                  label={t('controls.categories')}
                  value={String(topN)}
                  onChange={(event: SelectChangeEvent) => setTopN(Number(event.target.value))}
                  MenuProps={selectMenuProps}
                  sx={selectSx}
                >
                  {TOPN_OPTIONS.map((item) => (
                    <MenuItem key={item.value} value={String(item.value)}>
                      {t(`topn.${item.value}`)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </>
          )}

          {chartType === 'errorbar' && (
            <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 180 } }}>
              <InputLabel id="chart-errorbar-label">{t('controls.spread')}</InputLabel>
              <Select
                labelId="chart-errorbar-label"
                label={t('controls.spread')}
                value={errorBarMode}
                onChange={(event: SelectChangeEvent) =>
                  setErrorBarMode(event.target.value as 'std' | 'ci95')
                }
                MenuProps={selectMenuProps}
                sx={selectSx}
              >
                <MenuItem value="ci95">{t('controls.ci95')}</MenuItem>
                <MenuItem value="std">{t('controls.std')}</MenuItem>
              </Select>
            </FormControl>
          )}

          {chartType === 'histogram' && (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              useFlexGap
              sx={{ width: { xs: '100%', sm: 360 }, maxWidth: '100%' }}
            >
              <TextField
                size="small"
                type="number"
                label={t('controls.binSize')}
                placeholder={t('auto')}
                value={binSizeInput}
                onChange={(event: ReactChangeEvent<HTMLInputElement>) => setBinSizeInput(event.target.value)}
                slotProps={{
                  htmlInput: { min: 0, step: 'any', inputMode: 'decimal', 'aria-label': t('aria.binSize') },
                }}
                fullWidth
              />
              <TextField
                size="small"
                type="number"
                label={t('controls.start')}
                placeholder={t('auto')}
                value={rangeStartInput}
                onChange={(event: ReactChangeEvent<HTMLInputElement>) => setRangeStartInput(event.target.value)}
                slotProps={{
                  htmlInput: { step: 'any', inputMode: 'decimal', 'aria-label': t('aria.rangeStart') },
                }}
                fullWidth
              />
              <TextField
                size="small"
                type="number"
                label={t('controls.end')}
                placeholder={t('auto')}
                value={rangeEndInput}
                onChange={(event: ReactChangeEvent<HTMLInputElement>) => setRangeEndInput(event.target.value)}
                slotProps={{
                  htmlInput: { step: 'any', inputMode: 'decimal', 'aria-label': t('aria.rangeEnd') },
                }}
                fullWidth
              />
            </Stack>
          )}

        </Stack>
        </>
      )}

      {setupTab === 'appearance' && (
        /* Appearance controls are the tab body directly; they stack in a single
           column so the pane never overflows on phones. */
        <Stack spacing={1.5} sx={{ minWidth: 0 }}>
              {/* Title */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.title')}
                </Typography>
                <TextField
                  size="small"
                  label={t('appearance.title')}
                  value={title}
                  onChange={(event: ReactChangeEvent<HTMLInputElement>) => setTitle(event.target.value)}
                  fullWidth
                />
                <TextField
                  size="small"
                  label={t('appearance.subtitle')}
                  value={subtitle}
                  onChange={(event: ReactChangeEvent<HTMLInputElement>) => setSubtitle(event.target.value)}
                  fullWidth
                />
              </Stack>

              {/* Legend */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.legend')}
                </Typography>
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={legendShow}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setLegendShow(event.target.checked)}
                    />
                  }
                  label={t('appearance.showLegend')}
                />
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={legendPosition}
                  onChange={(_e: ReactMouseEvent<HTMLElement>, v: ChartLegendPosition | null) => {
                    if (v) setLegendPosition(v)
                  }}
                  disabled={!legendShow}
                  sx={{ flexWrap: 'wrap' }}
                >
                  <ToggleButton value="top" sx={{ minHeight: 44, flex: 1, minWidth: 64 }}>{t('appearance.top')}</ToggleButton>
                  <ToggleButton value="bottom" sx={{ minHeight: 44, flex: 1, minWidth: 64 }}>{t('appearance.bottom')}</ToggleButton>
                  <ToggleButton value="left" sx={{ minHeight: 44, flex: 1, minWidth: 64 }}>{t('appearance.left')}</ToggleButton>
                  <ToggleButton value="right" sx={{ minHeight: 44, flex: 1, minWidth: 64 }}>{t('appearance.right')}</ToggleButton>
                </ToggleButtonGroup>
              </Stack>

              {/* Colors */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.colors')}
                </Typography>
                <FormControl size="small" fullWidth>
                  <InputLabel id="chart-palette-label">{t('appearance.palette')}</InputLabel>
                  <Select
                    labelId="chart-palette-label"
                    label={t('appearance.palette')}
                    value={palette}
                    onChange={(event: SelectChangeEvent) => setPalette(event.target.value as ChartPaletteId)}
                    MenuProps={selectMenuProps}
                    sx={selectSx}
                  >
                    <MenuItem value="default">{t('appearance.paletteDefault')}</MenuItem>
                    <MenuItem value="warm">{t('appearance.paletteWarm')}</MenuItem>
                    <MenuItem value="cool">{t('appearance.paletteCool')}</MenuItem>
                    <MenuItem value="colorblind">{t('appearance.paletteColorblind')}</MenuItem>
                  </Select>
                </FormControl>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <ColorSwatchInput
                    value={customColor || '#1e88e5'}
                    onChange={(event: ReactChangeEvent<HTMLInputElement>) => setCustomColor(event.target.value)}
                    aria-label={t('appearance.seriesColorAria')}
                    disabled={!!series}
                  />
                  <Typography variant="body2" sx={{ flexGrow: 1 }}>
                    {t('appearance.seriesColor')}
                  </Typography>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => setCustomColor('')}
                    disabled={!customColor}
                    sx={{ minHeight: 44 }}
                  >
                    {t('appearance.clear')}
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.disabled">
                  {t('appearance.seriesColorHint')}
                </Typography>
              </Stack>

              {/* Data labels */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.dataLabels')}
                </Typography>
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={dataLabels === true}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setDataLabels(event.target.checked)}
                    />
                  }
                  label={t('appearance.showLabels')}
                />
                <FormControl size="small" fullWidth disabled={dataLabels !== true}>
                  <InputLabel id="chart-labelpos-label">{t('appearance.labelPosition')}</InputLabel>
                  <Select
                    labelId="chart-labelpos-label"
                    label={t('appearance.labelPosition')}
                    value={labelPosition}
                    onChange={(event: SelectChangeEvent) => setLabelPosition(event.target.value as ChartLabelPosition)}
                    MenuProps={selectMenuProps}
                    sx={selectSx}
                  >
                    <MenuItem value="auto">{t('auto')}</MenuItem>
                    <MenuItem value="inside">{t('appearance.inside')}</MenuItem>
                    <MenuItem value="outside">{t('appearance.outside')}</MenuItem>
                    <MenuItem value="top">{t('appearance.top')}</MenuItem>
                  </Select>
                </FormControl>
              </Stack>

              {/* Number format */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.numberFormat')}
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <FormControl size="small" fullWidth>
                    <InputLabel id="chart-numfmt-label">{t('appearance.format')}</InputLabel>
                    <Select
                      labelId="chart-numfmt-label"
                      label={t('appearance.format')}
                      value={numberFormat}
                      onChange={(event: SelectChangeEvent) => setNumberFormat(event.target.value as ChartNumberFormat)}
                      MenuProps={selectMenuProps}
                      sx={selectSx}
                    >
                      <MenuItem value="auto">{t('appearance.fmtAuto')}</MenuItem>
                      <MenuItem value="compact">{t('appearance.fmtCompact')}</MenuItem>
                      <MenuItem value="full">{t('appearance.fmtFull')}</MenuItem>
                      <MenuItem value="percent">{t('appearance.fmtPercent')}</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" fullWidth>
                    <InputLabel id="chart-decimals-label">{t('appearance.decimals')}</InputLabel>
                    <Select
                      labelId="chart-decimals-label"
                      label={t('appearance.decimals')}
                      value={decimals === 'auto' ? 'auto' : String(decimals)}
                      onChange={(event: SelectChangeEvent) =>
                        setDecimals(event.target.value === 'auto' ? 'auto' : Number(event.target.value))
                      }
                      MenuProps={selectMenuProps}
                      sx={selectSx}
                    >
                      <MenuItem value="auto">{t('auto')}</MenuItem>
                      <MenuItem value="0">0</MenuItem>
                      <MenuItem value="1">1</MenuItem>
                      <MenuItem value="2">2</MenuItem>
                      <MenuItem value="3">3</MenuItem>
                    </Select>
                  </FormControl>
                </Stack>
              </Stack>

              {/* Axes */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.axes')}
                </Typography>
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={axisTitles}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setAxisTitles(event.target.checked)}
                    />
                  }
                  label={t('appearance.axisTitles')}
                />
                {/* Custom per-axis titles — the dropdown picks the target axis
                    and the input edits that axis's own title. */}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <FormControl size="small" fullWidth disabled={!axisTitles}>
                    <InputLabel id="chart-axistitle-axis-label">{t('appearance.axis')}</InputLabel>
                    <Select
                      labelId="chart-axistitle-axis-label"
                      label={t('appearance.axis')}
                      value={axisTitleTarget}
                      onChange={(event: SelectChangeEvent) =>
                        setAxisTitleTarget(event.target.value as 'x' | 'y' | 'y2')
                      }
                      MenuProps={selectMenuProps}
                      sx={selectSx}
                    >
                      <MenuItem value="x">{t('appearance.axisX')}</MenuItem>
                      <MenuItem value="y">{t('appearance.axisPrimaryY')}</MenuItem>
                      <MenuItem value="y2">{t('appearance.axisSecondaryY')}</MenuItem>
                    </Select>
                  </FormControl>
                  <TextField
                    size="small"
                    label={axisTitleTargetLabel}
                    value={axisTitleTargetValue}
                    onChange={(event: ReactChangeEvent<HTMLInputElement>) =>
                      setAxisTitleTargetValue(event.target.value)
                    }
                    disabled={!axisTitles}
                    fullWidth
                  />
                </Stack>
                {axisTitleSummary && (
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, minWidth: 0 }}>
                      {axisTitleSummary}
                    </Typography>
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => setAxisTitleTargetValue('')}
                      sx={{ minHeight: 44 }}
                    >
                      {t('appearance.clear')}
                    </Button>
                  </Stack>
                )}
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={gridlines}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setGridlines(event.target.checked)}
                    />
                  }
                  label={t('appearance.gridlines')}
                />
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={startAtZero}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setStartAtZero(event.target.checked)}
                    />
                  }
                  label={t('appearance.startAtZero')}
                />
                <FormControl size="small" fullWidth>
                  <InputLabel id="chart-rotate-label">{t('appearance.labelRotation')}</InputLabel>
                  <Select
                    labelId="chart-rotate-label"
                    label={t('appearance.labelRotation')}
                    value={labelRotate === 'auto' ? 'auto' : String(labelRotate)}
                    onChange={(event: SelectChangeEvent) => {
                      const v = event.target.value
                      setLabelRotate(v === 'auto' ? 'auto' : (Number(v) as 0 | 45 | 90))
                    }}
                    MenuProps={selectMenuProps}
                    sx={selectSx}
                  >
                    <MenuItem value="auto">{t('auto')}</MenuItem>
                    <MenuItem value="0">0°</MenuItem>
                    <MenuItem value="45">45°</MenuItem>
                    <MenuItem value="90">90°</MenuItem>
                  </Select>
                </FormControl>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField
                    size="small"
                    label={t('appearance.yMin')}
                    placeholder={t('auto')}
                    value={yMinInput}
                    onChange={(event: ReactChangeEvent<HTMLInputElement>) => setYMinInput(event.target.value)}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label={t('appearance.yMax')}
                    placeholder={t('auto')}
                    value={yMaxInput}
                    onChange={(event: ReactChangeEvent<HTMLInputElement>) => setYMaxInput(event.target.value)}
                    fullWidth
                  />
                </Stack>
              </Stack>

              {/* Lines */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.lines')}
                </Typography>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={smooth === 'auto' ? 'auto' : smooth ? 'smooth' : 'straight'}
                  onChange={(_e: ReactMouseEvent<HTMLElement>, v: string | null) => {
                    if (v) setSmooth(v === 'auto' ? 'auto' : v === 'smooth')
                  }}
                  sx={{ flexWrap: 'wrap' }}
                >
                  <ToggleButton value="auto" sx={{ minHeight: 44, flex: 1, minWidth: 64 }}>{t('auto')}</ToggleButton>
                  <ToggleButton value="smooth" sx={{ minHeight: 44, flex: 1, minWidth: 64 }}>{t('appearance.smooth')}</ToggleButton>
                  <ToggleButton value="straight" sx={{ minHeight: 44, flex: 1, minWidth: 64 }}>{t('appearance.straight')}</ToggleButton>
                </ToggleButtonGroup>
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={markers}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setMarkers(event.target.checked)}
                    />
                  }
                  label={t('appearance.pointMarkers')}
                />
                <FormControl size="small" fullWidth disabled={!markers}>
                  <InputLabel id="chart-markershape-label">{t('appearance.markerShape')}</InputLabel>
                  <Select
                    labelId="chart-markershape-label"
                    label={t('appearance.markerShape')}
                    value={markerShape}
                    onChange={(event: SelectChangeEvent) =>
                      setMarkerShape(event.target.value as ChartMarkerShape)
                    }
                    MenuProps={selectMenuProps}
                    sx={selectSx}
                  >
                    {MARKER_SHAPES.map((item) => (
                      <MenuItem key={item.value} value={item.value}>
                        {t(`markerShape.${item.value}`)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Box sx={{ px: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    {t('appearance.lineWidthValue', { n: lineWidth })}
                  </Typography>
                  <Slider
                    size="small"
                    min={1}
                    max={5}
                    step={0.5}
                    value={lineWidth}
                    onChange={(_e, v: number | number[]) => setLineWidth(Array.isArray(v) ? v[0] : v)}
                    valueLabelDisplay="auto"
                    sx={{ '& .MuiSlider-thumb': { width: 22, height: 22 } }}
                  />
                </Box>
              </Stack>

              {/* Other */}
              <Stack spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  {t('appearance.other')}
                </Typography>
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={tooltipShow}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setTooltipShow(event.target.checked)}
                    />
                  }
                  label={t('appearance.tooltips')}
                />
                <FormControlLabel
                  sx={{ minHeight: 44, m: 0 }}
                  control={
                    <Switch
                      checked={trimWhitespace}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) => setTrimWhitespace(event.target.checked)}
                    />
                  }
                  label={t('appearance.trimWhitespace')}
                />
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <ColorSwatchInput
                    value={background || '#ffffff'}
                    onChange={(event: ReactChangeEvent<HTMLInputElement>) => setBackground(event.target.value)}
                    aria-label={t('appearance.backgroundAria')}
                  />
                  <Typography variant="body2" sx={{ flexGrow: 1 }}>
                    {t('appearance.background')}
                  </Typography>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => setBackground('')}
                    disabled={!background}
                    sx={{ minHeight: 44 }}
                  >
                    {t('appearance.clear')}
                  </Button>
                </Stack>
              </Stack>

              <Button
                size="small"
                variant="text"
                onClick={resetAppearance}
                sx={{ alignSelf: 'flex-start', minHeight: 44 }}
              >
                {t('appearance.reset')}
              </Button>
        </Stack>
      )}
        </Stack>
      </>
      ) : (
        /* Collapsed: a slim rail beside the canvas on desktop, a short strip
           above it on phones. Both reopen the pane when tapped. */
        <Stack
          spacing={0.5}
          onClick={() => setSetupOpen(true)}
          role="button"
          aria-expanded={false}
          aria-label={t('viz.expand')}
          title={t('viz.expand')}
          sx={{
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: { xs: 48, lg: 180 },
            px: { xs: 1.5, lg: 0 },
            py: { xs: 0, lg: 1.5 },
            cursor: 'pointer',
          }}
        >
          <ChevronLeftIcon
            fontSize="small"
            sx={{ transform: { xs: 'rotate(90deg)', lg: 'none' } }}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              writingMode: { xs: 'horizontal-tb', lg: 'vertical-rl' },
              letterSpacing: { lg: 2 },
            }}
          >
            {t('viz.title')}
          </Typography>
        </Stack>
      )}
      </Paper>

      {/* Canvas column — the visualization fills the space left of the pane on
          desktop and sits below it on phones. Chart-type tiles can be dropped
          straight onto it. */}
      <Stack spacing={1.5} sx={{ order: { xs: 2, lg: 1 }, minWidth: 0 }}>

      {aiOption && (
        <Alert severity="info" onClose={onClearAi}>
          {t('canvas.aiApplied')}
        </Alert>
      )}

      <Box
        onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
          if (!isChartTypeDrag(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          if (!typeDragOver) setTypeDragOver(true)
        }}
        onDragLeave={() => setTypeDragOver(false)}
        onDrop={handleCanvasTypeDrop}
        sx={{
          position: 'relative',
          minWidth: 0,
          borderRadius: 1,
          outline: typeDragOver ? '2px dashed' : 'none',
          outlineColor: 'primary.main',
          outlineOffset: 2,
        }}
      >

      {chartType === 'kpi' ? (
        kpiCards.length > 0 ? (
          <KpiCards cards={kpiCards} />
        ) : (
          <Typography color="text.secondary">{t('canvas.kpiEmpty')}</Typography>
        )
      ) : (
        <Box sx={{ position: 'relative' }}>
          <Box sx={{ height: { xs: 320, sm: 420, md: 480 }, minHeight: 300, width: '100%' }}>
            <EChart option={option} />
          </Box>
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
                    ? t('canvas.noNumeric')
                    : t('canvas.noXY')
                  : t('canvas.noData')}
              </Typography>
            </Box>
          )}
        </Box>
      )}

        {typeDragOver && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // The overlay is purely visual: drops must still land on the Box.
              pointerEvents: 'none',
              borderRadius: 1,
              bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
            }}
          >
            <Typography color="primary" sx={{ fontWeight: 600, px: 2, textAlign: 'center' }}>
              {draggingType ? t('canvas.dropType', { name: draggingType }) : t('canvas.dropHere')}
            </Typography>
          </Box>
        )}
      </Box>
      </Stack>
      </Box>
      </Box>
    </Stack>
  )
}
