import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import Alert from '@mui/material/Alert'
import AppBar from '@mui/material/AppBar'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import AppsIcon from '@mui/icons-material/Apps'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CodeIcon from '@mui/icons-material/Code'
import CloseIcon from '@mui/icons-material/Close'
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined'
import InfoIcon from '@mui/icons-material/Info'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import RefreshIcon from '@mui/icons-material/Refresh'
import ReplayIcon from '@mui/icons-material/Replay'
import SettingsIcon from '@mui/icons-material/Settings'
import StorageIcon from '@mui/icons-material/Storage'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import TerminalIcon from '@mui/icons-material/Terminal'
import TroubleshootIcon from '@mui/icons-material/Troubleshoot'
import ViewTimelineIcon from '@mui/icons-material/ViewTimeline'

import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import theme from './theme'
import { api, sendTabLeftBeacon } from './api/client'
import type { FeedbackThread, UpdateStatus } from './api/client'
import WorkspacePage, { type WorkspacePageHandle } from './pages/WorkspacePage'
import ScriptPage, { type ScriptPageHandle } from './pages/ScriptPage'
import SettingsPage, { type SettingsSection } from './pages/SettingsPage'
import FeedbackPage from './pages/FeedbackPage'
import FlowDiagramPage from './pages/FlowDiagramPage'
import ExternalAppPage from './pages/ExternalAppPage'
import AiSidebar from './components/AiSidebar'
import GuidedTour, { TOUR_STORAGE_KEY } from './components/GuidedTour'
import type { AiMode } from './types'

type View = 'editor' | 'script' | 'flowdiagram' | 'project' | 'problemsolving' | 'settings'

/** Tabs that sit directly in the top bar. */
const MAIN_TABS: { value: View; label: string; icon: ReactElement }[] = [
  { value: 'editor', label: 'Query', icon: <CodeIcon color="primary" /> },
  { value: 'script', label: 'Analyze', icon: <TerminalIcon color="secondary" /> },
]

/** Grouped behind a single menu button to keep the bar uncluttered. */
const TOOL_TABS: { value: View; label: string; icon: ReactElement }[] = [
  { value: 'flowdiagram', label: 'FlowDiagram', icon: <AccountTreeIcon color="info" /> },
  { value: 'project', label: 'Project', icon: <ViewTimelineIcon color="success" /> },
  { value: 'problemsolving', label: 'ProblemSolving', icon: <TroubleshootIcon color="error" /> },
]

const SETTINGS_TAB: { value: View; label: string; icon: ReactElement } = {
  value: 'settings',
  label: 'Settings',
  icon: <SettingsIcon color="warning" />,
}

/** Board posts this machine has already looked at — the feedback badge counts the rest. */
const FEEDBACK_SEEN_KEY = 'odbc-feedback-seen-ids'

/**
 * The "last seen" timestamp the key above replaced. It is only read, once, so
 * the read state built under the old scheme carries over to ids.
 */
const LEGACY_FEEDBACK_SEEN_KEY = 'odbc-feedback-seen-at'

/** How often the top bar re-counts unread posts while the app is in front. */
const FEEDBACK_UNREAD_INTERVAL_MS = 120000

/** Ids of the posts this machine has recorded as read (empty on a first run). */
function readFeedbackSeenIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FEEDBACK_SEEN_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    /* storage unavailable, or a malformed value — nothing recorded */
    return []
  }
}

function writeFeedbackSeenIds(ids: string[]): void {
  try {
    window.localStorage.setItem(FEEDBACK_SEEN_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable — the in-memory ids still cover this session */
  }
}

/** The old "last seen" timestamp in ms, or null when there is none to carry over. */
function readLegacyFeedbackSeenAt(): number | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_FEEDBACK_SEEN_KEY)
    const stamp = raw ? Number(raw) : Number.NaN
    return Number.isFinite(stamp) && stamp > 0 ? stamp : null
  } catch {
    return null
  }
}

/** Tabs value used by the menu button (not a real View). */
const TOOLS_TAB_VALUE = 'tools'

const HELP_STEPS: { title: string; description: string }[] = [
  {
    title: 'Save the app as a bookmark',
    description:
      'First time: double-click ODBCQueryApp.exe once — that one launch registers the odbcapp:// link on your PC, and the app opens in your browser. From then on you never need to find the exe again: type odbcapp:// in the browser address bar, allow the prompt, and save it as a bookmark. Clicking that bookmark starts the app when it is closed, and just opens a new tab when it is already running.',
  },
  {
    title: 'Connect to a data source',
    description:
      'Open Settings → Connections → Add connection. Pick your ODBC driver, fill in the connection settings, then click "Test" to verify. Saved connections are shown as a badge next to this help button.',
  },
  {
    title: 'Run a query',
    description:
      'Go to the Query tab. Build your query with the visual builder or write raw SQL on the right, then click Run. Results load into the grid below.',
  },
  {
    title: 'Explore the results',
    description:
      'Sort, filter, and export (CSV / Excel) from the grid. Each column header shows its detected type (Number / Text / Boolean / Date) — click the chip to change it.',
  },
  {
    title: 'Visualize with charts',
    description:
      'Open Analyze → Chart to turn your results into bar, pie, trend, scatter, histogram, box, or KPI charts. Pick an X axis and a Y axis (numeric or categorical); the operation options adapt to the Y column type.',
  },
  {
    title: 'Analyze with scripts',
    description:
      'Open the Analyze tab and write a Python or JavaScript script. The script runs against all the rows in the grid. Use the "Copy output" button to copy what it prints.',
  },
  {
    title: 'Use the AI assistant',
    description:
      'The AI panel (available from the Query, Analyze, and Chart tabs) helps you write SQL, build scripts, and interpret your data.',
  },
]

