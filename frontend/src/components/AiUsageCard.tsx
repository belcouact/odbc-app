import { useCallback, useEffect, useMemo, useState } from 'react'
import RefreshIcon from '@mui/icons-material/Refresh'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import type { EChartsOption } from 'echarts'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import EChart from './EChart'
import type { AiUsageSummary, AiUsageEntry } from '../types'

type Notice = { severity: 'success' | 'error'; message: string } | null

/** Local YYYY-MM-DD key matching the backend's daily bucket keys. */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const sumBucket = (b?: { prompt_tokens: number; completion_tokens: number }) =>
  (b?.prompt_tokens ?? 0) + (b?.completion_tokens ?? 0)

/** Chart palette drawn from the app theme (clay / dusty blue / sage plus warm
 *  complements). Shared by the pies and the stacked bar so every model keeps
 *  the same colour in both charts. */
const USAGE_COLORS = [
  '#d97757', '#6a9bcc', '#788c5d', '#b7791f', '#8b6ba8',
  '#4a7ba6', '#b85c3e', '#5f9e94', '#44562e', '#c2846b',
]

/** Choices for the recent-calls table's rows-per-page selector. */
const RECENT_PAGE_SIZES = [10, 25, 50]

const fmtTime = (ts: string) =>
  new Date(ts).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

interface AiUsageCardProps {
  /** Increment to make the card reload (e.g. after "Test connection"). */
  refreshSignal?: number
}

/**
 * Token usage monitor for the AI Setting page: Today / 7-day / all-time tiles,
 * donut breakdowns by feature and by model, a 14-day stacked bar chart by
 * model and a paginated recent-calls table.
 * Loads on mount, on `refreshSignal` change and when the tab becomes visible.
 */
