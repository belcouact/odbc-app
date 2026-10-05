import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { changeAppLanguage, isChinese } from './i18n'
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
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Skeleton from '@mui/material/Skeleton'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import AppsIcon from '@mui/icons-material/Apps'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CodeIcon from '@mui/icons-material/Code'
import CloseIcon from '@mui/icons-material/Close'
import DashboardIcon from '@mui/icons-material/Dashboard'
import ForumIcon from '@mui/icons-material/Forum'
import InfoIcon from '@mui/icons-material/Info'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import ReplayIcon from '@mui/icons-material/Replay'
import SettingsIcon from '@mui/icons-material/Settings'
import StorageIcon from '@mui/icons-material/Storage'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import TerminalIcon from '@mui/icons-material/Terminal'
import TroubleshootIcon from '@mui/icons-material/Troubleshoot'
import ViewTimelineIcon from '@mui/icons-material/ViewTimeline'

import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import theme, { BRAND } from './theme'
import { api, sendTabLeftBeacon } from './api/client'
import type { FeedbackThread, UpdateStatus } from './api/client'
import WorkspacePage, { type WorkspacePageHandle } from './pages/WorkspacePage'
import ScriptPage, { type ScriptPageHandle } from './pages/ScriptPage'
import BiPage, { type BiPageHandle } from './pages/BiPage'
import SettingsPage, { type SettingsSection } from './pages/SettingsPage'
import FeedbackPage from './pages/FeedbackPage'
import FlowDiagramPage from './pages/FlowDiagramPage'
import ExternalAppPage from './pages/ExternalAppPage'
import AiSidebar from './components/AiSidebar'
import IntroDialog from './components/IntroDialog'
import GuidedTour, { TOUR_STORAGE_KEY } from './components/GuidedTour'
import { emit, subscribe } from './editorBus'
import type { GridLoadPayload } from './editorBus'
import type { AiMode } from './types'

type View =
  | 'editor'
  | 'script'
  | 'bi'
  | 'flowdiagram'
  | 'project'
  | 'problemsolving'
  | 'settings'

/** Tabs that sit directly in the top bar. Labels are i18n keys. */
const MAIN_TABS: { value: View; labelKey: string; icon: ReactElement }[] = [
  { value: 'editor', labelKey: 'tabs.query', icon: <CodeIcon color="primary" /> },
  { value: 'script', labelKey: 'tabs.analyze', icon: <TerminalIcon color="secondary" /> },
  { value: 'bi', labelKey: 'tabs.dashboard', icon: <DashboardIcon color="info" /> },
]

/** Grouped behind a single menu button to keep the bar uncluttered. */
const TOOL_TABS: { value: View; labelKey: string; icon: ReactElement }[] = [
  { value: 'flowdiagram', labelKey: 'tabs.flowDiagram', icon: <AccountTreeIcon color="info" /> },
  { value: 'project', labelKey: 'tabs.project', icon: <ViewTimelineIcon color="success" /> },
  { value: 'problemsolving', labelKey: 'tabs.problemSolving', icon: <TroubleshootIcon color="error" /> },
]

const SETTINGS_TAB: { value: View; labelKey: string; icon: ReactElement } = {
  value: 'settings',
  labelKey: 'tabs.settings',
  icon: <SettingsIcon color="warning" />,
}

/** Short mantras shown under the enlarged brand icon in the Alex lightbox,
 *  each paired with its Chinese rendering on the line below. */
const ALEX_MOTTOS: { en: string; zh: string }[] = [
  { en: 'Stay hungry, stay foolish', zh: '求知若渴心如童' },
  { en: 'Don’t wait, start now', zh: '莫待明朝趁晓风' },
  { en: 'Start small, learn by doing', zh: '微始躬行勤学步' },
  { en: 'Improve over time', zh: '日新其道渐无穷' },
]

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