/** Simplified Chinese copy of HELP_STEPS, shown when the dialog toggles 中文. */
const HELP_STEPS_ZH: { title: string; description: string }[] = [
  {
    title: '把应用保存为书签',
    description:
      '首次使用：先双击一次 ODBCQueryApp.exe——这一次启动会在电脑上注册 odbcapp:// 链接，应用随即在浏览器中打开。此后就不必再找 exe 了：在浏览器地址栏输入 odbcapp://，允许弹出的提示，并把它保存为书签。以后点击该书签即可：应用未运行时会自动启动，已在运行时则新开一个标签页。',
  },
  {
    title: '连接数据源',
    description:
      '打开 设置 → 连接 → 添加连接。选择你的 ODBC 驱动，填写连接参数，然后点击"测试"验证。已保存的连接会显示在此帮助按钮旁边的徽标上。',
  },
  {
    title: '运行查询',
    description:
      '切换到"查询"标签页。用可视化构建器搭建查询，或者在右侧直接写 SQL，然后点击"运行"。结果会加载到下方的表格中。',
  },
  {
    title: '浏览结果',
    description:
      '在表格中排序、筛选和导出（CSV / Excel）。每个列头都会显示识别出的类型（数字 / 文本 / 布尔 / 日期）——点击类型标签即可修改。',
  },
  {
    title: '用图表可视化',
    description:
      '打开 分析 → 图表，把结果变成柱状图、饼图、趋势图、散点图、直方图、箱线图或 KPI 卡片。选择 X 轴和 Y 轴（数值或分类），操作选项会根据 Y 列的类型自动调整。',
  },
  {
    title: '用脚本深入分析',
    description:
      '打开"分析"标签页，编写 Python 或 JavaScript 脚本。脚本会针对表格中的所有行运行。用"复制输出"按钮复制脚本打印的内容。',
  },
  {
    title: '使用 AI 助手',
    description:
      'AI 面板（可在"查询""分析""图表"标签页中打开）可以帮助你编写 SQL、构建脚本并解读数据。',
  },
]

type HelpLanguage = 'en' | 'zh'

/** Static labels of the "How to use this app" dialog, per language. */
const HELP_CHROME: Record<
  HelpLanguage,
  { title: string; close: string; firstRunTitle: string; firstRunHint: string; replay: string }
> = {
  en: {
    title: 'How to use this app',
    close: 'Close',
    firstRunTitle: 'First-run guide',
    firstRunHint:
      'Walk through ODBC detection, template queries, and template scripts step by step.',
    replay: 'Replay guide',
  },
  zh: {
    title: '如何使用本应用',
    close: '关闭',
    firstRunTitle: '首次使用引导',
    firstRunHint: '逐步演示 ODBC 检测、模板查询与模板脚本的完整流程。',
    replay: '重播引导',
  },
}

