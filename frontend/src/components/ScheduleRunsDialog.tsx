import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import CloseIcon from '@mui/icons-material/Close'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import type { Schedule, ScheduleRun, ScheduleStatus } from '../api/client'

interface ScheduleRunsDialogProps {
  open: boolean
  schedule: Schedule | null
  onClose: () => void
}

/** Chip colors per run outcome (status is the encoded variable here). */
const STATUS_COLOR: Record<ScheduleStatus, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
  success: 'success',
  failed: 'error',
  missed: 'warning',
  interrupted: 'warning',
  running: 'info',
}

/** `2026-10-17T06:30:00` -> the browser's local short date + time. */
export function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Human-readable duration from milliseconds. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes} m ${rest} s`
}

/** One schedule's run history, newest first. */
export default function ScheduleRunsDialog({ open, schedule, onClose }: ScheduleRunsDialogProps) {
  const { t } = useTranslation('schedules')
  const fullScreen = useMediaQuery((theme) => theme.breakpoints.down('sm'))
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null)

  useEffect(() => {
    if (!open || !schedule) return
    setRuns(null)
    void api
      .scheduleRuns(schedule.id, 50)
      .then(setRuns)
      .catch(() => setRuns([]))
  }, [open, schedule])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      aria-label={t('runs.title', { name: schedule?.name ?? '' })}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Box sx={{ flexGrow: 1, fontWeight: 700, fontSize: '1rem' }}>
          {t('runs.title', { name: schedule?.name ?? '' })}
        </Box>
        <IconButton aria-label={t('cancel')} onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {runs === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={22} />
          </Box>
        ) : runs.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t('runs.empty')}
          </Typography>
        ) : (
          <Stack spacing={1.25}>
            {runs.map((run) => (
              <Box
                key={run.id}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  p: 1.25,
                }}
              >
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip
                    size="small"
                    color={STATUS_COLOR[run.status]}
                    label={t(`status.${run.status}`)}
                  />
                  <Typography variant="body2">{formatDateTime(run.started_at)}</Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  <Typography variant="caption" color="text.secondary">
                    {t('runs.duration')}: {formatDuration(run.duration_ms)}
                  </Typography>
                  {run.row_count > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      {t('runs.rows')}: {run.row_count.toLocaleString()}
                    </Typography>
                  )}
                </Stack>
                {(run.error || run.message) && (
                  <Typography
                    variant="caption"
                    color={run.error ? 'error.main' : 'text.secondary'}
                    sx={{ display: 'block', mt: 0.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  >
                    {t('runs.error')}: {run.error || run.message}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  )
}
