import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import InfoIcon from '@mui/icons-material/Info'
import HistoryIcon from '@mui/icons-material/History'
import RefreshIcon from '@mui/icons-material/Refresh'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'

import StorageIcon from '@mui/icons-material/Storage'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BarChartIcon from '@mui/icons-material/BarChart'
import CodeIcon from '@mui/icons-material/Code'
import TerminalIcon from '@mui/icons-material/Terminal'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Collapse from '@mui/material/Collapse'
import Grid from '@mui/material/Grid'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Paper from '@mui/material/Paper'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { alpha } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api } from '../api/client'
import type { UpdateStatus, VersionHistoryEntry } from '../api/client'
import ConnectionsPage from './ConnectionsPage'
import AiSettingsPage from './AiSettingsPage'

export type SettingsSection = 'connections' | 'ai' | 'about'

interface SettingsPageProps {
  /**
   * Start the auto-update from the app shell, so the same poller that watches
   * the restart also reloads the page once the new build is running.
   */
  onStartUpdate: () => Promise<UpdateStatus | null>
  /** Controlled section (e.g. driven from the AppBar connections icon). */
  section?: SettingsSection
  onSectionChange?: (section: SettingsSection) => void
  /**
   * Incremented by the app shell when the user clicks the app-bar version
   * badge; AboutSection reacts by expanding the Updates disclosure.
   */
  expandUpdates?: number
  /**
   * Retained for the app shell's shut-down confirmation dialog. About no
   * longer renders a "Shut down server" entry, so Settings accepts but does
   * not currently use it.
   */
  onRequestShutdown?: () => void
}

const SECTIONS: { value: SettingsSection; labelKey: string; icon: ReactElement }[] = [
  { value: 'connections', labelKey: 'sections.connections', icon: <StorageIcon color="primary" /> },
  { value: 'ai', labelKey: 'sections.ai', icon: <AutoAwesomeIcon color="secondary" /> },

  { value: 'about', labelKey: 'sections.about', icon: <InfoIcon color="info" /> },
]

const APP_INFO: { id: string; labelKey: string; valueKey?: string }[] = [
  { id: 'copyright', labelKey: 'appInfo.copyrightLabel', valueKey: 'appInfo.copyrightValue' },
  { id: 'platform', labelKey: 'appInfo.platformLabel', valueKey: 'appInfo.platformValue' },
  { id: 'frontend', labelKey: 'appInfo.frontendLabel', valueKey: 'appInfo.frontendValue' },
  { id: 'backend', labelKey: 'appInfo.backendLabel', valueKey: 'appInfo.backendValue' },
  { id: 'version', labelKey: 'appInfo.versionLabel' },
]

/** How many releases About lists; older ones stay in version_history.json. */
const HISTORY_LIMIT = 5

/** Feature showcase palette — one accent per card so the grid stays scannable. */
type FeatureColor = 'primary' | 'info' | 'success' | 'warning' | 'secondary'

const KEY_FEATURES: { titleKey: string; descriptionKey: string; icon: ReactElement; color: FeatureColor }[] = [
  {
    titleKey: 'features.odbc.title',
    icon: <StorageIcon />,
    color: 'primary',
    descriptionKey: 'features.odbc.description',
  },
  {
    titleKey: 'features.builder.title',
    icon: <CodeIcon />,
    color: 'info',
    descriptionKey: 'features.builder.description',
  },
  {
    titleKey: 'features.charts.title',
    icon: <BarChartIcon />,
    color: 'warning',
    descriptionKey: 'features.charts.description',
  },
  {
    titleKey: 'features.scripting.title',
    icon: <TerminalIcon />,
    color: 'secondary',
    descriptionKey: 'features.scripting.description',
  },
  {
    titleKey: 'features.queries.title',
    icon: <HistoryIcon />,
    color: 'info',
    descriptionKey: 'features.queries.description',
  },
  {
    titleKey: 'features.tools.title',
    icon: <AccountTreeIcon />,
    color: 'success',
    descriptionKey: 'features.tools.description',
  },
  {
    titleKey: 'features.ai.title',
    icon: <AutoAwesomeIcon />,
    color: 'primary',
    descriptionKey: 'features.ai.description',
  },
  {
    titleKey: 'features.updates.title',
    icon: <SystemUpdateAltIcon />,
    color: 'secondary',
    descriptionKey: 'features.updates.description',
  },
]