export default function AiUsageCard({ refreshSignal = 0 }: AiUsageCardProps) {
  const { t } = useTranslation('aiSettings')
  const theme = useTheme()

  const [data, setData] = useState<AiUsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [errMessage, setErrMessage] = useState<string | null>(null)
  const [recentPage, setRecentPage] = useState(0)
  const [recentPageSize, setRecentPageSize] = useState(RECENT_PAGE_SIZES[0])
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      setData(await api.getAiUsage())
      setErrMessage(null)
    } catch (err) {
      setErrMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshSignal])

  // Refresh when the tab becomes visible again (e.g. user ran AI elsewhere).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const tiles = useMemo(() => {
    const day = dayKey(new Date())
    const weekStart = dayKey(new Date(Date.now() - 6 * 86400000))
    let todayTokens = 0
    let todayRequests = 0
    let weekTokens = 0
    let weekRequests = 0
    for (const [key, bucket] of Object.entries(data?.daily ?? {})) {
      if (key === day) {
        todayTokens += sumBucket(bucket)
        todayRequests += bucket.requests
      }
      if (key >= weekStart) {
        weekTokens += sumBucket(bucket)
        weekRequests += bucket.requests
      }
    }
    let allTokens = 0
    let allRequests = 0
    for (const bucket of Object.values(data?.by_feature ?? {})) {
      allTokens += sumBucket(bucket)
      allRequests += bucket.requests
    }
    return [
      { label: t('usage.tiles.today'), total: todayTokens, requests: todayRequests },
      { label: t('usage.tiles.last7'), total: weekTokens, requests: weekRequests },
      { label: t('usage.tiles.allTime'), total: allTokens, requests: allRequests },
    ]
  }, [data, t])

  const featureRows = useMemo(
    () =>
      Object.entries(data?.by_feature ?? {})
        .map(([key, bucket]) => ({
          name: t(`usage.features.${key}`, { defaultValue: key }),
          value: sumBucket(bucket),
        }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value),
    [data, t],
  )

  const modelRows = useMemo(
    () =>
      Object.entries(data?.by_model ?? {})
        .map(([model, bucket]) => ({ model, total: sumBucket(bucket) }))
        .filter((row) => row.total > 0)
        .sort((a, b) => b.total - a.total),
    [data],
  )

  const recentDesc = useMemo(() => (data?.recent ?? []).slice().reverse(), [data])

  // Recent-calls pagination (the backend caps the log at 100 rows, so slicing
  // is cheap; `safeRecentPage` keeps the page in range after refreshes).
  const recentPageCount = Math.max(1, Math.ceil(recentDesc.length / recentPageSize))
  const safeRecentPage = Math.min(recentPage, recentPageCount - 1)
  const pageStart = safeRecentPage * recentPageSize
  const pageRows = recentDesc.slice(pageStart, pageStart + recentPageSize)

  /** Donut option shared by the two breakdown pies. */
  const pieOption = useCallback(
    (rows: { name: string; value: number }[]): EChartsOption => ({
      color: USAGE_COLORS,
      tooltip: { trigger: 'item', confine: true },
      legend: {
        bottom: 0,
        type: 'scroll' as const,
        icon: 'circle' as const,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { fontSize: 10, color: theme.palette.text.secondary },
      },
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['50%', '40%'],
          label: { show: false },
          itemStyle: {
            borderColor: theme.palette.background.paper,
            borderWidth: 2,
            borderRadius: 3,
          },
          data: rows,
        },
      ],
    }),
    [theme],
  )

  const chartOption = useMemo<EChartsOption>(() => {
    const now = new Date()
    const days: string[] = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      days.push(dayKey(d))
    }
    const dailyByModel = data?.daily_by_model ?? {}
    const hasDailyByModel = Object.keys(dailyByModel).length > 0
    const legend =
      modelRows.length > 1 && hasDailyByModel
        ? {
            top: 0,
            type: 'scroll' as const,
            icon: 'circle' as const,
            itemWidth: 8,
            itemHeight: 8,
            textStyle: { fontSize: 10, color: theme.palette.text.secondary },
          }
        : undefined
    // Legacy stores have no per-model daily buckets — fall back to flat totals.
    const barSeries: EChartsOption['series'] =
      modelRows.length > 0 && hasDailyByModel
        ? modelRows.map((row, index) => ({
            name: row.model,
            type: 'bar' as const,
            stack: 'tokens',
            barMaxWidth: 16,
            data: days.map((day) => sumBucket(dailyByModel[day]?.[row.model])),
            itemStyle: {
              color: USAGE_COLORS[index % USAGE_COLORS.length],
              borderRadius: index === modelRows.length - 1 ? [3, 3, 0, 0] : 0,
            },
          }))
        : [
            {
              type: 'bar' as const,
              barMaxWidth: 16,
              data: days.map((day) => sumBucket(data?.daily[day])),
              itemStyle: { color: theme.palette.primary.main, borderRadius: [3, 3, 0, 0] },
            },
          ]
    return {
      grid: { left: 4, right: 4, top: legend ? 28 : 18, bottom: 0, containLabel: true },
      tooltip: { trigger: 'axis', confine: true },
      legend,
      xAxis: {
        type: 'category',
        data: days.map((day) => day.slice(5)),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: theme.palette.divider } },
        axisLabel: { fontSize: 10, color: theme.palette.text.secondary },
      },
      yAxis: { type: 'value', splitLine: { show: false }, axisLabel: { show: false } },
      series: barSeries,
    }
  }, [data, modelRows, theme])

  const handleReset = async () => {
    setResetting(true)
    try {
      await api.resetAiUsage()
      setResetOpen(false)
      await load()
      setNotice({ severity: 'success', message: t('usage.reset.success') })
    } catch (err) {
      setNotice({
        severity: 'error',
        message: err instanceof Error ? err.message : t('usage.reset.failed'),
      })
    } finally {
      setResetting(false)
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 3 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6">{t('usage.title')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('usage.subtitle')}
          </Typography>
        </Box>
        <Tooltip title={t('usage.refreshAria')}>
          <IconButton
            onClick={() => void load()}
            disabled={refreshing}
            aria-label={t('usage.refreshAria')}
            sx={{ width: 48, height: 48, flexShrink: 0 }}
          >
            {refreshing ? <CircularProgress size={20} /> : <RefreshIcon />}
          </IconButton>
        </Tooltip>
      </Stack>

      {loading ? (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <CircularProgress size={26} />
        </Box>
      ) : errMessage ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void load()}>
              {t('actions.retry')}
            </Button>
          }
        >
          {errMessage || t('usage.loadFailed')}
        </Alert>
      ) : tiles[2].requests === 0 ? (
        <Alert severity="info" sx={{ mt: 2 }}>
          {t('usage.empty')}
        </Alert>
      ) : (
        <Stack spacing={2.5} sx={{ mt: 2 }}>
          {/* Stat tiles: Today / last 7 days / all time */}
          <Box
            sx={{
              display: 'grid',
              gap: 1,
              gridTemplateColumns: { xs: 'repeat(3, minmax(0, 1fr))', sm: 'repeat(auto-fit, minmax(150px, 1fr))' },
            }}
          >
            {tiles.map((tile) => (
              <Box key={tile.label} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.25 }}>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {tile.label}
                </Typography>
                <Typography variant="h6" component="div">
                  {tile.total.toLocaleString()}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {t('usage.tiles.requests', { n: tile.requests })}
                </Typography>
              </Box>
            ))}
          </Box>

          {/* Breakdown pies: by feature and by model */}
          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            }}
          >
            <BreakdownPie
              title={t('usage.breakdown.title')}
              empty={featureRows.length === 0}
              emptyLabel={t('usage.empty')}
              option={pieOption(featureRows)}
            />
            <BreakdownPie
              title={t('usage.breakdown.byModel')}
              empty={modelRows.length === 0}
              emptyLabel={t('usage.empty')}
              option={pieOption(modelRows.map((row) => ({ name: row.model, value: row.total })))}
            />
          </Box>

          {/* 14-day mini chart */}
          <Box>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              {t('usage.chart.title')}
            </Typography>
            <Box sx={{ height: 140 }}>
              <EChart option={chartOption} />
            </Box>
          </Box>

          {/* Recent calls */}
          <Box>
            {recentDesc.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t('usage.empty')}
              </Typography>
            ) : (
              <>
                <TableContainer sx={{ maxHeight: 420, border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
                  <Table size="small" stickyHeader sx={{ minWidth: 620 }}>
                    <TableHead>
                      <TableRow>
                        <TableCell padding="none" sx={{ width: 32 }} />
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{t('usage.recent.colTime')}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{t('usage.recent.colFeature')}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{t('usage.recent.colModel')}</TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {t('usage.recent.colInput')}
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {t('usage.recent.colOutput')}
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {t('usage.recent.colElapsed')}
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {pageRows.map((entry, index) => (
                        <RecentRow key={`${entry.ts}-${index}`} entry={entry} />
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <Stack
                  direction="row"
                  useFlexGap
                  spacing={1}
                  sx={{
                    flexWrap: 'wrap',
                    mt: 1,
                    alignItems: 'center',
                    justifyContent: { xs: 'center', sm: 'space-between' },
                  }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {t('usage.recent.pageInfo', {
                      from: pageStart + 1,
                      to: pageStart + pageRows.length,
                      total: recentDesc.length,
                    })}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary" component="label">
                      {t('usage.recent.rowsPerPage')}
                    </Typography>
                    <Select
                      size="small"
                      value={recentPageSize}
                      onChange={(event) => {
                        setRecentPageSize(Number(event.target.value))
                        setRecentPage(0)
                      }}
                      aria-label={t('usage.recent.rowsPerPage')}
                      sx={{ minWidth: 84, '& .MuiSelect-select': { py: 1.25 } }}
                    >
                      {RECENT_PAGE_SIZES.map((size) => (
                        <MenuItem key={size} value={size}>
                          {size}
                        </MenuItem>
                      ))}
                    </Select>
                    <IconButton
                      aria-label={t('usage.recent.prevPage')}
                      disabled={safeRecentPage === 0}
                      onClick={() => setRecentPage((page) => page - 1)}
                      sx={{ width: 48, height: 48 }}
                    >
                      <ChevronLeftIcon />
                    </IconButton>
                    <IconButton
                      aria-label={t('usage.recent.nextPage')}
                      disabled={safeRecentPage >= recentPageCount - 1}
                      onClick={() => setRecentPage((page) => page + 1)}
                      sx={{ width: 48, height: 48 }}
                    >
                      <ChevronRightIcon />
                    </IconButton>
                  </Stack>
                </Stack>
              </>
            )}
          </Box>

          <Stack sx={{ alignItems: { xs: 'stretch', sm: 'flex-end' } }}>
            <Button color="error" variant="text" onClick={() => setResetOpen(true)} sx={{ minHeight: 48 }}>
              {t('usage.reset.button')}
            </Button>
          </Stack>
        </Stack>
      )}

      <Dialog
        open={resetOpen}
        onClose={() => (resetting ? undefined : setResetOpen(false))}
        aria-labelledby="ai-usage-reset-title"
      >
        <DialogTitle id="ai-usage-reset-title">{t('usage.reset.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('usage.reset.body')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetOpen(false)} disabled={resetting}>
            {t('actions.cancel')}
          </Button>
          <Button color="error" variant="contained" disabled={resetting} onClick={() => void handleReset()}>
            {t('usage.reset.confirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={notice?.severity ?? 'info'} variant="filled" onClose={() => setNotice(null)}>
          {notice?.message}
        </Alert>
      </Snackbar>
    </Paper>
  )
}

/** One recent-call table row: status, time, feature, model, input/output tokens, latency. */
function RecentRow({ entry }: { entry: AiUsageEntry }) {
  const { t } = useTranslation('aiSettings')
  return (
    <TableRow>
      <TableCell padding="none">
        <Box
          aria-label={entry.ok ? 'ok' : 'error'}
          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: entry.ok ? 'success.main' : 'error.main' }}
        />
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="caption" color="text.secondary">
          {fmtTime(entry.ts)}
        </Typography>
      </TableCell>
      <TableCell sx={{ maxWidth: 140 }}>
        <Typography variant="body2" noWrap>
          {t(`usage.features.${entry.feature}`, { defaultValue: entry.feature })}
        </Typography>
      </TableCell>
      <TableCell sx={{ maxWidth: 160 }}>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
          {entry.model}
        </Typography>
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="caption" color="text.secondary">
          {entry.prompt_tokens.toLocaleString()}
        </Typography>
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="caption" color="text.secondary">
          {entry.completion_tokens.toLocaleString()}
        </Typography>
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="caption" color="text.secondary">
          {t('usage.recent.elapsed', { ms: entry.elapsed_ms.toLocaleString() })}
        </Typography>
      </TableCell>
    </TableRow>
  )
}

/** Card holding one donut pie with a small title (or an empty hint). */
function BreakdownPie({
  title,
  empty,
  emptyLabel,
  option,
}: {
  title: string
  empty: boolean
  emptyLabel: string
  option: EChartsOption
}) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.25 }}>
      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
        {title}
      </Typography>
      {empty ? (
        <Box sx={{ height: 190, display: 'grid', placeItems: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {emptyLabel}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ height: 190 }}>
          <EChart option={option} />
        </Box>
      )}
    </Box>
  )
}
