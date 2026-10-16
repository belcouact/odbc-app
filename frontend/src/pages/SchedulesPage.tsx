import { useCallback, useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Skeleton from '@mui/material/Skeleton'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import CloseIcon from '@mui/icons-material/Close'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import HistoryIcon from '@mui/icons-material/History'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import type { Schedule, ScheduleSources, ScheduleStatus } from '../api/client'
import ScheduleEditorDialog from '../components/ScheduleEditorDialog'
import ScheduleRunsDialog, { formatDateTime } from '../components/ScheduleRunsDialog'

interface SchedulesPageProps {
  onClose: () => void
}

/** How often the open board re-reads while it is visible, so a due run shows up. */
const POLL_INTERVAL_MS = 15000

/** The board is one centred column, matching the width of the feedback board. */
const PAGE_MAX_WIDTH = 1200

const STATUS_COLOR: Record<ScheduleStatus, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
  success: 'success',
  failed: 'error',
  missed: 'warning',
  interrupted: 'warning',
  running: 'info',
}

/** "Every 15 minutes" / "Every 2 hours" from an interval in seconds. */
function intervalLabel(t: (key: string, options?: Record<string, unknown>) => string, seconds: number) {
  if (seconds % 3600 === 0 && seconds >= 3600)
    return t('summary.everyHours', { value: seconds / 3600 })
  if (seconds % 60 === 0 && seconds >= 60)
    return t('summary.everyMinutes', { value: seconds / 60 })
  return t('summary.everySeconds', { value: seconds })
}