function HowToUseDialog({
  open,
  onClose,
  onReplayTour,
}: {
  open: boolean
  onClose: () => void
  onReplayTour: () => void
}) {
  const { t, i18n } = useTranslation()
  const steps = i18n.language.startsWith('zh') ? HELP_STEPS_ZH : HELP_STEPS

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
        {t('help.title')}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <IconButton onClick={onClose} aria-label={t('help.close')} size="small" sx={{ mr: -0.5 }}>
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
              {t('help.firstRunTitle')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('help.firstRunHint')}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<ReplayIcon />}
            onClick={onReplayTour}
            sx={{ minHeight: 44, flexShrink: 0 }}
          >
            {t('help.replay')}
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
  const { t } = useTranslation()
  return (
    <Dialog open={open} onClose={stage === 'stopping' ? undefined : onClose} maxWidth="xs">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PowerSettingsNewIcon color="error" fontSize="small" />
        {t('shutdown.title')}
      </DialogTitle>
      <DialogContent dividers>
        {stage === 'confirm' && (
          <Typography color="text.secondary">{t('shutdown.confirm')}</Typography>
        )}
        {stage === 'stopping' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <CircularProgress size={20} />
            <Typography color="text.secondary">{t('shutdown.stopping')}</Typography>
          </Box>
        )}
        {stage === 'stopped' && (
          <Typography color="text.secondary">{t('shutdown.stopped')}</Typography>
        )}
        {stage === 'error' && (
          <Typography color="error">{t('shutdown.failed', { error })}</Typography>
        )}
      </DialogContent>
      <DialogActions>
        {stage === 'confirm' && (
          <>
            <Button onClick={onClose}>{t('shutdown.cancel')}</Button>
            <Button color="error" variant="contained" onClick={onConfirm}>
              {t('shutdown.title')}
            </Button>
          </>
        )}
        {(stage === 'stopped' || stage === 'error') && (
          <Button onClick={onClose}>{t('shutdown.close')}</Button>
        )}
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
 *
 * `busyRef` lets a caller freeze the hook entirely (self-update install): the
 * server is deliberately stopped mid-swap, so probes must not report an outage
 * and the manual retry must stay a no-op until the install finishes.
 */
function useBackendConnection(busyRef?: { current: boolean }): {
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
      if (busyRef?.current) return up // frozen: keep the last known state
      if (up !== isUp) {
        up = isUp
        setOnline(isUp)
        if (isUp && !retryBusyRef.current) setReconnected(true)
      }
      return isUp
    }
    const probe = (): Promise<boolean> =>
      busyRef?.current
        ? Promise.resolve(false)
        : api.health().then(() => mark(true), () => mark(false))
    const beat = (): Promise<boolean> =>
      busyRef?.current
        ? Promise.resolve(false)
        : api.heartbeat().then(() => mark(true), () => mark(false))
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
  }, [busyRef])

  const retryNow = useCallback(() => {
    if (retryBusyRef.current || busyRef?.current) return
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
  }, [busyRef])
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