/** Third-party apps embedded by the Tools tabs, credited to their authors. */
const ACKNOWLEDGEMENTS: { tab: string; name: string; href: string; descriptionKey: string }[] = [
  {
    tab: 'FlowDiagram',
    name: 'next-ai-draw-io',
    href: 'https://github.com/DayuanJiang/next-ai-draw-io',
    descriptionKey: 'ack.flowdiagram',
  },
  {
    tab: 'Project',
    name: 'light-gantt',
    href: 'https://study-llm.me/apps/light-gantt/',
    descriptionKey: 'ack.project',
  },
  {
    tab: 'ProblemSolving',
    name: 'metric-bowler',
    href: 'https://study-llm.me/apps/a3-bowler/metric-bowler',
    descriptionKey: 'ack.problemsolving',
  },
]

/** States that mean an update is running, whether or not it was started from here. */
const UPDATE_BUSY = ['checking', 'downloading', 'verifying', 'waiting_idle', 'restarting']

/** The subset of those states that belong to an install, so they spin "Update now". */
const UPDATE_INSTALLING = ['downloading', 'verifying', 'waiting_idle', 'restarting']

function updateSummary(status: UpdateStatus | null, t: TFunction): string {
  if (!status) return t('updates.loading')
  if (status.state === 'error') return t('updates.checkFailed', { error: status.error || status.message })
  if (status.available)
    return `${t('updates.available', {
      version: status.latest_version,
      current: status.current_version,
    })}${status.forced ? t('updates.required') : ''}`
  if (UPDATE_BUSY.includes(status.state)) return status.message || t('updates.inProgress')
  if (!status.source) return t('updates.noSource')
  if (status.checked_at)
    return t('updates.upToDateChecked', {
      current: status.current_version,
      checked: new Date(status.checked_at * 1000).toLocaleString(),
    })
  return t('updates.upToDate', { current: status.current_version })
}

/** Roll duration of the Build Version odometer (mirrors the KPI cards' feel). */
const VERSION_ROLL_MS = 900
/** Full digit cycles each wheel spins through before landing on its value. */
const VERSION_SPINS = 2

/**
 * Spins every digit of `version` like an odometer wheel, so the Build Version
 * card animates the way the KPI cards do. Each digit cycles through 0-9 a few
 * times and decelerates onto its final value (a plain 0 -> target roll is
 * invisible when the digit is already 0, e.g. the "0.0" in "1.0.0"). Dots and
 * any other non-digit characters are left untouched, and the effect is skipped
 * for users who prefer reduced motion.
 */
function useVersionRoll(version: string): string {
  const [display, setDisplay] = useState(version.replace(/\d/g, '0'))
  const frameRef = useRef(0)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(version)
      return
    }
    const chars = [...version]
    const targets = chars.map((ch) => (ch >= '0' && ch <= '9' ? Number(ch) : null))
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / VERSION_ROLL_MS)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(
        chars
          .map((ch, i) => {
            const target = targets[i]
            if (target === null) return ch
            // Spin VERSION_SPINS full turns, then settle on the target digit.
            return String(Math.floor(eased * (10 * VERSION_SPINS + target)) % 10)
          })
          .join(''),
      )
      if (t < 1) frameRef.current = requestAnimationFrame(tick)
      else setDisplay(version)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [version])

  return display
}

/** KPI-style version number; isolated so the hook never runs conditionally. */
function VersionValue({ version }: { version: string }) {
  return <>{useVersionRoll(version)}</>
}