/** The board: every schedule, with its timing, status and actions. */
export default function SchedulesPage({ onClose }: SchedulesPageProps) {
  const { t } = useTranslation('schedules')
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [sources, setSources] = useState<ScheduleSources | null>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [runsFor, setRunsFor] = useState<Schedule | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null)
  const [queued, setQueued] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      setSchedules(await api.listSchedules())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
    void api.scheduleSources().then(setSources).catch(() => setSources(null))
  }, [load])

  // While the board is open, keep it current so a due run appears on its own.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  /** Resolve a target's display name from the sources list (falls back to the id). */
  const targetSummary = useCallback(
    (schedule: Schedule): string => {
      const { target } = schedule
      const find = (list: { id: string; name: string }[] | undefined, id: string | null) =>
        list?.find((item) => item.id === id)?.name ?? id ?? ''
      // Templates are keyed by name, not id, and carry a human-facing title.
      const templateTitle =
        sources?.templates?.find((item) => item.name === target.template_name)?.title ??
        target.template_name ??
        ''
      const label =
        target.kind === 'query'
          ? t('summary.query')
          : target.kind === 'sql'
            ? t('summary.sql')
            : target.kind === 'sql_saved'
              ? t('summary.sqlSaved')
              : target.kind === 'script_template'
                ? t('summary.template')
                : t('summary.script')
      const name =
        target.kind === 'query'
          ? find(sources?.saved_queries, target.query_id)
          : target.kind === 'sql_saved'
            ? find(sources?.sql_queries, target.sql_query_id)
            : target.kind === 'script'
              ? find(sources?.scripts, target.script_id)
              : target.kind === 'script_template'
                ? templateTitle
                : (target.sql ?? '').trim().slice(0, 40)
      return name ? `${label} · ${name}` : label
    },
    [sources, t],
  )

  const triggerSummary = useCallback(
    (schedule: Schedule): string => {
      const { trigger } = schedule
      if (trigger.type === 'interval') return intervalLabel(t, trigger.interval_seconds ?? 0)
      const time = trigger.at_time ?? ''
      if (trigger.type === 'daily') return t('summary.daily', { time })
      if (trigger.type === 'weekly') {
        const days = (trigger.weekdays ?? []).map((day) => t(`dow.${day}`)).join(', ')
        return t('summary.weekly', { days, time })
      }
      return t('summary.monthly', { day: trigger.day_of_month ?? 1, time })
    },
    [t],
  )

  const toggleEnabled = useCallback(
    async (schedule: Schedule, enabled: boolean) => {
      setSchedules((current) =>
        current?.map((item) => (item.id === schedule.id ? { ...item, enabled } : item)) ?? current,
      )
      try {
        await api.updateSchedule(schedule.id, { enabled })
        setToast(t('saved'))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        void load()
      }
    },
    [load, t],
  )

  const runNow = useCallback(
    async (schedule: Schedule) => {
      setQueued((current) => ({ ...current, [schedule.id]: true }))
      try {
        await api.runScheduleNow(schedule.id)
        setToast(t('queued'))
        window.setTimeout(() => {
          setQueued((current) => ({ ...current, [schedule.id]: false }))
          void load()
        }, 2000)
      } catch (err) {
        setQueued((current) => ({ ...current, [schedule.id]: false }))
        setError(t('runFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    },
    [load, t],
  )

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    try {
      await api.deleteSchedule(target.id)
      setToast(t('deleted'))
      void load()
    } catch (err) {
      setError(t('deleteFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [pendingDelete, load, t])

  return (
    <Box sx={{ maxWidth: PAGE_MAX_WIDTH, mx: 'auto', width: '100%' }}>
      <Stack spacing={2}>
        {/* Page header — the same title scale and position as the feedback board:
            an h5 title with a body2 subtitle, actions pushed to the right. */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 1.5,
            flexWrap: 'wrap',
          }}
        >
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="h5">{t('title')}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t('subtitle')}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
            <Tooltip title={t('refresh')}>
              <IconButton
                aria-label={t('refresh')}
                onClick={() => void load()}
                sx={{ minWidth: 44, minHeight: 44 }}
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
            <Button
              size="small"
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                setEditing(null)
                setEditorOpen(true)
              }}
              sx={{
                // Compact on a mouse-driven desktop, a full touch target on a phone.
                minHeight: { xs: 48, sm: 36 },
                minWidth: 0,
                whiteSpace: 'nowrap',
              }}
            >
              {t('newSchedule')}
            </Button>
            <Tooltip title={t('close')}>
              <IconButton
                aria-label={t('close')}
                onClick={onClose}
                sx={{ minWidth: 44, minHeight: 44, color: 'text.secondary' }}
              >
                <CloseIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        {/* The note sits in an outlined card, matching the feedback board's
            control panel; the refresh action lives in the header above. */}
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Alert severity="info" icon={false} sx={{ mb: error ? 1.5 : 0 }}>
            {t('note')}
          </Alert>

          {error && (
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => void load()}>
                  {t('retry')}
                </Button>
              }
            >
              {error}
            </Alert>
          )}
        </Paper>

        {/* The board is only the collection: each schedule keeps its own card, so
            no schedule ever has to share the page width. */}
        <Box>
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {schedules === null ? t('loading') : t('count', { count: schedules.length })}
            </Typography>
          </Box>

          {schedules === null ? (
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <Skeleton variant="rounded" height={44} />
              <Skeleton variant="rounded" height={44} />
              <Skeleton variant="rounded" height={44} />
            </Box>
          ) : schedules.length === 0 ? (
            <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
              <AccessTimeIcon sx={{ fontSize: 36, color: 'text.disabled' }} />
              <Typography variant="subtitle2" sx={{ mt: 1, fontWeight: 700 }}>
                {t('empty.title')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('empty.hint')}
              </Typography>
              {/* An empty screen must always offer the way out of it. */}
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => {
                  setEditing(null)
                  setEditorOpen(true)
                }}
                sx={{ mt: 2, minHeight: 48, minWidth: { xs: '100%', sm: 180 } }}
              >
                {t('newSchedule')}
              </Button>
            </Paper>
          ) : (
            <Stack spacing={1}>
              {schedules.map((schedule) => (
                <Paper key={schedule.id} variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={{ xs: 1.5, md: 2 }}
                    sx={{ alignItems: { xs: 'stretch', md: 'center' } }}
                  >
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 700 }}>{schedule.name}</Typography>
                        <Chip
                          size="small"
                          color={schedule.last_status ? STATUS_COLOR[schedule.last_status] : 'default'}
                          label={schedule.last_status ? t(`status.${schedule.last_status}`) : t('status.never')}
                        />
                        {!schedule.enabled && <Chip size="small" variant="outlined" label={t('disabled')} />}
                      </Stack>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {targetSummary(schedule)}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {triggerSummary(schedule)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {t('nextRun')}: {schedule.enabled ? formatDateTime(schedule.next_run_at) : '—'}
                        {' · '}
                        {t('lastRun')}: {schedule.last_run_at ? formatDateTime(schedule.last_run_at) : t('neverRun')}
                      </Typography>
                      {schedule.last_error && (
                        <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 0.5 }}>
                          {schedule.last_error}
                        </Typography>
                      )}
                    </Box>

                    <Stack
                      direction="row"
                      spacing={0.5}
                      useFlexGap
                      sx={{
                        alignItems: 'center',
                        justifyContent: { xs: 'flex-start', md: 'flex-end' },
                        flexWrap: 'wrap',
                      }}
                    >
                      <Tooltip title={t('enableToggle')}>
                        <Switch
                          checked={schedule.enabled}
                          onChange={(event) => void toggleEnabled(schedule, event.target.checked)}
                          slotProps={{ input: { 'aria-label': t('enableToggle') } }}
                        />
                      </Tooltip>
                      <Tooltip title={t('runNow')}>
                        <span>
                          <IconButton
                            aria-label={t('runNow')}
                            disabled={Boolean(queued[schedule.id])}
                            onClick={() => void runNow(schedule)}
                            sx={{ minWidth: 44, minHeight: 44 }}
                          >
                            <PlayArrowIcon />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={t('history')}>
                        <IconButton
                          aria-label={t('history')}
                          onClick={() => setRunsFor(schedule)}
                          sx={{ minWidth: 44, minHeight: 44 }}
                        >
                          <HistoryIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t('edit')}>
                        <IconButton
                          aria-label={t('edit')}
                          onClick={() => {
                            setEditing(schedule)
                            setEditorOpen(true)
                          }}
                          sx={{ minWidth: 44, minHeight: 44 }}
                        >
                          <EditOutlinedIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t('delete')}>
                        <IconButton
                          aria-label={t('delete')}
                          onClick={() => setPendingDelete(schedule)}
                          sx={{ minWidth: 44, minHeight: 44 }}
                        >
                          <DeleteOutlineIcon />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </Box>
      </Stack>

      <ScheduleEditorDialog
        open={editorOpen}
        schedule={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          setToast(editing ? t('saved') : t('created'))
          void load()
        }}
      />
      <ScheduleRunsDialog open={Boolean(runsFor)} schedule={runsFor} onClose={() => setRunsFor(null)} />

      <Dialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)}>
        <DialogTitle>{t('deleteConfirmTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('deleteConfirm', { name: pendingDelete?.name ?? '' })}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 2, pb: 1.5 }}>
          <Button onClick={() => setPendingDelete(null)} sx={{ minHeight: 44 }}>
            {t('cancel')}
          </Button>
          <Button color="error" variant="contained" onClick={() => void confirmDelete()} sx={{ minHeight: 44 }}>
            {t('confirmDelete')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={2500}
        onClose={() => setToast('')}
        message={toast}
      />
    </Box>
  )
}