function updateStatusLabel(status: UpdateStatus, t: TFunction): string {
  switch (status.state) {
    case 'checking':
      return t('update.checking')
    case 'downloading': {
      const rate = formatDownloadRate(status.download_rate)
      const rateText = rate ? ` · ${rate}` : ''
      const percentSuffix = status.download_percent != null ? ` ${status.download_percent}%` : ''
      return t('update.downloading', {
        version: status.latest_version,
        percentSuffix,
        rateText,
      })
    }
    case 'verifying':
      return t('update.verifying')
    case 'waiting_idle':
      return t('update.waitingIdle')
    case 'restarting':
      return t('update.restarting')
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
  const { t } = useTranslation()
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

  // First paint: read the status only once the browser is idle, so this request
  // stays off the page-load critical path — the bundle and the first view's data
  // get the connections first, and the version badge simply fills in when it
  // lands. The timeout guarantees the read still happens on a permanently busy
  // page (so an update banner can never be starved). A fresh manifest check is
  // nudged shortly after, unchanged.
  useEffect(() => {
    const read = () => refresh()
    const idleId =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(read, { timeout: 2000 })
        : window.setTimeout(read, 200)
    const timer = window.setTimeout(check, 1500)
    return () => {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId)
      else window.clearTimeout(idleId)
      window.clearTimeout(timer)
    }
  }, [refresh, check])

  const busy = !!status && UPDATE_BUSY_STATES.includes(status.state)

  useEffect(() => {
    const timer = window.setInterval(refresh, busy ? 3000 : 300000)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  // Coming back online (e.g. the updater's restart finished) — re-read at once.
  // Skipped on the initial mount: `online` starts true, and the idle read above
  // already covers boot, so this must stay edge-triggered or it would put a
  // second status request back into the page-load burst.
  const settledRef = useRef(false)
  useEffect(() => {
    if (!settledRef.current) {
      settledRef.current = true
      return
    }
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
        error: err instanceof Error ? err.message : t('update.startFailed'),
        message: t('update.installFailed'),
      })
    }
  }, [apply, t])

  // Updates never start on their own: a check only offers the banner / About
  // card, and the download+install begins solely when the user presses one of
  // the "Update now" buttons — an automatic install could otherwise interrupt
  // work in progress (queries, uploads, unsaved editors) at any moment.

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
    updateLabel: status ? updateStatusLabel(status, t) : '',
    startUpdate,
    dismiss,
    dismissedVersion,
    check,
    updatedTo,
    dismissUpdated: () => setUpdatedTo(''),
  }
}