function HowToUseDialog({
  open,
  onClose,
  onReplayTour,
}: {
  open: boolean
  onClose: () => void
  onReplayTour: () => void
}) {
  const [language, setLanguage] = useState<HelpLanguage>('en')
  const steps = language === 'zh' ? HELP_STEPS_ZH : HELP_STEPS
  const text = HELP_CHROME[language]

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          pr: 1,
        }}
      >
        {text.title}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <ToggleButtonGroup
            value={language}
            exclusive
            size="small"
            onChange={(_event, next: HelpLanguage | null) => {
              if (next) setLanguage(next)
            }}
            aria-label="Help language"
          >
            <ToggleButton value="en" sx={{ px: 1.25, minHeight: 32 }}>
              EN
            </ToggleButton>
            <ToggleButton value="zh" sx={{ px: 1.25, minHeight: 32 }}>
              中文
            </ToggleButton>
          </ToggleButtonGroup>
          <IconButton onClick={onClose} aria-label={text.close} size="small" sx={{ mr: -0.5 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {steps.map((step, index) => (
            <Box component="li" key={step.title} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
              <Box
                sx={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  mt: 0.25,
                }}
              >
                {index + 1}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2">{step.title}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {step.description}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>

        {/* First-run guide: replays the step-by-step spotlight tour. */}
        <Box
          sx={{
            mt: 3,
            pt: 2.5,
            borderTop: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            flexWrap: 'wrap',
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {text.firstRunTitle}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {text.firstRunHint}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<ReplayIcon />}
            onClick={onReplayTour}
            sx={{ minHeight: 44, flexShrink: 0 }}
          >
            {text.replay}
          </Button>
        </Box>
      </DialogContent>
    </Dialog>
  )
}

type ShutdownStage = 'confirm' | 'stopping' | 'stopped' | 'error'

function ShutdownDialog({
  open,
  stage,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean
  stage: ShutdownStage
  error: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onClose={stage === 'stopping' ? undefined : onClose} maxWidth="xs">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PowerSettingsNewIcon color="error" fontSize="small" />
        Shut down server
      </DialogTitle>
      <DialogContent dividers>
        {stage === 'confirm' && (
          <Typography color="text.secondary">
            This stops the embedded ODBCQueryApp server and disconnects any connected users. You
            can close this tab afterwards. Continue?
          </Typography>
        )}
        {stage === 'stopping' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <CircularProgress size={20} />
            <Typography color="text.secondary">Stopping the server…</Typography>
          </Box>
        )}
        {stage === 'stopped' && (
          <Typography color="text.secondary">
            The server has been stopped. You can now close this tab.
          </Typography>
        )}
        {stage === 'error' && (
          <Typography color="error">Could not stop the server: {error}</Typography>
        )}
      </DialogContent>
      <DialogActions>
        {stage === 'confirm' && (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button color="error" variant="contained" onClick={onConfirm}>
              Shut down server
            </Button>
          </>
        )}
        {(stage === 'stopped' || stage === 'error') && <Button onClick={onClose}>Close</Button>}
      </DialogActions>
    </Dialog>
  )
}

/** Minimum time the "reconnecting" state stays on screen during a manual retry. */
const RETRY_MIN_FEEDBACK_MS = 900

/**
 * Watch the local backend: heartbeat + fast health probes.
 *
 * The packaged exe restarts its embedded server automatically when the tab
 * goes silent (laptop sleep, frozen tab), keeping the same port. This hook
 * notices an outage (heartbeat/health failing -> offline banner), polls
 * `/api/health` every 4s while offline, and flips back automatically the
 * moment the server answers again — the page heals itself without a reload,
 * keeping all in-app state. `retryNow` lets the user force an instant probe;
 * `retrying` / `retryResult` expose that manual attempt so the banner can show
 * an in-progress state and then a pass/fail verdict.
 */
function useBackendConnection(): {
  online: boolean
  reconnected: boolean
  retrying: boolean
  retryResult: 'success' | 'fail' | null
  retryNow: () => void
  dismissReconnected: () => void
} {
  const [online, setOnline] = useState(true)
  const [reconnected, setReconnected] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryResult, setRetryResult] = useState<'success' | 'fail' | null>(null)
  const probeRef = useRef<() => Promise<boolean>>(async () => true)
  // True while a manual retry is in flight: it suppresses the automatic
  // "reconnected" snackbar so a manual retry reports its own result instead.
  const retryBusyRef = useRef(false)

  useEffect(() => {
    // Mirrors `online` inside callbacks without re-running the effect.
    let up = true
    const mark = (isUp: boolean): boolean => {
      if (up !== isUp) {
        up = isUp
        setOnline(isUp)
        if (isUp && !retryBusyRef.current) setReconnected(true)
      }
      return isUp
    }
    const probe = () => api.health().then(() => mark(true), () => mark(false))
    const beat = () => api.heartbeat().then(() => mark(true), () => mark(false))
    probeRef.current = beat
    const onVisible = () => {
      // Coming back from sleep / a hidden tab: check right away.
      if (document.visibilityState === 'visible') probe()
    }
    const onTabLeft = () => sendTabLeftBeacon()
    beat() // first beat immediately: also tells the backend this tab is back
    const beatTimer = window.setInterval(beat, 15000)
    const probeTimer = window.setInterval(() => {
      if (!up) probe()
    }, 4000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pagehide', onTabLeft)
    return () => {
      window.clearInterval(beatTimer)
      window.clearInterval(probeTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pagehide', onTabLeft)
      // No goodbye beacon here: an unmount is not necessarily a page close
      // (e.g. StrictMode re-mounts in dev); `pagehide` covers real unloads.
    }
  }, [])

  const retryNow = useCallback(() => {
    if (retryBusyRef.current) return
    retryBusyRef.current = true
    setRetrying(true)
    setRetryResult(null)
    // A refused socket fails in milliseconds, which would flash the
    // "reconnecting" state past the eye — hold it briefly so the user actually
    // sees the attempt before the verdict lands.
    const started = Date.now()
    probeRef.current().then((ok) => {
      const remaining = Math.max(0, RETRY_MIN_FEEDBACK_MS - (Date.now() - started))
      window.setTimeout(() => {
        retryBusyRef.current = false
        setRetrying(false)
        setRetryResult(ok ? 'success' : 'fail')
      }, remaining)
    })
  }, [])
  const dismissReconnected = useCallback(() => setReconnected(false), [])

  // Clear the pass/fail verdict a few seconds after a manual retry finishes.
  useEffect(() => {
    if (!retryResult) return
    const timer = window.setTimeout(() => setRetryResult(null), 6000)
    return () => window.clearTimeout(timer)
  }, [retryResult])

  return { online, reconnected, retrying, retryResult, retryNow, dismissReconnected }
}

// ---- Self-update UI state (backend app/update.py) ----

const UPDATE_DISMISS_KEY = 'odbc_update_dismissed'
const UPDATE_BUSY_STATES = ['checking', 'downloading', 'verifying', 'waiting_idle', 'restarting']
/** How long the "updated" toast stays up before the page reloads onto the new bundle. */
const UPDATE_RELOAD_DELAY_MS = 1500

/**
 * Set only while this tab is waiting for an install it started to land, holding
 * the version that was running when the install was claimed. The reload normally
 * keys off a version change, but a rebuild can be published under an unchanged
 * number, and a tab that never managed to read a status has no baseline at all —
 * this marker makes the reload fire in both cases. sessionStorage keeps it
 * scoped to this tab, and it is cleared the moment the reload is scheduled.
 */
const UPDATE_INSTALL_KEY = 'odbc_update_installing'

function writeInstallMarker(fromVersion: string): void {
  try {
    window.sessionStorage.setItem(UPDATE_INSTALL_KEY, fromVersion)
  } catch {
    /* storage unavailable */
  }
}

function installMarker(): string | null {
  try {
    return window.sessionStorage.getItem(UPDATE_INSTALL_KEY)
  } catch {
    return null
  }
}

function clearInstallMarker(): void {
  try {
    window.sessionStorage.removeItem(UPDATE_INSTALL_KEY)
  } catch {
    /* storage unavailable */
  }
}

function formatDownloadRate(rate: number | null | undefined): string {
  if (!rate || rate <= 0) return ''
  const kb = rate / 1024
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(kb))} kB/s`
}

function updateStatusLabel(status: UpdateStatus): string {
  switch (status.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading': {
      const rate = formatDownloadRate(status.download_rate)
      const rateText = rate ? ` · ${rate}` : ''
      return status.download_percent != null
        ? `Downloading version ${status.latest_version}… ${status.download_percent}%${rateText}`
        : `Downloading version ${status.latest_version}…${rateText}`
    }
    case 'verifying':
      return 'Verifying the download…'
    case 'waiting_idle':
      return 'Waiting for running queries to finish…'
    case 'restarting':
      return 'Installing the update and restarting — this tab reconnects automatically.'
    default:
      return ''
  }
}

/**
 * Mirror the backend updater state and drive the "update available" UX.
 *
 * The backend checks the published manifest on its own (8s after boot, then
 * every 6h); this hook only reads/polls. While an install is running the poll
 * tightens to 3s so progress feels live, and the moment the restarted backend
 * reports a *different* version we know this tab survived an auto-update — the
 * page then reloads so the browser runs the new frontend bundle instead of the
 * stale one still in memory.
 */
function useAppUpdate(online: boolean) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string>(() => {
    try {
      return window.sessionStorage.getItem(UPDATE_DISMISS_KEY) || ''
    } catch {
      return ''
    }
  })
  const [updatedTo, setUpdatedTo] = useState('')
  const statusRef = useRef<UpdateStatus | null>(null)
  const knownVersionRef = useRef<string | null>(null)
  // Ensures the post-update reload is scheduled at most once, even if several
  // status polls land between the version flip and the reload.
  const reloadScheduledRef = useRef(false)
  // Consecutive status polls that failed while an install was in flight.
  const failStreakRef = useRef(0)
  const [restartStalled, setRestartStalled] = useState(false)

  const apply = useCallback((next: UpdateStatus): UpdateStatus => {
    statusRef.current = next
    setStatus(next)
    // A failed install leaves the app on the build it already had, so drop the
    // marker — otherwise the next successful manifest check would move the state
    // off "error" and look like a restart that never happened.
    if (next.state === 'error') clearInstallMarker()
    // Two independent signals that this tab outlived an update:
    //  - the backend now reports a different build than the one last read;
    //  - this tab started an install and the backend is back in a settled state.
    //    Only a restart can take the state from a busy one to a settled one, and
    //    this covers a rebuild published under an unchanged version number.
    // Either way the page is still executing the previous bundle, so reload it to
    // pull the newly hashed assets (index.html is served no-cache, so the reload
    // always revalidates). A short toast explains the pending refresh.
    const versionChanged =
      knownVersionRef.current !== null &&
      !!next.current_version &&
      next.current_version !== knownVersionRef.current
    const installLanded =
      installMarker() !== null && !UPDATE_BUSY_STATES.includes(next.state) && next.state !== 'error'
    if (versionChanged || installLanded) {
      setUpdatedTo(next.current_version)
      try {
        window.sessionStorage.removeItem(UPDATE_DISMISS_KEY)
      } catch {
        /* storage unavailable */
      }
      setDismissedVersion('')
      clearInstallMarker()
      if (!reloadScheduledRef.current) {
        reloadScheduledRef.current = true
        window.setTimeout(() => window.location.reload(), UPDATE_RELOAD_DELAY_MS)
      }
    }
    knownVersionRef.current = next.current_version
    return next
  }, [])

  const refresh = useCallback(() => {
    api
      .updateStatus()
      .then((next) => {
        failStreakRef.current = 0
        setRestartStalled(false)
        apply(next)
      })
      .catch(() => {
        // Offline, or an older backend without the update endpoints. While an
        // install is in flight the exe is restarting, so silence is expected —
        // but if the relaunched process never comes up the banner would freeze
        // at "restarting…" forever. After ~3 missed polls, tell the user how
        // to finish by hand.
        const state = statusRef.current?.state
        if (state && UPDATE_BUSY_STATES.includes(state)) {
          failStreakRef.current += 1
          if (failStreakRef.current >= 3) setRestartStalled(true)
        }
      })
  }, [apply])

  const check = useCallback(() => {
    api
      .updateCheck()
      .then(apply)
      .catch(() => {
        /* backend will retry on its own schedule */
      })
  }, [apply])

  // First paint: read status, then nudge a fresh check shortly after mount.
  useEffect(() => {
    refresh()
    const timer = window.setTimeout(check, 1500)
    return () => window.clearTimeout(timer)
  }, [refresh, check])

  const busy = !!status && UPDATE_BUSY_STATES.includes(status.state)

  useEffect(() => {
    const timer = window.setInterval(refresh, busy ? 3000 : 300000)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  // Coming back online (e.g. the updater's restart finished) — re-read at once.
  useEffect(() => {
    if (online) refresh()
  }, [online, refresh])

  // Shared by every "Update now" in the app — the banner, the forced dialog and
  // the About page — so one poller tracks the install and owns the reload.
  const startUpdate = useCallback(async (): Promise<UpdateStatus | null> => {
    try {
      const next = await api.updateStart()
      // Arm the marker only once the backend has claimed the install: an
      // unclaimed status (still idle) must not read as "came back after a
      // restart". The version it reports is still the one this tab is running.
      if (UPDATE_BUSY_STATES.includes(next.state)) writeInstallMarker(next.current_version)
      return apply(next)
    } catch (err: unknown) {
      const current = statusRef.current
      if (!current) return null
      return apply({
        ...current,
        state: 'error',
        error: err instanceof Error ? err.message : 'Update could not be started.',
        message: 'Update could not be installed.',
      })
    }
  }, [apply])

  const dismiss = useCallback(() => {
    const version = statusRef.current?.latest_version || ''
    try {
      window.sessionStorage.setItem(UPDATE_DISMISS_KEY, version)
    } catch {
      /* storage unavailable */
    }
    setDismissedVersion(version)
  }, [])

  return {
    status,
    busy,
    restartStalled,
    updateLabel: status ? updateStatusLabel(status) : '',
    startUpdate,
    dismiss,
    dismissedVersion,
    check,
    updatedTo,
    dismissUpdated: () => setUpdatedTo(''),
  }
}

function AppShell() {
  const [view, setView] = useState<View>('editor')
  // Anchor element for the grouped FlowDiagram / Project / ProblemSolving menu.
  const [toolsAnchor, setToolsAnchor] = useState<HTMLElement | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('connections')
  const [helpOpen, setHelpOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Posts made since this machine last opened the board, counted for the badge.
  const [feedbackUnread, setFeedbackUnread] = useState(0)
  const [shutdownOpen, setShutdownOpen] = useState(false)
  const [shutdownStage, setShutdownStage] = useState<ShutdownStage>('confirm')
  const [shutdownError, setShutdownError] = useState('')

  // ---- First-run guided tour ----
  // Starts once shortly after launch, and only when the user has never seen it.
  // The "How to use this app" dialog offers a replay that just increments this counter.
  const [tourRun, setTourRun] = useState(0)
  useEffect(() => {
    let done = false
    try {
      done = window.localStorage.getItem(TOUR_STORAGE_KEY) === 'done'
    } catch {
      /* storage unavailable */
    }
    if (done) return
    const timer = window.setTimeout(() => setTourRun((count) => count + 1), 900)
    return () => window.clearTimeout(timer)
  }, [])

  // Stable identity so the memoized SettingsPage does not re-render on
  // every AppShell render (e.g. on unrelated state such as view switches).
  const openShutdown = useCallback(() => {
    setShutdownStage('confirm')
    setShutdownError('')
    setShutdownOpen(true)
  }, [])

  const confirmShutdown = async () => {
    setShutdownStage('stopping')
    setShutdownError('')
    try {
      await api.shutdown()
      setShutdownStage('stopped')
    } catch (err) {
      setShutdownError(err instanceof Error ? err.message : 'Unexpected error')
      setShutdownStage('error')
    }
  }

  // ---- Keep-alive heartbeat + auto-reconnect ----
  // Pings the backend every 15s (tagged with this tab's id). The backend
  // watchdog / launcher keep the local server alive: if it dies (laptop
  // sleep, frozen tab) the launcher restarts it on the same port and this
  // hook notices, showing a banner until the connection is back — no reload.
  const connection = useBackendConnection()

  // ---- Unread feedback badge ----
  // The board has no accounts, so "read" is per machine and has to live here.
  // The posts this machine has looked at are remembered by id rather than by a
  // "last seen" timestamp: a timestamp has to be compared against the server's
  // created_at on every re-count, which re-flags a post whenever the two clocks
  // disagree. Ids are stable, so a post that was read stays read.
  const feedbackSeenIds = useRef<Set<string>>(new Set(readFeedbackSeenIds()))

  /**
   * Re-counts the badge from one board snapshot, first recording the posts that
   * `nowRead` picks out as read. Deriving the count from the same snapshot keeps
   * the two in step: nothing picked out as read can still be counted.
   */
  const syncFeedbackUnread = useCallback(
    (threads: FeedbackThread[], nowRead?: (thread: FeedbackThread) => boolean) => {
      if (nowRead) {
        let recorded = false
        for (const thread of threads) {
          if (!nowRead(thread) || feedbackSeenIds.current.has(thread.id)) continue
          feedbackSeenIds.current.add(thread.id)
          recorded = true
        }
        if (recorded) writeFeedbackSeenIds([...feedbackSeenIds.current])
      }
      setFeedbackUnread(
        threads.filter((thread) => !thread.mine && !feedbackSeenIds.current.has(thread.id)).length,
      )
    },
    [],
  )

  /** Re-counts the board; failures keep the old count. */
  const countUnreadFeedback = useCallback(async () => {
    try {
      const { threads } = await api.feedbackThreads()
      syncFeedbackUnread(threads)
    } catch {
      /* board unreachable — leave the badge as it was */
    }
  }, [syncFeedbackUnread])

  /** Records every post on the board as read — opening or closing it means seen. */
  const markBoardRead = useCallback(async () => {
    try {
      const { threads } = await api.feedbackThreads()
      syncFeedbackUnread(threads, (thread) => !thread.mine)
    } catch {
      /* board unreachable — leave the badge as it was */
    }
  }, [syncFeedbackUnread])

  useEffect(() => {
    if (!connection.online) return
    void countUnreadFeedback()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void countUnreadFeedback()
    }, FEEDBACK_UNREAD_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [connection.online, countUnreadFeedback])

  // One-time carry-over from the old "last seen" timestamp: everything already
  // posted when the board was last opened counted as read back then, so record
  // those ids — otherwise the whole board would come back as unread. The stamp
  // is dropped only once the ids are safely stored, so a failed fetch retries.
  useEffect(() => {
    const legacySeenAt = readLegacyFeedbackSeenAt()
    if (legacySeenAt === null) return
    let cancelled = false
    void (async () => {
      let threads: FeedbackThread[]
      try {
        ;({ threads } = await api.feedbackThreads())
      } catch {
        return
      }
      if (cancelled) return
      syncFeedbackUnread(
        threads,
        (thread) => !thread.mine && Date.parse(thread.created_at) <= legacySeenAt,
      )
      try {
        window.localStorage.removeItem(LEGACY_FEEDBACK_SEEN_KEY)
      } catch {
        /* storage unavailable — the carry-over just repeats next launch */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [syncFeedbackUnread])

  // ---- Self update (banner / forced dialog / one-click install) ----
  const update = useAppUpdate(connection.online)
  const updateStatus = update.status
  const optionalUpdateVisible =
    !!updateStatus &&
    updateStatus.available &&
    !updateStatus.forced &&
    (update.busy || update.dismissedVersion !== updateStatus.latest_version)
  const forcedUpdateVisible = !!updateStatus && updateStatus.available && updateStatus.forced

  // ---- Connection banner state (offline / manual retry) ----
  // The banner is hidden during a deliberate in-app shutdown: the dialog
  // already explains that one.
  const connectionLost =
    !connection.online &&
    !(shutdownOpen && (shutdownStage === 'stopping' || shutdownStage === 'stopped'))
  const connectionBanner = connection.retrying
    ? 'retrying'
    : connection.retryResult === 'success'
      ? 'retried'
      : connection.retryResult === 'fail'
        ? 'failed'
        : connectionLost
          ? 'offline'
          : null

  // ---- Global AI assistant sidebar ----
  const [aiOpen, setAiOpen] = useState(false)
  const [aiMode, setAiMode] = useState<AiMode>('sql')

  // All callbacks handed to (memoized) pages are stable, so switching views
  // only re-renders the incoming page instead of every mounted page.
  const openAi = useCallback((mode: AiMode) => {
    setAiMode(mode)
    setAiOpen(true)
  }, [])
  const closeAi = useCallback(() => setAiOpen(false), [])
  const openEditor = useCallback(() => setView('editor'), [])
  const openScript = useCallback(() => setView('script'), [])
  const closeHelp = useCallback(() => setHelpOpen(false), [])
  // Opening the board reads everything on it; closing re-reads, so a post that
  // arrived while the board was open is not left flagged as unread.
  const openFeedback = useCallback(() => {
    void markBoardRead()
    setFeedbackOpen(true)
  }, [markBoardRead])
  const closeFeedback = useCallback(() => {
    void markBoardRead()
    setFeedbackOpen(false)
  }, [markBoardRead])
  const replayTour = useCallback(() => {
    setHelpOpen(false)
    setTourRun((count) => count + 1)
  }, [])

  // ---- Mounted pages: refresh on open, not on every switch ----
  // Every page stays mounted so its state survives a tab switch. Instead of an
  // "active" flag — which flips on the way out too, re-rendering the page that
  // is being hidden — the shell asks the page being opened to refresh itself
  // through a ref. The outgoing page therefore does no work at all.
  const workspaceRef = useRef<WorkspacePageHandle>(null)
  const scriptRef = useRef<ScriptPageHandle>(null)
  const viewRef = useRef(view)
  useEffect(() => {
    const previous = viewRef.current
    viewRef.current = view
    // The mount effects inside the pages already did the initial fetch.
    if (previous === view) return
    if (view === 'editor') workspaceRef.current?.refresh()
    else if (view === 'script') scriptRef.current?.refresh()
  }, [view])

  // Which grouped tool (if any) is showing — drives the menu button's icon/label.
  const activeTool = TOOL_TABS.find((tool) => tool.value === view)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Offline banner: shown while the local server is unreachable. The
          launcher is restarting it in the background; this tab reconnects by
          itself, so no reload is needed — the banner just explains what's
          happening and offers a manual retry. "Retry now" reports its own
          in-progress state and final pass/fail verdict here. Sits above
          everything — including the nav bar — so it is impossible to miss.
          Suppressed after a deliberate in-app shutdown (the dialog already
          explains that one). */}
      {connectionBanner && (
        <Alert
          severity={
            connectionBanner === 'retried'
              ? 'success'
              : connectionBanner === 'retrying'
                ? 'info'
                : 'error'
          }
          variant="filled"
          icon={
            connectionBanner === 'retrying' ? (
              <CircularProgress size={20} color="inherit" />
            ) : undefined
          }
          sx={{
            borderRadius: 0,
            py: 1.25,
            justifyContent: 'center',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.22)',
            '& .MuiAlert-message': { fontWeight: 600 },
          }}
          action={
            <Button
              color="inherit"
              size="small"
              disabled={connectionBanner === 'retrying'}
              onClick={connection.retryNow}
              sx={{ '&&': { minHeight: { xs: 48, sm: 44 } }, whiteSpace: 'nowrap' }}
            >
              {connectionBanner === 'retrying' ? 'Reconnecting…' : 'Retry now'}
            </Button>
          }
        >
          {connectionBanner === 'retrying' &&
            'Reconnecting to the local server… testing the connection now.'}
          {connectionBanner === 'retried' &&
            'Reconnected — the local server is answering again. Carry on; no refresh needed.'}
          {connectionBanner === 'failed' &&
            'Retry failed — the local server is still not answering. It may still be starting up; try again in a moment.'}
          {connectionBanner === 'offline' &&
            'Lost connection to the local server. Your work is safe in this tab. It usually comes back on its own within a minute; if not, launch ODBCQueryApp.exe again — the page will reconnect without a refresh.'}
        </Alert>
      )}

      {/* Update banner: a newer build is published on Supabase. "Update now"
          downloads, swaps and restarts the exe while this page stays open;
          "Later" hides it until the next new version. Sits above the nav bar so
          it is the first thing seen. */}
      {optionalUpdateVisible && updateStatus && (
        <Alert
          variant="filled"
          severity={updateStatus.state === 'error' ? 'warning' : 'info'}
          icon={<SystemUpdateAltIcon fontSize="inherit" />}
          sx={{
            borderRadius: 0,
            py: 1,
            justifyContent: { xs: 'flex-start', sm: 'center' },
            // On phones the action block drops onto its own row so the buttons
            // become full-width 48px touch targets instead of a cramped column.
            flexWrap: { xs: 'wrap', sm: 'nowrap' },
            '& .MuiAlert-action': {
              flexBasis: { xs: '100%', sm: 'auto' },
              alignItems: { xs: 'stretch', sm: 'center' },
              pl: { xs: 0, sm: 2 },
              pt: { xs: 1, sm: 0 },
              mr: 0,
            },
          }}
          action={
            update.busy ? undefined : (
              <Box
                sx={{
                  display: 'flex',
                  flexGrow: { xs: 1, sm: 0 },
                  flexDirection: { xs: 'column', sm: 'row' },
                  alignItems: { xs: 'stretch', sm: 'center' },
                  gap: 0.5,
                }}
              >
                {/* Without the packaged exe the backend answers /update/start
                    with a 400, so offering the button only produced a banner
                    that flipped to warning with nothing happening. */}
                {updateStatus.supported && (
                  <Button
                    color="inherit"
                    size="small"
                    onClick={update.startUpdate}
                    sx={{ '&&': { minHeight: { xs: 48, sm: 44 } } }}
                  >
                    Update now
                  </Button>
                )}
                <Button
                  color="inherit"
                  size="small"
                  onClick={update.dismiss}
                  sx={{ '&&': { minHeight: { xs: 48, sm: 44 } } }}
                >
                  {updateStatus.supported ? 'Later' : 'Dismiss'}
                </Button>
              </Box>
            )
          }
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {update.busy && <CircularProgress size={16} thickness={5} color="inherit" />}
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {update.busy
                ? update.updateLabel
                : `A new version (${updateStatus.latest_version}) is available — you are on ${updateStatus.current_version}.`}
            </Typography>
          </Box>
          {update.busy && update.restartStalled && (
            <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
              {updateStatus.state === 'restarting'
                ? 'Still restarting — this page reconnects on its own. If nothing happens within a minute, close it and start the app again; the update is already installed.'
                : 'Lost contact with the app during the update — it should come back on its own. If it stays quiet, restart the app and run the update again.'}
            </Typography>
          )}
          {!update.busy && updateStatus.notes && (
            <Typography variant="caption" component="div" sx={{ whiteSpace: 'pre-line', mt: 0.5 }}>
              {updateStatus.notes}
            </Typography>
          )}
          {!update.busy && !updateStatus.supported && (
            <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
              {`This copy of the app cannot update itself. Close it and open the newest ODBCQueryApp.exe (${updateStatus.latest_version}) to upgrade.`}
            </Typography>
          )}
          {updateStatus.state === 'error' && updateStatus.error && (
            <Typography variant="caption" component="div" color="warning.main" sx={{ mt: 0.5 }}>
              {updateStatus.error}
            </Typography>
          )}
        </Alert>
      )}

      <AppBar position="sticky" elevation={0}>
        <Box sx={{ display: 'flex', alignItems: 'center', px: { xs: 1, sm: 2 }, py: 0.5 }}>
          <Box
            component="img"
            src="/alex.ico"
            alt="Alex"
            sx={{
              width: 30,
              height: 30,
              mr: 1,
              flexShrink: 0,
              borderRadius: '50%',
              bgcolor: '#ffffff',
              p: 0.35,
              boxShadow: '0 0 0 1px #e3e7ec',
            }}
          />
          <Box
            sx={{
              mr: { xs: 0.5, sm: 2 },
              display: { xs: 'none', sm: 'flex' },
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            <Typography
              component="span"
              sx={{
                fontWeight: 700,
                letterSpacing: '-0.01em',
                fontSize: '1rem',
                lineHeight: 1.15,
                color: 'text.primary',
              }}
            >
              ODBC Query
            </Typography>
            {updateStatus?.current_version && (
              <Typography
                component="span"
                sx={{ fontSize: '0.7rem', lineHeight: 1.15, color: 'text.secondary' }}
              >
                v{updateStatus.current_version}
              </Typography>
            )}
          </Box>
          <Tabs
            value={activeTool ? TOOLS_TAB_VALUE : view}
            onChange={(_event, value: string) => {
              // The grouped tools tab opens a menu rather than navigating.
              if (value === TOOLS_TAB_VALUE) return
              setView(value as View)
            }}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            textColor="primary"
            indicatorColor="primary"
            sx={{ flexGrow: 1 }}
          >
            {MAIN_TABS.map((tab) => (
              <Tab
                key={tab.value}
                value={tab.value}
                icon={tab.icon}
                iconPosition="start"
                label={tab.label}
              />
            ))}
            {/* One button for FlowDiagram / Project / ProblemSolving. It keeps the
                active tool's name so users always know where they are. */}
            <Tab
              value={TOOLS_TAB_VALUE}
              icon={activeTool ? activeTool.icon : <AppsIcon color="action" />}
              iconPosition="start"
              onClick={(event) => setToolsAnchor(event.currentTarget)}
              aria-haspopup="menu"
              aria-expanded={toolsAnchor ? 'true' : undefined}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center' }}>
                  {activeTool ? activeTool.label : 'Tools'}
                  <ArrowDropDownIcon fontSize="small" />
                </Box>
              }
            />
            <Tab
              value={SETTINGS_TAB.value}
              icon={SETTINGS_TAB.icon}
              iconPosition="start"
              label={SETTINGS_TAB.label}
            />
          </Tabs>
          <Menu
            anchorEl={toolsAnchor}
            open={Boolean(toolsAnchor)}
            onClose={() => setToolsAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          >
            {TOOL_TABS.map((tool) => (
              <MenuItem
                key={tool.value}
                selected={view === tool.value}
                onClick={() => {
                  setView(tool.value)
                  setToolsAnchor(null)
                }}
                sx={{ minHeight: 48, minWidth: 200, gap: 1.5 }}
              >
                {tool.icon}
                {tool.label}
              </MenuItem>
            ))}
          </Menu>
          <Tooltip title="How to use this app">
            <IconButton
              aria-label="How to use this app"
              onClick={() => setHelpOpen(true)}
              sx={{ flexShrink: 0, ml: 'auto', color: 'secondary.main' }}
            >
              <InfoIcon color="secondary" />
            </IconButton>
          </Tooltip>
          {/* AI assistant: opens the sidebar on the general Chat tab, which
              answers any question without needing a query in the editor. */}
          <Tooltip title="Open AI assistant">
            <IconButton
              aria-label="Open AI assistant"
              onClick={() => openAi('chat')}
              sx={{ flexShrink: 0, ml: 0.5, color: 'primary.main' }}
            >
              <AutoAwesomeIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Open Connections settings">
            <IconButton
              aria-label="Open Connections settings"
              onClick={() => {
                setSettingsSection('connections')
                setView('settings')
              }}
              sx={{ flexShrink: 0, ml: 0.5, color: 'primary.main' }}
            >
              <StorageIcon />
            </IconButton>
          </Tooltip>
          {/* Feedback board: opens as a full-window overlay so a post can be
              written from any view without losing the current work. The badge
              counts posts made since the board was last opened. */}
          <Tooltip
            title={
              feedbackUnread > 0
                ? `Feedback — ${feedbackUnread} unread post${feedbackUnread === 1 ? '' : 's'}`
                : 'Feedback — report a problem or suggest an idea'
            }
          >
            <IconButton
              aria-label={
                feedbackUnread > 0
                  ? `Open feedback, ${feedbackUnread} unread`
                  : 'Open feedback'
              }
              onClick={openFeedback}
              sx={{ flexShrink: 0, ml: 0.5 }}
            >
              <Badge
                badgeContent={feedbackUnread}
                max={99}
                color="secondary"
                invisible={feedbackUnread === 0}
                sx={{ '& .MuiBadge-badge': { fontWeight: 700, fontSize: 11 } }}
              >
                <ForumOutlinedIcon color="warning" />
              </Badge>
            </IconButton>
          </Tooltip>
          {/* Server status doubles as a reconnect button: the refresh icon is
              green while the heartbeat keeps the backend in touch, and turns
              red the moment the local server stops answering (the same signal
              that raises the offline banner at the very top). Clicking it probes the
              server right away — the banner reports the attempt and verdict. */}
          <Tooltip
            title={
              connection.online
                ? 'Local server connected — click to reconnect'
                : 'Local server not responding — click to reconnect'
            }
          >
            <IconButton
              aria-label={
                connection.online
                  ? 'Local server connected, reconnect now'
                  : 'Local server not responding, reconnect now'
              }
              onClick={connection.retryNow}
              sx={{
                flexShrink: 0,
                ml: 0.5,
                color: connection.online ? 'success.main' : 'error.main',
              }}
            >
              {connection.retrying ? (
                <CircularProgress size={20} color="inherit" />
              ) : (
                <RefreshIcon />
              )}
            </IconButton>
          </Tooltip>
        </Box>
      </AppBar>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p:
            view === 'flowdiagram' || view === 'project' || view === 'problemsolving'
              ? 0
              : { xs: 1.5, sm: 2, md: 3 },
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {/* All pages stay mounted so their state survives view switches. */}
        <Box sx={{ width: '100%', display: view === 'editor' ? 'block' : 'none' }}>
          <WorkspacePage ref={workspaceRef} onOpenAi={openAi} />
        </Box>
        <Box sx={{ width: '100%', display: view === 'script' ? 'block' : 'none' }}>
          <ScriptPage ref={scriptRef} onOpenAi={openAi} />
        </Box>
        <Box sx={{ width: '100%', display: view === 'flowdiagram' ? 'block' : 'none' }}>
          <FlowDiagramPage active={view === 'flowdiagram'} />
        </Box>
        <Box sx={{ width: '100%', display: view === 'project' ? 'block' : 'none' }}>
          <ExternalAppPage
            url="https://study-llm.me/apps/light-gantt/"
            title="Project — light-gantt"
            active={view === 'project'}
          />
        </Box>
        <Box sx={{ width: '100%', display: view === 'problemsolving' ? 'block' : 'none' }}>
          <ExternalAppPage
            url="https://study-llm.me/apps/a3-bowler/metric-bowler"
            title="ProblemSolving — metric-bowler"
            active={view === 'problemsolving'}
          />
        </Box>
        <Box sx={{ width: '100%', display: view === 'settings' ? 'block' : 'none' }}>
          <SettingsPage
            onStartUpdate={update.startUpdate}
            section={settingsSection}
            onSectionChange={setSettingsSection}
            onRequestShutdown={openShutdown}
          />
        </Box>
      </Box>

      {/* Global AI assistant: Query / Analyze / Chart conversations */}
      <AiSidebar
        open={aiOpen}
        mode={aiMode}
        onModeChange={setAiMode}
        onClose={closeAi}
        onOpenEditor={openEditor}
        onOpenScript={openScript}
      />

      <HowToUseDialog
        open={helpOpen}
        onClose={closeHelp}
        onReplayTour={replayTour}
      />

      {/* Feedback board — full window so the list, the open thread and the
          composer all have room on a phone as well as on a desktop. The window
          is deliberately square-cornered: it is a workspace, not a popup. */}
      <Dialog
        open={feedbackOpen}
        onClose={closeFeedback}
        fullScreen
        slotProps={{ paper: { sx: { borderRadius: 0 } } }}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            py: 1.25,
            pr: 7,
            borderBottom: '1px solid',
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          <ForumOutlinedIcon color="warning" />
          <Typography variant="h6" component="div" sx={{ minWidth: 0 }}>
            Feedback
          </Typography>
          <IconButton
            aria-label="Close feedback"
            onClick={closeFeedback}
            sx={{
              position: 'absolute',
              right: { xs: 4, sm: 8 },
              top: { xs: 4, sm: 8 },
              // The theme keeps dialog-title buttons compact at 36px; widen the
              // touch target back to 48px on phones, where it is the only exit.
              '&&': { minWidth: { xs: 48, sm: 36 }, minHeight: { xs: 48, sm: 36 } },
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        {/* The board draws its own gutter, bands and scrolling regions, so the
            content box carries no padding and never scrolls as a whole. */}
        <DialogContent
          sx={{
            p: 0,
            pt: '0 !important',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <FeedbackPage />
        </DialogContent>
      </Dialog>

      {/* First-run / replay step-by-step guide (overlay) */}
      <GuidedTour runToken={tourRun} gotoView={setView} gotoSection={setSettingsSection} />

      <ShutdownDialog
        open={shutdownOpen}
        stage={shutdownStage}
        error={shutdownError}
        onClose={() => setShutdownOpen(false)}
        onConfirm={confirmShutdown}
      />

      {/* Forced upgrade: the running build fell below the published
          min_version, so the dialog cannot be dismissed. Falls back to
          manual instructions when auto-update is unavailable (dev mode). */}
      {/* No onClose: Escape / backdrop clicks cannot dismiss a forced update. */}
      <Dialog open={forcedUpdateVisible && !update.busy} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <SystemUpdateAltIcon color="info" fontSize="small" />
          Update required
        </DialogTitle>
        <DialogContent dividers>
          {updateStatus && (
            <>
              <Typography color="text.secondary" gutterBottom>
                This version ({updateStatus.current_version}) is no longer supported. Version{' '}
                <strong>{updateStatus.latest_version}</strong> is required to continue.
              </Typography>
              {updateStatus.notes && (
                <Typography variant="body2" component="div" sx={{ whiteSpace: 'pre-line', mb: 1 }}>
                  {updateStatus.notes}
                </Typography>
              )}
              {updateStatus.supported ? (
                <Typography variant="body2" color="text.secondary">
                  “Update now” downloads the new build, waits for running queries to finish, then
                  restarts the app automatically — this tab reconnects on its own.
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Automatic update is not available in this environment. Please close the app and
                  copy the latest ODBCQueryApp.exe from your IT team&apos;s share folder.
                </Typography>
              )}
              {updateStatus.state === 'error' && updateStatus.error && (
                <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                  {updateStatus.error}
                </Typography>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          {updateStatus?.supported && (
            <Button
              variant="contained"
              onClick={update.startUpdate}
              sx={{ '&&': { minHeight: { xs: 48, sm: 44 } } }}
            >
              Update now
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Progress dialog while the updater is mid-flight (hides the app until
          the restart lands; auto-closes when the state settles). */}
      <Dialog open={forcedUpdateVisible && update.busy} maxWidth="xs" fullWidth>
        <DialogContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
            <CircularProgress size={22} />
            <Typography color="text.secondary">{update.updateLabel}</Typography>
          </Box>
        </DialogContent>
      </Dialog>

      {/* Brief confirmation after an automatic reconnect. */}
      <Snackbar
        open={connection.reconnected}
        autoHideDuration={3000}
        onClose={connection.dismissReconnected}
        message="Connected to the local server."
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />

      {/* Confirmation that the self-update landed while this tab stayed open:
          the page reloads right after so the new frontend bundle takes over. */}
      <Snackbar
        open={!!update.updatedTo}
        autoHideDuration={UPDATE_RELOAD_DELAY_MS + 500}
        onClose={update.dismissUpdated}
        message={
          update.updatedTo
            ? `Updated to version ${update.updatedTo} — refreshing to load the new interface…`
            : ''
        }
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppShell />
    </ThemeProvider>
  )
}

export default App
