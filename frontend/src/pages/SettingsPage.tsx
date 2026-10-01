import { memo, useCallback, useEffect, useState } from 'react'
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
   * Retained for the app shell's shut-down confirmation dialog. About no
   * longer renders a "Shut down server" entry, so Settings accepts but does
   * not currently use it.
   */
  onRequestShutdown?: () => void
}

const SECTIONS: { value: SettingsSection; label: string; icon: ReactElement }[] = [
  { value: 'connections', label: 'Connections', icon: <StorageIcon color="primary" /> },
  { value: 'ai', label: 'AI Assistant', icon: <AutoAwesomeIcon color="secondary" /> },

  { value: 'about', label: 'About', icon: <InfoIcon color="info" /> },
]

const APP_INFO: { label: string; value: string }[] = [
  { label: 'Designer', value: 'Alex Luo' },
  { label: 'Development Platform', value: 'Trae CN + Deepseek-v4-flash' },
  { label: 'Build Version', value: '1.0' },
]

/** How many releases About lists; older ones stay in version_history.json. */
const HISTORY_LIMIT = 5

/** Feature showcase palette — one accent per card so the grid stays scannable. */
type FeatureColor = 'primary' | 'info' | 'success' | 'warning' | 'secondary'

const KEY_FEATURES: { title: string; description: string; icon: ReactElement; color: FeatureColor }[] = [
  {
    title: 'ODBC Connections',
    icon: <StorageIcon />,
    color: 'primary',
    description:
      'Save any ODBC data source as a reusable profile: pick a driver, fill in the settings and test the connection before you query. Switch databases from the picker in the Query tab.',
  },
  {
    title: 'Visual Builder & SQL Editor',
    icon: <CodeIcon />,
    color: 'info',
    description:
      'Build a query without SQL — choose tables or views, then add filters, pick columns, set a date range and a row limit. Prefer raw SQL? Write it with dialect-aware formatting, or load a connection template to fill in the boilerplate.',
  },
  {
    title: 'Charts & KPIs',
    icon: <BarChartIcon />,
    color: 'warning',
    description:
      'Turn the current result set into 20 chart types — bar, line, area, pie, scatter, histogram, box, waterfall, heatmap and more — or KPI cards. Pick X / Y / colour fields and tune operations, sorting and Top-N.',
  },
  {
    title: 'Python Scripting',
    icon: <TerminalIcon />,
    color: 'secondary',
    description:
      'Run a Python script against every row in the grid, with live stdout/stderr you can copy out. Five ready-made examples and saveable custom scripts cover the common analysis steps.',
  },
  {
    title: 'Custom Queries & Run History',
    icon: <HistoryIcon />,
    color: 'info',
    description:
      'Save Builder or SQL queries as reusable custom queries — with value prompts and Excel reports — and reopen any of the last 20 runs, complete with its connection, row count, timing and SQL.',
  },
  {
    title: 'Tools & Integrations',
    icon: <AccountTreeIcon />,
    color: 'success',
    description:
      'Three embedded workspaces open in place: FlowDiagram for AI-assisted architecture diagrams, Project for Gantt-style timelines and ProblemSolving for metric-bowler breakdowns.',
  },
  {
    title: 'AI Assistant',
    icon: <AutoAwesomeIcon />,
    color: 'primary',
    description:
      'A docked assistant with SQL, script and chart modes: explain or optimise a query, draft a Python script, or describe a chart — then apply the answer straight into the editor, script or chart tab.',
  },
  {
    title: 'Automatic Updates',
    icon: <SystemUpdateAltIcon />,
    color: 'secondary',
    description:
      'The app checks for a newer build in the background every hour and, when one is found, downloads, checksum-verifies, swaps and restarts itself on request. Settings → About keeps the release notes and full version history.',
  },
]

/** Third-party apps embedded by the Tools tabs, credited to their authors. */
const ACKNOWLEDGEMENTS: { tab: string; name: string; href: string; description: string }[] = [
  {
    tab: 'FlowDiagram',
    name: 'next-ai-draw-io',
    href: 'https://github.com/DayuanJiang/next-ai-draw-io',
    description: 'AI-assisted draw.io diagrams, courtesy of DayuanJiang’s GitHub repository.',
  },
  {
    tab: 'Project',
    name: 'light-gantt',
    href: 'https://study-llm.me/apps/light-gantt/',
    description: 'a Gantt-style timeline planner hosted at study-llm.me.',
  },
  {
    tab: 'ProblemSolving',
    name: 'metric-bowler',
    href: 'https://study-llm.me/apps/a3-bowler/metric-bowler',
    description: 'a metric-bowler breakdown workspace hosted at study-llm.me.',
  },
]