function AppShell() {
  const { t } = useTranslation()
  const [view, setViewState] = useState<View>('editor')
  // Anchor element for the grouped FlowDiagram / Project / ProblemSolving menu.
  const [toolsAnchor, setToolsAnchor] = useState<HTMLElement | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('connections')
  // Bumped when the app-bar version badge is clicked so Settings -> About
  // opens its Updates disclosure (a counter, so the initial value is inert).
  const [expandUpdatesTick, setExpandUpdatesTick] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  const [introOpen, setIntroOpen] = useState(false)
  const [alexOpen, setAlexOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Navigating from the top bar dismisses the feedback overlay so the requested
  // destination is always visible — including when the target view is already
  // the current one (e.g. re-clicking the version badge while the board is open),
  // which a bare view change would miss.
  const setView = useCallback((nextView: View) => {
    setFeedbackOpen(false)
    setViewState(nextView)
  }, [])
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
      setShutdownError(err instanceof Error ? err.message : t('shutdown.unexpected'))
      setShutdownStage('error')
    }
  }

  // ---- Keep-alive heartbeat + auto-reconnect ----
  // Pings the backend every 15s (tagged with this tab's id). The backend
  // watchdog / launcher keep the local server alive: if it dies (laptop
  // sleep, frozen tab) the launcher restarts it on the same port and this
  // hook notices, showing a banner until the connection is back — no reload.
  // During a self-update install the hook is frozen via this ref: the server
  // is deliberately stopped for the folder swap, and the UI must neither show
  // the offline banner nor hammer the dead port with probes/retries.
  const updateBusyRef = useRef(false)
  const connection = useBackendConnection(updateBusyRef)

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
  // Freeze the connection hook while the install runs (see updateBusyRef).
  useEffect(() => {
    updateBusyRef.current = update.busy
  }, [update.busy])
  const updateStatus = update.status
  const optionalUpdateVisible =
    !!updateStatus &&
    updateStatus.available &&
    !updateStatus.forced &&
    (update.busy || update.dismissedVersion !== updateStatus.latest_version)
  const forcedUpdateVisible = !!updateStatus && updateStatus.available && updateStatus.forced

  // ---- Connection banner state (offline / manual retry) ----
  // The banner is hidden during a deliberate in-app shutdown (the dialog
  // already explains that one) and while the self-update install runs: the
  // server is stopped for the folder swap and comes right back afterwards.
  const connectionLost =
    !connection.online &&
    !update.busy &&
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
  /** Question pushed from the Analyze page's insight card — sent in the Chat
   *  tab once the sidebar is open. `seq` deduplicates repeated pushes. */
  const [autoChatAsk, setAutoChatAsk] = useState<{ text: string; seq: number } | null>(null)

  useEffect(() => {
    return subscribe((action) => {
      if (action.type === 'ai-ask') {
        setAiMode('chat')
        setAiOpen(true)
        setAutoChatAsk((prev) => ({ text: action.text, seq: (prev?.seq ?? 0) + 1 }))
      }
    })
  }, [])

  // All callbacks handed to (memoized) pages are stable, so switching views
  // only re-renders the incoming page instead of every mounted page.
  const openAi = useCallback((mode: AiMode) => {
    setAiMode(mode)
    setAiOpen(true)
  }, [])
  const closeAi = useCallback(() => setAiOpen(false), [])
  const clearAutoChatAsk = useCallback(() => setAutoChatAsk(null), [])
  const openEditor = useCallback(() => setView('editor'), [])
  const openScript = useCallback(() => setView('script'), [])
  // BI → "Load to grid": swap the Query grid's rows for a stored snapshot's
  // data, then reveal the Query page where the grid lives.
  const loadSnapshotToGrid = useCallback((payload: GridLoadPayload) => {
    emit({ type: 'load-grid', payload })
    setView('editor')
  }, [])
  const openBi = useCallback(() => setView('bi'), [])
  const closeHelp = useCallback(() => setHelpOpen(false), [])
  const openIntro = useCallback(() => setIntroOpen(true), [])
  const closeIntro = useCallback(() => setIntroOpen(false), [])
  const openAlex = useCallback(() => setAlexOpen(true), [])
  const closeAlex = useCallback(() => setAlexOpen(false), [])
  // Opening the board reads everything on it; closing re-reads, so a post that
  // arrived while the board was open is not left flagged as unread.
  const openFeedback = useCallback(() => {
    // Toggles: clicking the top-bar icon again, the board's close button, or
    // switching tabs are all ways out.
    setFeedbackOpen((open) => {
      if (!open) void markBoardRead()
      return !open
    })
  }, [markBoardRead])
  // Closing re-reads the board, so a post that arrived while it was open does
  // not stay flagged as unread on the top-bar badge.
  const closeFeedback = useCallback(() => {
    setFeedbackOpen(false)
    void markBoardRead()
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
  const biRef = useRef<BiPageHandle>(null)
  const viewRef = useRef(view)
  useEffect(() => {
    const previous = viewRef.current
    viewRef.current = view
    // The mount effects inside the pages already did the initial fetch.
    if (previous === view) return
    if (view === 'editor') workspaceRef.current?.refresh()
    else if (view === 'script') scriptRef.current?.refresh()
    else if (view === 'bi') biRef.current?.refresh()
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
              {connectionBanner === 'retrying' ? t('connection.reconnecting') : t('connection.retryNow')}
            </Button>
          }
        >
          {connectionBanner === 'retrying' && t('connection.retrying')}
          {connectionBanner === 'retried' && t('connection.retried')}
          {connectionBanner === 'failed' && t('connection.failed')}
          {connectionBanner === 'offline' && t('connection.offline')}
        </Alert>
      )}

      {/* Update banner: shown as soon as a check finds a newer build and it
          has NOT been dismissed ("Later"). Nothing downloads until the user
          presses "Update now"; the banner then tracks the install progress
          while the exe downloads, swaps and restarts behind the open page.
          Sits above the nav bar so it is the first thing seen. */}
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
                    {t('update.now')}
                  </Button>
                )}
                <Button
                  color="inherit"
                  size="small"
                  onClick={update.dismiss}
                  sx={{ '&&': { minHeight: { xs: 48, sm: 44 } } }}
                >
                  {updateStatus.supported ? t('update.later') : t('update.dismiss')}
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
                : t('update.available', {
                    latest: updateStatus.latest_version,
                    current: updateStatus.current_version,
                  })}
            </Typography>
          </Box>
          {update.busy && update.restartStalled && (
            <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
              {updateStatus.state === 'restarting'
                ? t('update.stalledRestarting')
                : t('update.stalledLost')}
            </Typography>
          )}
          {!update.busy && updateStatus.notes && (
            <Typography variant="caption" component="div" sx={{ whiteSpace: 'pre-line', mt: 0.5 }}>
              {updateStatus.notes}
            </Typography>
          )}
          {!update.busy && !updateStatus.supported && (
            <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
              {t('update.unsupported', { latest: updateStatus.latest_version })}
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
            onClick={openAlex}
            role="button"
            tabIndex={0}
            aria-label={t('bar.enlargeAlex')}
            title={t('bar.enlargeAlex')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openAlex()
              }
            }}
            sx={{
              width: 30,
              height: 30,
              mr: 1,
              flexShrink: 0,
              borderRadius: '50%',
              bgcolor: '#ffffff',
              p: 0.35,
              boxShadow: '0 0 0 1px #e8e6dc, 0 2px 8px rgba(217, 119, 87, 0.18)',
              cursor: 'pointer',
              transition: 'box-shadow 0.15s ease',
              '&:hover': { boxShadow: '0 0 0 2px #d97757, 0 2px 8px rgba(217, 119, 87, 0.28)' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
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
              onClick={openIntro}
              role="button"
              tabIndex={0}
              aria-label={t('bar.watchIntro')}
              title={t('bar.watchIntro')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openIntro()
                }
              }}
              sx={{
                fontFamily: BRAND.bodyFont,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                fontSize: '1rem',
                lineHeight: 1.15,
                color: 'text.primary',
                cursor: 'pointer',
                borderRadius: 0.5,
                transition: 'color 0.15s ease',
                '&:hover': { color: 'primary.main' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
              }}
            >
              {t('bar.appTitle')}
            </Typography>
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
                label={t(tab.labelKey)}
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
                  {activeTool ? t(activeTool.labelKey) : t('tabs.tools')}
                  <ArrowDropDownIcon fontSize="small" />
                </Box>
              }
            />
            <Tab
              value={SETTINGS_TAB.value}
              icon={SETTINGS_TAB.icon}
              iconPosition="start"
              label={t(SETTINGS_TAB.labelKey)}
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
                {t(tool.labelKey)}
              </MenuItem>
            ))}
          </Menu>
          {/* Interface language: one tap on EN/中 flips every translated string
              in the app; the choice persists in localStorage. */}
          <Tooltip title={t('bar.language')}>
            <IconButton
              aria-label={t('bar.language')}
              onClick={() => changeAppLanguage(isChinese() ? 'en' : 'zh')}
              sx={{ flexShrink: 0, ml: 'auto', color: 'primary.main' }}
            >
              <Box component="span" sx={{ fontSize: '0.85rem', fontWeight: 700, lineHeight: 1 }}>
                {isChinese() ? 'EN' : '中'}
              </Box>
            </IconButton>
          </Tooltip>
          <Tooltip title={t('bar.howToUse')}>
            <IconButton
              aria-label={t('bar.howToUse')}
              onClick={() => setHelpOpen(true)}
              sx={{ flexShrink: 0, ml: 0.5, color: 'primary.main' }}
            >
              <InfoIcon />
            </IconButton>
          </Tooltip>
          {/* AI assistant: opens the sidebar on the general Chat tab, which
              answers any question without needing a query in the editor. */}
          <Tooltip title={t('bar.aiAssistant')}>
            <IconButton
              aria-label={t('bar.aiAssistant')}
              onClick={() => openAi('chat')}
              sx={{ flexShrink: 0, ml: 0.5, color: 'primary.main' }}
            >
              <AutoAwesomeIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('bar.connections')}>
            <IconButton
              aria-label={t('bar.connections')}
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
                ? t('bar.feedbackUnread', { count: feedbackUnread })
                : t('bar.feedbackIdle')
            }
          >
            <IconButton
              aria-label={
                feedbackUnread > 0
                  ? t('bar.openFeedbackUnread', { count: feedbackUnread })
                  : t('bar.openFeedback')
              }
              onClick={openFeedback}
              sx={{ flexShrink: 0, ml: 0.5, color: 'primary.main' }}
            >
              <Badge
                badgeContent={feedbackUnread}
                max={99}
                color="secondary"
                invisible={feedbackUnread === 0}
                sx={{ '& .MuiBadge-badge': { fontWeight: 700, fontSize: 11 } }}
              >
                <ForumIcon />
              </Badge>
            </IconButton>
          </Tooltip>
          {/* Boxed version badge: the box itself renders on the first paint — a
              skeleton holds the slot — so the app bar's right side never shifts
              when the number arrives (the status read is deliberately deferred
              to idle). Clicking it opens Settings -> About with the updates
              panel expanded. */}
          <Tooltip title={t('bar.updates')}>
            <Box
              component="button"
              type="button"
              aria-label={t('bar.updates')}
              onClick={() => {
                setSettingsSection('about')
                setView('settings')
                setExpandUpdatesTick((t) => t + 1)
              }}
              sx={{
                flexShrink: 0,
                ml: 0.5,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 58,
                height: 34,
                px: 1,
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'transparent',
                font: 'inherit',
                fontSize: '0.8rem',
                fontWeight: 700,
                color: 'primary.main',
                cursor: 'pointer',
                transition: 'background-color 0.15s ease',
                '&:hover': { bgcolor: 'action.hover' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
              }}
            >
              {updateStatus?.current_version ? (
                `v${updateStatus.current_version}`
              ) : (
                <Skeleton variant="rounded" width={34} height={12} />
              )}
            </Box>
          </Tooltip>
        </Box>
      </AppBar>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          position: 'relative',
          p:
            view === 'flowdiagram' || view === 'project' || view === 'problemsolving'
              ? 0
              : { xs: 1.5, sm: 2, md: 3 },
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {/* Soft crossfade on tab switch. The pages themselves must stay mounted
            (their state survives view switches), so instead of animating them we
            key a paper-tinted veil on the view: switching tabs remounts it and
            replays the fade-out, which reads as a gentle transition. */}
        <Box
          key={view}
          className="view-flash"
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            bgcolor: 'background.default',
            pointerEvents: 'none',
          }}
        />
        {/* All pages stay mounted so their state survives view switches. */}
        <Box sx={{ width: '100%', display: view === 'editor' ? 'block' : 'none' }}>
          <WorkspacePage ref={workspaceRef} onOpenAi={openAi} />
        </Box>
        <Box sx={{ width: '100%', display: view === 'script' ? 'block' : 'none' }}>
          <ScriptPage ref={scriptRef} onOpenAi={openAi} />
        </Box>
        <Box sx={{ width: '100%', display: view === 'bi' ? 'block' : 'none' }}>
          <BiPage ref={biRef} onLoadToGrid={loadSnapshotToGrid} />
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
            expandUpdates={expandUpdatesTick}
          />
        </Box>
        {/* Feedback board — a workspace layered just below the top bar instead
            of a full-screen modal, so the app bar and its tabs stay in reach.
            Switching tabs dismisses it via the effect keyed on `view`. */}
        {feedbackOpen && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              // Above page-internal sticky/z-indexed content (which uses
              // small z-indexes), far below MUI portals (~1300).
              zIndex: 20,
              bgcolor: 'background.default',
              overflowY: 'auto',
              // The shell's <main> padding, so the board's title lands in the
              // same place as every other page's (e.g. Analyze).
              p: { xs: 1.5, sm: 2, md: 3 },
            }}
          >
            {/* The board draws its own centred column, title and cards. */}
            <FeedbackPage onClose={closeFeedback} />
          </Box>
        )}
      </Box>

      {/* Global AI assistant: Query / Analyze / Chart conversations */}
      <AiSidebar
        open={aiOpen}
        mode={aiMode}
        onModeChange={setAiMode}
        onClose={closeAi}
        onOpenEditor={openEditor}
        onOpenScript={openScript}
        chartTarget={view === 'bi' ? 'bi' : 'script'}
        onOpenBi={openBi}
        autoQuestion={autoChatAsk}
        onAutoQuestionHandled={clearAutoChatAsk}
      />

      <HowToUseDialog
        open={helpOpen}
        onClose={closeHelp}
        onReplayTour={replayTour}
      />

      {/* Intro animation — the app title opens the intro page in a full-screen
          window so it is reachable without leaving the app. */}
      <IntroDialog open={introOpen} onClose={closeIntro} />

      {/* Alex icon — clicking the brand-mark icon enlarges the little logo in a
          small lightbox so it can be seen at full size. */}
      <Dialog
        open={alexOpen}
        onClose={closeAlex}
        maxWidth="sm"
        fullWidth
        slotProps={{
          paper: {
            sx: {
              position: 'relative',
              borderRadius: 3,
              border: `1px solid ${BRAND.lightGray}`,
              bgcolor: BRAND.paper,
              backgroundImage: 'none',
              p: { xs: 3, sm: 5 },
              textAlign: 'center',
            },
          },
        }}
      >
        {/* No close button: clicking anywhere outside the dialog (or Escape)
            dismisses it via the Dialog's onClose. */}
        {/* Picture left, sentences right on wide screens; stacked on phones. */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: 'center',
            justifyContent: 'center',
            gap: { xs: 2.5, sm: 4 },
          }}
        >
          <Box
            component="img"
            src="/alex.ico"
            alt="Alex"
            sx={{
              display: 'block',
              flexShrink: 0,
              width: { xs: '60vw', sm: 260 },
              maxWidth: 340,
              height: 'auto',
              borderRadius: '50%',
              bgcolor: '#ffffff',
              p: 1.5,
              boxShadow: `0 0 0 3px ${BRAND.clay}33, 0 12px 40px rgba(217, 119, 87, 0.28)`,
            }}
          />
          {/* All English lines first, then all Chinese lines, with a gap
              between the two groups. */}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'grid',
              gap: { xs: 2.5, sm: 3 },
              textAlign: { xs: 'center', sm: 'left' },
            }}
          >
            <Box
              component="ul"
              sx={{
                listStyle: 'none',
                m: 0,
                p: 0,
                display: 'grid',
                gap: 1,
              }}
            >
              {ALEX_MOTTOS.map(({ en }) => (
                <Typography
                  key={en}
                  component="li"
                  variant="body1"
                  sx={{ color: 'black', whiteSpace: 'nowrap', fontSize: { xs: '0.9rem', sm: '1rem' } }}
                >
                  {en}
                </Typography>
              ))}
            </Box>
            <Box
              component="ul"
              sx={{
                listStyle: 'none',
                m: 0,
                p: 0,
                display: 'grid',
                gap: 1,
              }}
            >
              {ALEX_MOTTOS.map(({ zh }) => (
                <Typography
                  key={zh}
                  component="li"
                  variant="body1"
                  sx={{
                    color: 'black',
                    letterSpacing: 3,
                    fontSize: { xs: '0.95rem', sm: '1.15rem' },
                  }}
                >
                  {zh}
                </Typography>
              ))}
            </Box>
          </Box>
        </Box>
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
          {t('update.requiredTitle')}
        </DialogTitle>
        <DialogContent dividers>
          {updateStatus && (
            <>
              <Typography color="text.secondary" gutterBottom>
                <Trans
                  i18nKey="update.requiredText"
                  values={{
                    current: updateStatus.current_version,
                    latest: updateStatus.latest_version,
                  }}
                  components={{ strong: <strong /> }}
                />
              </Typography>
              {updateStatus.notes && (
                <Typography variant="body2" component="div" sx={{ whiteSpace: 'pre-line', mb: 1 }}>
                  {updateStatus.notes}
                </Typography>
              )}
              {updateStatus.supported ? (
                <Typography variant="body2" color="text.secondary">
                  {t('update.requiredAuto')}
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t('update.requiredManual')}
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
              {t('update.now')}
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
        message={t('connection.reconnectedToast')}
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
            ? t('update.updatedToast', { version: update.updatedTo })
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