function AboutSection({
  onStartUpdate,
  expandUpdates,
}: {
  /** Started in the shell so the whole app tracks the restart and reloads on it. */
  onStartUpdate: () => Promise<UpdateStatus | null>
  /**
   * Shell signal: bumped each time the user clicks the app-bar version badge.
   * A change (not the initial value) expands the Updates disclosure.
   */
  expandUpdates?: number
}) {
  const { t } = useTranslation('settings')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  // Release history bundled with this build; null while loading, [] when the
  // backend predates the endpoint or the bundle has no history.
  const [history, setHistory] = useState<VersionHistoryEntry[] | null>(null)
  // Expandable "what's new + version history" section in the Updates card.
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Respect the OS "reduce motion" preference for the disclosure + chevron.
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  useEffect(() => {
    api
      .updateStatus()
      .then(setUpdateStatus)
      .catch(() => {
        /* older backend: keep the card in its loading-neutral state */
      })
    api
      .versionHistory()
      .then((res) => setHistory(res.history))
      .catch(() => setHistory([]))
  }, [])

  // App-bar version badge click: jump here and open the Updates disclosure.
  // The counter starts at 0, so the mount run is a no-op.
  useEffect(() => {
    if (expandUpdates) setDetailsOpen(true)
  }, [expandUpdates])

  const runUpdateCheck = useCallback(async () => {
    setUpdateBusy(true)
    try {
      setUpdateStatus(await api.updateCheck())
    } catch (err) {
      setUpdateStatus((prev) =>
        prev
          ? { ...prev, state: 'error', error: err instanceof Error ? err.message : t('updates.checkFailedShort') }
          : prev,
      )
    } finally {
      setUpdateBusy(false)
    }
  }, [t])

  // A check spins "Check now"; an install spins "Update now", so progress always
  // sits in the button that was pressed. Either one locks both buttons.
  const checking = updateBusy || updateStatus?.state === 'checking'
  const installing = !!updateStatus && UPDATE_INSTALLING.includes(updateStatus.state)
  const busy = checking || installing

  const runUpdateInstall = useCallback(async () => {
    // Delegated to the shell: it arms the marker that guarantees the post-update
    // reload, and its tighter poll picks the restart up within a few seconds.
    const next = await onStartUpdate()
    if (next) setUpdateStatus(next)
  }, [onStartUpdate])

  // While an install runs, keep the summary and progress in this card fresh.
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => {
      api.updateStatus().then(setUpdateStatus).catch(() => {})
    }, 2000)
    return () => window.clearInterval(timer)
  }, [busy])

  // Auto-expand once per newly-offered release so "What's new" is in view.
  // Adjusted during render (not in an effect) to avoid a cascading render.
  const [autoExpandedFor, setAutoExpandedFor] = useState<string | null>(null)
  if (
    updateStatus?.available &&
    updateStatus.latest_version &&
    autoExpandedFor !== updateStatus.latest_version
  ) {
    setAutoExpandedFor(updateStatus.latest_version)
    setDetailsOpen(true)
  }

  // What's new: manifest notes for a release that is waiting to be installed.
  // The running build's notes already live in the version history below, so
  // only surface a separate block when it would not duplicate that list.
  const whatsNew =
    updateStatus?.available && updateStatus.notes
      ? {
          version: updateStatus.latest_version || updateStatus.current_version,
          notes: updateStatus.notes,
        }
      : null
  const historyLoading = history === null
  // About shows only the most recent releases — the full list lives in
  // version_history.json and the "What's new" block already covers a pending one.
  const visibleHistory = history?.slice(0, HISTORY_LIMIT) ?? null
  const hasHistory = !!visibleHistory && visibleHistory.length > 0

  return (
    <Box>
      <Paper
        variant="outlined"
        sx={{
          position: 'relative',
          overflow: 'hidden',
          p: { xs: 2, sm: 3 },
          mb: 2,
          background:
            'linear-gradient(135deg, rgba(217, 119, 87, 0.09) 0%, rgba(106, 155, 204, 0.06) 100%)',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Box
            component="img"
            src="/alex.ico"
            alt={t('about.logoAlt')}
            sx={{
              width: { xs: 44, sm: 52 },
              height: { xs: 44, sm: 52 },
              borderRadius: '50%',
              bgcolor: 'background.paper',
              p: 0.5,
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: '0 2px 8px rgba(26, 34, 51, 0.06)',
            }}
          />
          <Box>
            <Typography variant="h6">{t('about.appName')}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t('about.tagline')}
            </Typography>
          </Box>
        </Box>

        <Grid container spacing={{ xs: 1, sm: 2 }}>
          {APP_INFO.map((entry) => {
            const isVersion = entry.id === 'version'
            const version = updateStatus?.current_version ?? '—'
            return (
              <Grid size={{ xs: 12, sm: 4 }} key={entry.id}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: { xs: 1.5, sm: 2 },
                    height: '100%',
                    bgcolor: 'background.paper',
                    // The Build Version card behaves like a KPI card: a
                    // pointer-device hover lift, a press-scale on touch.
                    ...(isVersion
                      ? {
                          transition: 'transform 0.2s ease-out, box-shadow 0.2s ease-out',
                          '@media (hover: hover)': {
                            '&:hover': {
                              transform: 'translateY(-2px)',
                              boxShadow: '0 6px 16px rgba(217, 119, 87, 0.14)',
                            },
                          },
                          '&:active': { transform: 'scale(0.98)' },
                        }
                      : {}),
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      display: 'block',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.07em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {t(entry.labelKey)}
                  </Typography>
                  {isVersion ? (
                    <Typography variant="body2" sx={{ fontWeight: 600, mt: 0.5, color: 'primary.main' }}>
                      <VersionValue version={version} />
                    </Typography>
                  ) : (
                    <Typography variant="body2" sx={{ fontWeight: 600, mt: 0.5, color: 'primary.main' }}>
                      {entry.valueKey ? t(entry.valueKey) : ''}
                    </Typography>
                  )}
                </Paper>
              </Grid>
            )
          })}
        </Grid>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 1.5 }}>
          <Box
            sx={{
              display: 'grid',
              placeItems: 'center',
              width: 34,
              height: 34,
              borderRadius: 2,
              bgcolor: 'rgba(217, 119, 87, 0.12)',
              color: 'primary.main',
            }}
          >
            <SystemUpdateAltIcon fontSize="small" />
          </Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {t('about.updates')}
          </Typography>
        </Box>
        <Typography
          variant="body2"
          color="text.secondary"
          role="status"
          aria-live="polite"
          sx={{ mb: 2 }}
        >
          {updateSummary(updateStatus, t)}
        </Typography>
        {!updateStatus?.supported && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('updates.unsupported')}
          </Typography>
        )}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'stretch', sm: 'center' },
            gap: 1.5,
          }}
        >
          <Button
            variant="contained"
            startIcon={checking ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
            onClick={runUpdateCheck}
            disabled={busy}
            sx={{ minHeight: 48, minWidth: { xs: '100%', sm: 132 } }}
          >
            {t('about.checkNow')}
          </Button>
          <Button
            variant="outlined"
            color="primary"
            startIcon={
              installing ? <CircularProgress size={16} color="inherit" /> : <SystemUpdateAltIcon />
            }
            onClick={runUpdateInstall}
            disabled={busy || !updateStatus?.available || !updateStatus?.supported}
            sx={{ minHeight: 48, minWidth: { xs: '100%', sm: 160 } }}
          >
            {t('about.updateNow')}
          </Button>
        </Box>

        <Box sx={{ mt: 1.5 }}>
          <Button
            color="inherit"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-controls="settings-version-details"
            endIcon={
              <ExpandMoreIcon
                sx={{
                  transform: detailsOpen ? 'rotate(180deg)' : 'none',
                  transition: prefersReducedMotion ? 'none' : 'transform 0.2s ease',
                }}
              />
            }
            sx={{
              width: '100%',
              minHeight: 48,
              px: 1.5,
              justifyContent: 'space-between',
              borderRadius: 2,
              color: 'text.primary',
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              '& .MuiButton-endIcon': { ml: 1 },
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            {t('about.whatsNewToggle')}
          </Button>
          <Collapse in={detailsOpen} timeout={prefersReducedMotion ? 0 : 240}>
            <Box id="settings-version-details" sx={{ pt: 2 }}>
              {whatsNew && (
                <Box
                  sx={{
                    p: 2,
                    mb: hasHistory || historyLoading ? 2.5 : 0,
                    borderRadius: 2,
                    bgcolor: 'rgba(217, 119, 87, 0.07)',
                    border: '1px solid',
                    borderColor: 'rgba(217, 119, 87, 0.24)',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                    <SystemUpdateAltIcon fontSize="small" color="primary" />
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {t('about.whatsNewIn', { version: whatsNew.version })}
                    </Typography>
                  </Box>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ whiteSpace: 'pre-line' }}
                  >
                    {whatsNew.notes}
                  </Typography>
                </Box>
              )}

              {historyLoading ? (
                <Box
                  aria-busy="true"
                  sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}
                >
                  <Skeleton variant="rounded" height={20} width="38%" />
                  <Skeleton variant="rounded" height={16} width="92%" />
                  <Skeleton variant="rounded" height={16} width="74%" />
                </Box>
              ) : hasHistory && visibleHistory ? (
                <Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
                    <HistoryIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {t('about.versionHistory')}
                    </Typography>
                  </Box>
                  {visibleHistory.map((entry, index) => {
                    const current = entry.version === updateStatus?.current_version
                    const isLast = index === visibleHistory.length - 1
                    return (
                      <Box key={entry.version} sx={{ display: 'flex', gap: 1.75 }}>
                        {/* Timeline rail: connector + node */}
                        <Box
                          sx={{
                            position: 'relative',
                            width: 12,
                            flexShrink: 0,
                            display: 'flex',
                            justifyContent: 'center',
                          }}
                        >
                          {!isLast && (
                            <Box
                              sx={{
                                position: 'absolute',
                                top: 15,
                                bottom: -4,
                                width: 2,
                                borderRadius: 1,
                                bgcolor: 'divider',
                              }}
                            />
                          )}
                          <Box
                            sx={{
                              width: current ? 12 : 10,
                              height: current ? 12 : 10,
                              mt: '5px',
                              borderRadius: '50%',
                              bgcolor: current ? 'primary.main' : 'background.paper',
                              border: '2px solid',
                              borderColor: current ? 'primary.main' : 'divider',
                              boxShadow: current
                                ? '0 0 0 3px rgba(217, 119, 87, 0.18)'
                                : 'none',
                              zIndex: 1,
                            }}
                          />
                        </Box>
                        <Box sx={{ flexGrow: 1, minWidth: 0, pb: isLast ? 0 : 2.5 }}>
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              flexWrap: 'wrap',
                              minHeight: 24,
                            }}
                          >
                            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                              v{entry.version}
                            </Typography>
                            {current && (
                              <Chip
                                label={t('about.thisBuild')}
                                size="small"
                                color="primary"
                                sx={{ height: 20 }}
                              />
                            )}
                            {entry.date && (
                              <Typography variant="caption" color="text.secondary">
                                {entry.date}
                              </Typography>
                            )}
                          </Box>
                          {entry.notes && (
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{ whiteSpace: 'pre-line', mt: 0.5 }}
                            >
                              {entry.notes}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    )
                  })}
                </Box>
              ) : !whatsNew ? (
                <Box
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}
                >
                  <InfoIcon fontSize="small" />
                  <Typography variant="body2">
                    {t('about.notesUnavailable')}
                  </Typography>
                </Box>
              ) : null}
            </Box>
          </Collapse>
        </Box>
      </Paper>

      <Typography variant="h6" sx={{ mb: 1 }}>
        {t('about.featuresHeading')}
      </Typography>
      <Grid container spacing={{ xs: 1, sm: 2 }}>
        {KEY_FEATURES.map((feature) => (
          <Grid size={{ xs: 12, sm: 6 }} key={feature.titleKey}>
            <Paper
              variant="outlined"
              sx={{
                p: { xs: 1.5, sm: 2 },
                height: '100%',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 1.5,
                transition: 'border-color 120ms ease, box-shadow 120ms ease',
                // Desktop-only affordance; touch devices keep the resting style.
                '@media (hover: hover)': {
                  '&:hover': {
                    borderColor: `${feature.color}.main`,
                    boxShadow: 2,
                  },
                },
              }}
            >
              <Box
                sx={(theme) => ({
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                  width: 40,
                  height: 40,
                  borderRadius: 2,
                  bgcolor: alpha(theme.palette[feature.color].main, 0.12),
                  color: `${feature.color}.main`,
                  '& svg': { fontSize: 22 },
                })}
              >
                {feature.icon}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.35 }}>
                  {t(feature.titleKey)}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {t(feature.descriptionKey)}
                </Typography>
              </Box>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>
        {t('about.ackHeading')}
      </Typography>
      <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {t('about.ackIntro')}
        </Typography>
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {ACKNOWLEDGEMENTS.map((entry) => (
            <Box key={entry.tab}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.35 }}>
                {entry.tab}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                {t('about.embeds')}{' '}
                <Box
                  component="a"
                  href={entry.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{ color: 'primary.main', textDecoration: 'underline' }}
                >
                  {entry.name}
                </Box>{' '}
                — {t(entry.descriptionKey)}
              </Typography>
            </Box>
          ))}
        </Box>
      </Paper>
    </Box>
  )
}