/** States that mean an update is running, whether or not it was started from here. */
const UPDATE_BUSY = ['checking', 'downloading', 'verifying', 'waiting_idle', 'restarting']

/** The subset of those states that belong to an install, so they spin "Update now". */
const UPDATE_INSTALLING = ['downloading', 'verifying', 'waiting_idle', 'restarting']

function updateSummary(status: UpdateStatus | null): string {
  if (!status) return 'Loading update status…'
  if (status.state === 'error') return `Update check failed: ${status.error || status.message}`
  if (status.available)
    return `Update available: v${status.latest_version} (you are on v${status.current_version})${
      status.forced ? ' — required' : ''
    }`
  if (UPDATE_BUSY.includes(status.state)) return status.message || 'Update in progress…'
  if (!status.source) return 'No update source configured — automatic update checks are off.'
  if (status.checked_at)
    return `Up to date (v${status.current_version}) · last checked ${new Date(
      status.checked_at * 1000,
    ).toLocaleString()}`
  return `Up to date (v${status.current_version}).`
}

function AboutSection({
  onStartUpdate,
}: {
  /** Started in the shell so the whole app tracks the restart and reloads on it. */
  onStartUpdate: () => Promise<UpdateStatus | null>
}) {
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

  const runUpdateCheck = useCallback(async () => {
    setUpdateBusy(true)
    try {
      setUpdateStatus(await api.updateCheck())
    } catch (err) {
      setUpdateStatus((prev) =>
        prev
          ? { ...prev, state: 'error', error: err instanceof Error ? err.message : 'Check failed' }
          : prev,
      )
    } finally {
      setUpdateBusy(false)
    }
  }, [])

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
            alt="ODBC Query App logo"
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
            <Typography variant="h6">ODBC Query App</Typography>
            <Typography variant="body2" color="text.secondary">
              A desktop SQL query, analysis, and scripting workspace.
            </Typography>
          </Box>
        </Box>

        <Grid container spacing={{ xs: 1, sm: 2 }}>
          {APP_INFO.map((entry) => (
            <Grid size={{ xs: 12, sm: 4 }} key={entry.label}>
              <Paper
                variant="outlined"
                sx={{ p: { xs: 1.5, sm: 2 }, height: '100%', bgcolor: 'background.paper' }}
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
                  {entry.label}
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600, mt: 0.5 }}>
                  {entry.label === 'Build Version'
                    ? updateStatus?.current_version ?? '—'
                    : entry.value}
                </Typography>
              </Paper>
            </Grid>
          ))}
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
            Updates
          </Typography>
        </Box>
        <Typography
          variant="body2"
          color="text.secondary"
          role="status"
          aria-live="polite"
          sx={{ mb: 2 }}
        >
          {updateSummary(updateStatus)}
        </Typography>
        {!updateStatus?.supported && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Automatic self-update is only available in the packaged desktop app. To update a
            development checkout, stop the server, replace the files and start it again.
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
            Check now
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
            Update now
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
            What’s new &amp; version history
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
                      What’s new in v{whatsNew.version}
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
                      Version history
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
                                label="this build"
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
                    Release notes aren’t available in this build.
                  </Typography>
                </Box>
              ) : null}
            </Box>
          </Collapse>
        </Box>
      </Paper>

      <Typography variant="h6" sx={{ mb: 1 }}>
        Key Functions &amp; Features
      </Typography>
      <Grid container spacing={{ xs: 1, sm: 2 }}>
        {KEY_FEATURES.map((feature) => (
          <Grid size={{ xs: 12, sm: 6 }} key={feature.title}>
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
                  {feature.title}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {feature.description}
                </Typography>
              </Box>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>
        Acknowledgements
      </Typography>
      <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          The Tools tabs embed third-party apps. Credit belongs to their authors:
        </Typography>
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {ACKNOWLEDGEMENTS.map((entry) => (
            <Box key={entry.tab}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.35 }}>
                {entry.tab}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                Embeds{' '}
                <Box
                  component="a"
                  href={entry.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{ color: 'primary.main', textDecoration: 'underline' }}
                >
                  {entry.name}
                </Box>{' '}
                — {entry.description}
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
}: SettingsPageProps) {
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
        <Typography variant="h5">Settings</Typography>
        <Typography variant="body2" color="text.secondary">
          Configure connections and the AI assistant, and view
          app information.
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
                <ListItemText primary={entry.label} />
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
            <AboutSection onStartUpdate={onStartUpdate} />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// The page stays mounted while another tab is shown, so memoising it keeps a
// view switch from re-rendering every other page in the shell.
export default memo(SettingsPage)