function SettingsPage({
  onStartUpdate,
  section: sectionProp,
  onSectionChange,
  expandUpdates,
}: SettingsPageProps) {
  const { t } = useTranslation('settings')
  const [internalSection, setInternalSection] = useState<SettingsSection>('connections')
  // Controlled when the app shell drives the section (AppBar badge click).
  const section = sectionProp ?? internalSection
  const setSection = (value: SettingsSection) => {
    setInternalSection(value)
    onSectionChange?.(value)
  }

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5">{t('page.title')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('page.subtitle')}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, alignItems: 'flex-start' }}>
        {/* Left navigation */}
        <Paper
          variant="outlined"
          sx={{ width: { xs: '100%', sm: 240 }, flexShrink: 0, alignSelf: 'stretch' }}
        >
          <List sx={{ px: 1, py: 1 }}>
            {SECTIONS.map((entry) => (
              <ListItemButton
                key={entry.value}
                selected={section === entry.value}
                onClick={() => setSection(entry.value)}
                sx={{ borderRadius: 1, minHeight: 48 }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>{entry.icon}</ListItemIcon>
                <ListItemText primary={t(entry.labelKey)} />
              </ListItemButton>
            ))}
          </List>
        </Paper>

        {/* Content pane — both sections stay mounted so their state survives */}
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Box sx={{ display: section === 'connections' ? 'block' : 'none' }}>
            <ConnectionsPage />
          </Box>
          <Box sx={{ display: section === 'ai' ? 'block' : 'none' }}>
            <AiSettingsPage />
          </Box>
          <Box sx={{ display: section === 'about' ? 'block' : 'none' }}>
            <AboutSection onStartUpdate={onStartUpdate} expandUpdates={expandUpdates} />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// The page stays mounted while another tab is shown, so memoising it keeps a
// view switch from re-rendering every other page in the shell.
export default memo(SettingsPage)
