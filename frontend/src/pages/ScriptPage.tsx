import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ChangeEvent, ReactNode, Ref } from 'react'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import FileOpenIcon from '@mui/icons-material/FileOpen'
import GridOnIcon from '@mui/icons-material/GridOn'
import HelpOutlineOutlinedIcon from '@mui/icons-material/HelpOutlineOutlined'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import SaveIcon from '@mui/icons-material/Save'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BarChartIcon from '@mui/icons-material/BarChart'
import BookmarksIcon from '@mui/icons-material/Bookmarks'
import CodeIcon from '@mui/icons-material/Code'
import InsightsIcon from '@mui/icons-material/Insights'
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined'
import RefreshIcon from '@mui/icons-material/Refresh'
import StorageIcon from '@mui/icons-material/Storage'
import TerminalIcon from '@mui/icons-material/Terminal'
import VisibilityIcon from '@mui/icons-material/Visibility'
import Alert from '@mui/material/Alert'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import LinearProgress from '@mui/material/LinearProgress'
import Link from '@mui/material/Link'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { alpha } from '@mui/material/styles'
import type { EChartsOption } from 'echarts'
import { Trans, useTranslation } from 'react-i18next'
import { api, downloadBlob } from '../api/client'
import type { DownloadResult, SnapshotMeta } from '../api/client'
import type {
  AiMode,
  DbConnection,
  QueryDef,
  QueryResult,
  QuerySource,
  ScriptEntry,
  ScriptOutputFile,
  ScriptRunResult,
  ScriptTemplate,
} from '../types'
import { emit, subscribe } from '../editorBus'
import { getWorkspaceSnapshot } from '../workspaceBus'
import { AnalyzePanel, InsightPanel } from '../components/AnalysisPanel'
import ChartsPanel from '../components/ChartsPanel'
import CodeEditor from '../components/CodeEditor'

type ScriptTab = 'script' | 'chart' | 'insights' | 'analyze'

interface DeleteTarget {
  id: string
  name: string
}

/** What a saved script re-opens with: its stored builder query, a raw SQL
 *  data source, or nothing (rows come from the grid/snapshot at runtime). */
type EditSourceKind = 'query' | 'sql' | 'none'

interface EditTarget {
  id: string
  name: string
  description: string
  connectionId: string
  query: QueryDef | null
  sql: string | null
}

/** Imperative API the shell uses to refresh this page when its tab is opened. */
export interface ScriptPageHandle {
  /** Re-fetch the saved scripts and connections so the lists are current. */
  refresh: () => void
}

interface ScriptPageProps {
  /** Open the global AI sidebar in the given specialty (Query / Analyze / Chart). */
  onOpenAi?: (mode: AiMode) => void
  /** The shell asks the page to refresh through this handle when the tab is
   *  opened. A boolean "active" prop would instead re-render the page on every
   *  switch — including the ones where it is only being hidden. */
  ref?: Ref<ScriptPageHandle>
}

/** Ready-to-run snippets that work on any grid table. They never reference a
 *  specific column name — instead they detect text/numeric columns from the
 *  data itself (data is a list of row dicts). */
const SCRIPT_EXAMPLES: { labelKey: string; code: string }[] = [
  {
    labelKey: 'examples.overview',
    code: `# data = the queried rows (a list of row dicts)
import pandas as pd

df = pd.DataFrame(data)

print('rows    :', len(df))
print('columns :', list(df.columns))
print()
print(df.head())
print()
print('-- summary --')
print(df.describe(include='all'))
print()
print('-- missing values per column --')
print(df.isna().sum())

# Automatically pick the first numeric column (no hard-coded column names).
num = df.select_dtypes(include='number')
if not num.empty:
    col = num.columns[0]
    print()
    print(f'-- stats for first numeric column: \${col} --')
    print('mean  :', num[col].mean())
    print('median:', num[col].median())
    print('min   :', num[col].min())
    print('max   :', num[col].max())
    print('std   :', num[col].std())
`,
  },
  {
    labelKey: 'examples.groupBy',
    code: `import pandas as pd

df = pd.DataFrame(data)

# Pick the first text column and the first numeric column automatically.
cat = df.select_dtypes(include='object')
num = df.select_dtypes(include='number')
if cat.shape[1] > 0 and num.shape[1] > 0:
    group_col, value_col = cat.columns[0], num.columns[0]
    print(f'-- mean of "\${value_col}" grouped by "\${group_col}" --')
    print(df.groupby(group_col)[value_col].mean().round(2).sort_values(ascending=False))
else:
    print('Need at least one text column and one numeric column to group by.')
`,
  },
  {
    labelKey: 'examples.correlation',
    code: `import pandas as pd

df = pd.DataFrame(data)
num = df.select_dtypes(include='number')
if num.shape[1] >= 2:
    print('-- correlation matrix (numeric columns) --')
    print(num.corr().round(2))
else:
    print('Need at least two numeric columns to compute correlations.')
`,
  },
  {
    labelKey: 'examples.outliers',
    code: `import pandas as pd

df = pd.DataFrame(data)
num = df.select_dtypes(include='number')
for col in num.columns:
    q1 = num[col].quantile(0.25)
    q3 = num[col].quantile(0.75)
    iqr = q3 - q1
    low, high = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    n_out = int(((num[col] < low) | (num[col] > high)).sum())
    print(f'\${col}: \${n_out} outliers outside \${low:.2f} .. \${high:.2f}')
`,
  },
  {
    labelKey: 'examples.exportExcel',
    code: `import pandas as pd

df = pd.DataFrame(data)
path = 'grid_export.xlsx'
df.to_excel(path, index=False)
print(f'Saved \${len(df)} rows to \${path} (in your Downloads folder)')
`,
  },
]

const FILE_URI_RE = /file:\/\/[^\s"'<>)]+/g

/** Decode a base64-encoded string into a Blob (used for script output files). */
function base64ToBlob(dataBase64: string): Blob {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes])
}

/** Open a local file URI in a new browser tab. Used for clickable file:/// links in script output. */
function openLocalFile(uri: string): void {
  window.open(uri, '_blank')
}

/** Render script stdout/stderr text, turning file:/// URIs into clickable links. */
function renderOutputLinks(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = new RegExp(FILE_URI_RE)
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const uri = match[0]
    out.push(
      <a
        key={key++}
        href={uri}
        onClick={(e) => {
          e.preventDefault()
          openLocalFile(uri)
        }}
        style={{ color: '#1f3a5f', textDecoration: 'underline', cursor: 'pointer' }}
      >
        {uri}
      </a>,
    )
    last = match.index + uri.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function ScriptPage({ onOpenAi, ref }: ScriptPageProps = {}) {
  const { t } = useTranslation('script')
  const [tab, setTab] = useState<ScriptTab>('script')
  /** ECharts option pushed in from the AI sidebar's Chart assistant. */
  const [aiOption, setAiOption] = useState<{ option: EChartsOption; nonce: number } | null>(null)
  /** Whether the "Custom scripts" pop-up (saved pre-defined scripts) is open. */
  const [customOpen, setCustomOpen] = useState(false)
  /** Phones show the Custom pop-up full screen, matching the Query tab's Custom queries. */
  const customFullScreen = useMediaQuery('(max-width:600px)')

  // ---- Script editor ----
  const [scriptText, setScriptText] = useState('')
  const [scriptResult, setScriptResult] = useState<ScriptRunResult | null>(null)
  const [scriptRunning, setScriptRunning] = useState(false)
  /** Live streamed stdout from the running script (shown as the progress log). */
  const [liveOutput, setLiveOutput] = useState('')
  /** Ref to the live-output pane so it can auto-scroll as lines arrive. */
  const liveOutputRef = useRef<HTMLDivElement | null>(null)
  /** Anchor for the "Insert example" dropdown menu. */
  const [exampleMenuAnchor, setExampleMenuAnchor] = useState<HTMLElement | null>(null)

  // ---- Snackbar notice ----
  const [notice, setNotice] = useState<string | null>(null)
  /** Severity for the notice snackbar — explicit, since translated messages
   *  no longer start with "Deleted"/"Updated" for the code to sniff. */
  const [noticeSeverity, setNoticeSeverity] = useState<'success' | 'error'>('error')
  const showNotice = useCallback(
    (message: string, severity: 'success' | 'error' = 'error') => {
      setNotice(message)
      setNoticeSeverity(severity)
    },
    [],
  )

  // ---- Script data source ----
  /** Where the script's rows come from: the Query grid (default) or a snapshot. */
  const [dataSource, setDataSource] = useState<'grid' | 'snapshot'>('grid')
  /** Stored snapshots offered when ``dataSource`` is 'snapshot'. */
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  /** Snapshot chosen as the script's data source ('' = none picked yet). */
  const [snapshotId, setSnapshotId] = useState('')
  /** The chosen snapshot's rows, cached so a re-run does not re-fetch them. */
  const [snapshotRows, setSnapshotRows] = useState<{
    id: string
    rows: Record<string, unknown>[]
  } | null>(null)
  const [snapshotRowsLoading, setSnapshotRowsLoading] = useState(false)
  /** Confirmation shown when the grid has no rows: run anyway, or stop. */
  const [runWithoutDataOpen, setRunWithoutDataOpen] = useState(false)

  // ---- Template scripts (Supabase ``templates/`` catalog, bundled fallback) ----
  /** Available template scripts, as published in the bucket's catalog. */
  const [templates, setTemplates] = useState<ScriptTemplate[]>([])
  /** Currently selected template (file stem). */
  const [selectedTemplate, setSelectedTemplate] = useState('')
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  /** Whether the template library pop-up is open. */
  const [templateOpen, setTemplateOpen] = useState(false)
  /** Phones show the library full screen, matching the Custom scripts pop-up. */
  const templateFullScreen = useMediaQuery('(max-width:600px)')
  /** How-to pop-up for this page (opened from the help icon). */
  const [helpOpen, setHelpOpen] = useState(false)
  const helpFullScreen = useMediaQuery('(max-width:600px)')
  /** True briefly after the Copilot prompt is copied, to flip the button label. */
  const [promptCopied, setPromptCopied] = useState(false)
  /** Stem whose source is being fetched, so only that row shows a spinner. */
  const [templateBusy, setTemplateBusy] = useState('')
  /** Stem of the row whose detail panel is open (one at a time). */
  const [expandedTemplate, setExpandedTemplate] = useState('')
  /** Stem whose sample dashboard is being fetched, so only that row spins. */
  const [exampleBusy, setExampleBusy] = useState('')
  /** Sample dashboard open in the in-app viewer (blob URL + title), or null. */
  const [examplePreview, setExamplePreview] = useState<{ title: string; url: string } | null>(null)
  /** Phones show the dashboard viewer full screen, matching the other pop-ups. */
  const exampleFullScreen = useMediaQuery('(max-width:600px)')

  /** Fetch the published template list (Supabase catalog, bundled fallback). */
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplateError(null)
    try {
      setTemplates(await api.listScriptTemplates())
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : t('notices.failedToLoadTemplates'))
    } finally {
      setTemplatesLoading(false)
    }
  }, [t])

  // Load the template list once on mount so the dropdown is ready.
  useEffect(() => {
    if (templates.length > 0) return
    void loadTemplates()
  }, [templates.length, loadTemplates])

  /** Load a template's source into the script editor (replaces current content). */
  const loadTemplateIntoEditor = useCallback(async (name: string) => {
    setSelectedTemplate(name)
    setTemplateError(null)
    setTemplateBusy(name)
    try {
      const tmpl = await api.getScriptTemplate(name)
      setScriptText(tmpl.content)
      setScriptResult(null)
      return true
    } catch (err) {
      setTemplateError(
        err instanceof Error ? err.message : t('notices.failedToLoadTemplate', { name }),
      )
      return false
    } finally {
      setTemplateBusy('')
    }
  }, [t])

  /** Dropdown handler: selecting a template copies its code into the editor. */
  const handleSelectTemplate = (name: string) => {
    if (!name) {
      setSelectedTemplate('')
      return
    }
    void loadTemplateIntoEditor(name)
  }

  /** Library handler: close the pop-up first so the editor's progress
   *  indicator is visible while the template source is fetched, then confirm. */
  const handleUseTemplate = async (tmpl: ScriptTemplate) => {
    setTemplateOpen(false)
    if (await loadTemplateIntoEditor(tmpl.name)) {
      showNotice(t('notices.loadedTemplate', { name: tmpl.title || tmpl.name }), 'success')
    }
  }

  /** Show a template's sample dashboard in the in-app viewer.
   *
   *  The bucket serves HTML objects as ``text/plain`` with ``nosniff``, so
   *  linking straight at the object URL would show source code. Fetching the
   *  bytes (CORS is open) and handing an ``<iframe>`` a ``text/html`` blob makes
   *  it render. The viewer is an in-app dialog on purpose: ``window.open`` is
   *  intercepted by the native WebView2 window (it either navigates the app
   *  window away or asks the OS browser to open a ``blob:`` URL it cannot
   *  resolve), so a real popup would be unreliable. */
  const openExample = useCallback(async (tmpl: ScriptTemplate) => {
    const url = tmpl.example?.url
    if (!url) return
    setExampleBusy(tmpl.name)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blobUrl = URL.createObjectURL(
        new Blob([await res.text()], { type: 'text/html' }),
      )
      setExamplePreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)  // release the previous blob
        return { title: tmpl.example?.label || tmpl.title || tmpl.name, url: blobUrl }
      })
    } catch (err) {
      showNotice(
        t('notices.exampleFailed', {
          error: err instanceof Error ? err.message : t('notices.downloadFailed'),
        }),
      )
    } finally {
      setExampleBusy('')
    }
  }, [t, showNotice])

  /** Close the sample-dashboard viewer and release its blob. */
  const closeExamplePreview = useCallback(() => {
    setExamplePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }, [])

  // Keep the live log scrolled to the bottom as new output streams in.
  useEffect(() => {
    const el = liveOutputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [liveOutput])

  /** Load a ready-to-run example into the editor (replaces current content). */
  const handleInsertExample = (code: string) => {
    setExampleMenuAnchor(null)
    setScriptText(code)
    setScriptResult(null)
  }

  // ---- Save as pre-defined ----
  const [saveScriptDialogOpen, setSaveScriptDialogOpen] = useState(false)
  const [saveScriptName, setSaveScriptName] = useState('')
  const [saveScriptDescription, setSaveScriptDescription] = useState('')
  const [saveScriptError, setSaveScriptError] = useState<string | null>(null)
  const [savingScript, setSavingScript] = useState(false)
  /** Existing scripts shown in the save dialog so one can be overwritten. */
  const [existingScripts, setExistingScripts] = useState<ScriptEntry[]>([])
  /** Script selected for overwriting; '' means "save as new". */
  const [selectedScriptId, setSelectedScriptId] = useState('')
  const [scriptsLoading, setScriptsLoading] = useState(false)

  // ---- Pre-defined list ----
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [connections, setConnections] = useState<DbConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editConnection, setEditConnection] = useState('')
  const [editSource, setEditSource] = useState<EditSourceKind>('none')
  const [editSql, setEditSql] = useState('')
  const [editing, setEditing] = useState(false)

  // ---- Pre-defined scripts list ----
  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [list, connectionList] = await Promise.all([api.getScripts(), api.getConnections()])
      setScripts(list)
      setConnections(connectionList)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('notices.failedToLoadScripts'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The shell calls this when the Analyze tab is opened, so scripts saved
  // elsewhere show up without re-rendering this page on every tab switch.
  useImperativeHandle(ref, () => ({ refresh: () => void refresh() }), [refresh])

  // ---- Data source resolution ----
  // The default is the grid table data (rows currently loaded in the Query
  // grid — from a builder query, custom SQL or an upload); the user can switch
  // to a stored snapshot's rows instead.
  const loadSnapshotRows = useCallback(async (id: string) => {
    setSnapshotRowsLoading(true)
    setSnapshotError(null)
    try {
      const detail = await api.getSnapshot(id)
      setSnapshotRows({ id, rows: detail.rows })
    } catch (err) {
      setSnapshotRows(null)
      setSnapshotError(err instanceof Error ? err.message : t('notices.failedToLoadSnapshot'))
    } finally {
      setSnapshotRowsLoading(false)
    }
  }, [t])

  /** Fetch the snapshot list lazily — only once the snapshot source is picked. */
  const loadSnapshotList = useCallback(async () => {
    setSnapshotsLoading(true)
    setSnapshotError(null)
    try {
      setSnapshots(await api.listSnapshots())
    } catch (err) {
      setSnapshotError(err instanceof Error ? err.message : t('notices.failedToLoadSnapshots'))
    } finally {
      setSnapshotsLoading(false)
    }
  }, [t])

  const handleDataSourceChange = (value: 'grid' | 'snapshot') => {
    setDataSource(value)
    if (value === 'snapshot' && snapshots.length === 0 && !snapshotsLoading) {
      void loadSnapshotList()
    }
  }

  const handleSelectSnapshot = (id: string) => {
    setSnapshotId(id)
    setSnapshotRows(null)
    if (id && snapshotRows?.id !== id) void loadSnapshotRows(id)
  }

  const resolveScriptData = async (): Promise<{
    rows?: Record<string, unknown>[]
    error?: string
    /** True when the grid is simply empty — the user may still run without data. */
    emptyGrid?: boolean
  }> => {
    if (dataSource === 'snapshot') {
      if (!snapshotId) {
        return { error: t('notices.chooseSnapshot') }
      }
      const rows =
        snapshotRows?.id === snapshotId
          ? snapshotRows.rows
          : await api
              .getSnapshot(snapshotId)
              .then((detail) => {
                setSnapshotRows({ id: snapshotId, rows: detail.rows })
                return detail.rows
              })
              .catch((err: unknown) => {
                setSnapshotError(
                  err instanceof Error ? err.message : t('notices.failedToLoadSnapshot'),
                )
                return null
              })
      if (rows === null) return { error: t('notices.couldNotLoadSnapshot', { id: snapshotId }) }
      return rows.length > 0
        ? { rows }
        : { error: t('notices.snapshotNoRows') }
    }
    const snapshotNow = getWorkspaceSnapshot()
    if (!snapshotNow.rows || snapshotNow.rows.length === 0) {
      return { error: t('notices.noGridData'), emptyGrid: true }
    }
    return { rows: snapshotNow.rows }
  }

  /** Route files the script wrote through the save bridge: silently default
   *  to the user's Downloads folder, and fall back to a native "Save As"
   *  dialog when Downloads is not writable. Surfaces a summary via ``notice``. */
  const saveScriptOutputFiles = async (files: ScriptOutputFile[]) => {
    const saved: { filename: string; path?: string }[] = []
    let cancelled = false
    for (const file of files) {
      try {
        const result: DownloadResult = await downloadBlob(base64ToBlob(file.data_base64), file.filename)
        if (result.cancelled) {
          cancelled = true
          continue
        }
        saved.push({ filename: file.filename, path: result.savedPath })
      } catch (err) {
        showNotice(
          err instanceof Error ? err.message : t('notices.failedToSaveFile', { filename: file.filename }),
        )
        return
      }
    }
    if (cancelled && saved.length === 0) {
      showNotice(t('notices.exportCancelled'))
    } else if (saved.length === 1) {
      const { filename, path } = saved[0]
      showNotice(
        path
          ? t('notices.savedFileTo', { filename, path })
          : t('notices.savedFile', { filename }),
        'success',
      )
    } else if (saved.length > 1) {
      showNotice(t('notices.savedFiles', { count: saved.length }), 'success')
    }
  }

  const runScriptPayload = async (payload: {
    language: string
    script: string
    rows?: Record<string, unknown>[] | null
  }) => {
    setScriptRunning(true)
    setLiveOutput('')
    try {
      // Stream the run so the user sees live output instead of waiting for the
      // whole script to finish (large datasets can take a while).
      const result = await api.runScriptStream(payload, (chunk) =>
        setLiveOutput((prev) => prev + chunk),
      )
      setScriptResult(result)
      // Save any files the script wrote by relative path (they landed in a
      // staging folder). Route them through the same save bridge as CSV/Excel
      // exports so the user gets a native "Save As" dialog when Downloads is
      // not writable.
      if (result.output_files?.length) {
        await saveScriptOutputFiles(result.output_files)
      }
    } catch (err) {
      setScriptResult({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : t('notices.scriptFailed'),
        elapsed_ms: 0,
        row_count: 0,
        timed_out: false,
        message: null,
      })
    } finally {
      setScriptRunning(false)
    }
  }

  const handleRunScript = async () => {
    if (!scriptText.trim()) {
      setScriptResult({
        ok: false,
        stdout: '',
        stderr: t('notices.enterScript'),
        elapsed_ms: 0,
        row_count: 0,
        timed_out: false,
        message: null,
      })
      return
    }
    const resolved = await resolveScriptData()
    if (resolved.emptyGrid) {
      // No grid data is not fatal — let the user decide whether to proceed with
      // an empty `data` list or stop and load some data first.
      setRunWithoutDataOpen(true)
      return
    }
    if (resolved.error) {
      setScriptResult({
        ok: false,
        stdout: '',
        stderr: resolved.error,
        elapsed_ms: 0,
        row_count: 0,
        timed_out: false,
        message: null,
      })
      return
    }
    await runScriptPayload({
      language: 'python',
      script: scriptText,
      rows: resolved.rows ?? null,
    })
  }

  /** The user chose to run despite an empty grid: pass no rows to the script. */
  const handleConfirmRunWithoutData = async () => {
    setRunWithoutDataOpen(false)
    await runScriptPayload({ language: 'python', script: scriptText, rows: null })
  }

  // ---- Save as pre-defined ----
  const openSaveScriptDialog = () => {
    setSaveScriptName('')
    setSaveScriptDescription('')
    setSaveScriptError(null)
    setSelectedScriptId('')
    setSaveScriptDialogOpen(true)
    setScriptsLoading(true)
    api
      .getScripts()
      .then((list) => setExistingScripts(list))
      .catch(() => setExistingScripts([]))
      .finally(() => setScriptsLoading(false))
  }

  /** Pick an existing script to overwrite; prefill name/description. */
  const handleScriptSelectChange = (event: SelectChangeEvent) => {
    const id = event.target.value
    setSelectedScriptId(id)
    const found = existingScripts.find((s) => s.id === id)
    if (found) {
      setSaveScriptName(found.name)
      setSaveScriptDescription(found.description ?? '')
    }
  }

  const handleSaveScript = async () => {
    const name = saveScriptName.trim()
    if (!name) {
      setSaveScriptError(t('notices.enterScriptName'))
      return
    }
    const resolved = await resolveScriptData()
    if (resolved.error) {
      setSaveScriptError(resolved.error)
      return
    }
    // The data actually fed to the script is not stored with it; keep the
    // workspace's current builder query / custom SQL so the saved script can
    // re-run its data source when launched from the Pre-defined list.
    const snapshotNow = getWorkspaceSnapshot()
    setSavingScript(true)
    setSaveScriptError(null)
    try {
      if (selectedScriptId) {
        // Overwrite the selected entry, keeping its data source unchanged.
        const existing = existingScripts.find((s) => s.id === selectedScriptId)
        await api.updateScript(selectedScriptId, {
          name,
          description: saveScriptDescription,
          script: scriptText,
          // Only touch connection when the entry is found (undefined = unchanged).
          connection_id: existing?.connection_id,
          query: existing?.query ?? null,
          sql: existing?.sql ?? null,
        })
      } else {
        await api.createScript({
          name,
          description: saveScriptDescription,
          language: 'python',
          script: scriptText,
          connection_id: snapshotNow.builderQuery?.connection_id ?? snapshotNow.connectionId ?? null,
          query: snapshotNow.builderQuery ?? null,
          sql: snapshotNow.sqlText.trim() ? snapshotNow.sqlText : null,
        })
      }
      setSaveScriptDialogOpen(false)
      showNotice(
        selectedScriptId
          ? t('notices.updatedPredefined', { name })
          : t('notices.savedPredefined', { name }),
        'success',
      )
      void refresh()
    } catch (err) {
      setSaveScriptError(err instanceof Error ? err.message : t('notices.failedToSaveScript'))
    } finally {
      setSavingScript(false)
    }
  }

  // ---- Loading a script (pre-defined list, AI sidebar insert) ----
  const applyLoadScript = (action: {
    script: {
      language: string
      script: string
      connection_id?: string | null
      query?: Record<string, unknown> | null
      sql?: string | null
    }
    source?: 'builder' | 'sql' | 'none'
  }) => {
    setScriptText(action.script.script)
    setScriptResult(null)
    if (action.script.query) {
      // Sync the workspace builder state so the grid can be re-run with the same data.
      emit({
        type: 'load-builder',
        query: action.script.query,
        connectionId: action.script.connection_id ?? undefined,
      })
    } else if (action.script.sql) {
      // Sync the workspace SQL state so the grid can be re-run with the same data.
      emit({
        type: 'load-sql',
        sql: action.script.sql,
        connectionId: action.script.connection_id ?? undefined,
      })
    }
    setTab('script')
    setCustomOpen(false)
  }

  useEffect(() => {
    return subscribe((action) => {
      if (action.type === 'load-script') applyLoadScript(action)
      // The guided tour spotlights controls on a specific tab (e.g. the
      // template picker on Script), so it has to be able to open that tab.
      else if (action.type === 'show-analyze-tab') setTab(action.tab)
      else if (action.type === 'apply-chart' && action.target !== 'bi') {
        // AI sidebar chart: surface the generated option on the Chart tab.
        // Charts emitted from the BI page carry target 'bi' and land there.
        setAiOption({ option: action.option, nonce: Date.now() })
        setTab('chart')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Pre-defined actions ----
  const openInEditor = (script: ScriptEntry) => {
    applyLoadScript({
      script: {
        language: script.language,
        script: script.script,
        connection_id: script.connection_id,
        query: script.query ? (script.query as unknown as Record<string, unknown>) : null,
        sql: script.sql ?? null,
      },
    })
  }

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.deleteScript(deleteTarget.id)
      setScripts((current) => current.filter((s) => s.id !== deleteTarget.id))
      showNotice(t('notices.deleted', { name: deleteTarget.name }), 'success')
      setDeleteTarget(null)
    } catch (err) {
      showNotice(err instanceof Error ? err.message : t('notices.failedToDelete'))
    } finally {
      setDeleting(false)
    }
  }

  const openEdit = (script: ScriptEntry) => {
    setEditTarget({
      id: script.id,
      name: script.name,
      description: script.description ?? '',
      connectionId: script.query?.connection_id ?? script.connection_id ?? '',
      query: script.query ?? null,
      sql: script.sql ?? null,
    })
    setEditName(script.name)
    setEditDescription(script.description ?? '')
    setEditConnection(script.query?.connection_id ?? script.connection_id ?? '')
    setEditSource(script.query ? 'query' : script.sql ? 'sql' : 'none')
    setEditSql(script.sql ?? '')
  }

  const handleEditConfirmed = async () => {
    if (!editTarget) return
    const name = editName.trim()
    if (!name) {
      showNotice(t('notices.enterName'))
      return
    }
    if (editSource === 'sql' && !editSql.trim()) {
      showNotice(t('notices.enterSql'))
      return
    }
    setEditing(true)
    try {
      // A builder-query source keeps its stored definition, re-pointed at the
      // chosen connection; sql/none drop the query.
      const updated = await api.updateScript(editTarget.id, {
        name,
        description: editDescription,
        connection_id: editConnection || null,
        query:
          editSource === 'query' && editTarget.query
            ? { ...editTarget.query, connection_id: editConnection }
            : null,
        sql: editSource === 'sql' ? editSql : null,
      })
      setScripts((current) => current.map((s) => (s.id === editTarget.id ? updated : s)))
      showNotice(t('notices.updated', { name }), 'success')
      setEditTarget(null)
    } catch (err) {
      showNotice(err instanceof Error ? err.message : t('notices.failedToUpdate'))
    } finally {
      setEditing(false)
    }
  }

  // Resolve a connection id -> display label (connection name, else DSN).
  const connectionLabel = useMemo(() => {
    const map = new Map(connections.map((c) => [c.id, c]))
    return (connectionId?: string | null): string => {
      if (!connectionId) return t('common.noConnection')
      const conn = map.get(connectionId)
      if (!conn) return t('common.deletedConnection')
      return conn.name || conn.dsn || t('common.unnamedConnection')
    }
  }, [connections, t])

  const snapshotForSubtitle = getWorkspaceSnapshot()

  const selectedSnapshot = snapshots.find((s) => s.id === snapshotId) ?? null
  const selectedSnapshotRowCount =
    snapshotRows?.id === snapshotId ? snapshotRows.rows.length : selectedSnapshot?.row_count ?? 0

  // ---- Chart / Summary tab data ----
  // Both tabs work on the grid table loaded in the Query tab, so wrap the
  // workspace snapshot in the QueryResult shape the panels expect.
  const chartResult = useMemo<QueryResult | null>(() => {
    const { rows, columns, columnTypes, sqlText } = snapshotForSubtitle
    if (rows.length === 0) return null
    const names = columns.length > 0 ? columns : Object.keys(rows[0] ?? {})
    return {
      rows,
      // Carry the grid's column types (including user type edits) so the chart
      // builder's column panel reflects them instead of re-sampling rows.
      columns: names.map((name) => ({ name, type: columnTypes[name] ?? '' })),
      row_count: rows.length,
      elapsed_ms: 0,
      sql: sqlText,
    }
  }, [snapshotForSubtitle])

  const chartSource = useMemo<QuerySource>(() => {
    const { builderQuery, sqlText, connectionId } = snapshotForSubtitle
    if (builderQuery) return { kind: 'builder', query: builderQuery }
    if (sqlText.trim()) return { kind: 'sql', connectionId, sql: sqlText }
    return { kind: 'upload' }
  }, [snapshotForSubtitle])

  // ---- Copy script output ----
  const [copiedOutput, setCopiedOutput] = useState(false)
  const copyScriptOutput = useCallback(async () => {
    if (!scriptResult) return
    const text = [scriptResult.stdout, scriptResult.stderr].filter(Boolean).join('\n')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for restricted contexts (e.g. some Electron builds).
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setCopiedOutput(true)
    window.setTimeout(() => setCopiedOutput(false), 1500)
  }, [scriptResult])

  // ---- Copy the Copilot prompt from the how-to pop-up ----
  const copyPrompt = useCallback(async () => {
    const prompt = t('help.copilotPrompt')
    try {
      await navigator.clipboard.writeText(prompt)
    } catch {
      // Fallback for restricted contexts (same as copyScriptOutput).
      const textarea = document.createElement('textarea')
      textarea.value = prompt
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setPromptCopied(true)
    window.setTimeout(() => setPromptCopied(false), 1500)
  }, [t])

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h5">{t('page.title')}</Typography>
          <Typography variant="body2" color="text.secondary">
            <Trans ns="script" i18nKey="page.subtitle" components={{ b: <b /> }} />
          </Typography>
        </Box>

        <Tabs
          value={tab}
          onChange={(_event, value: ScriptTab) => setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="script" icon={<TerminalIcon />} iconPosition="start" label={t('tabs.script')} />
          <Tab value="chart" icon={<BarChartIcon />} iconPosition="start" label={t('tabs.chart')} />
          <Tab value="insights" icon={<InsightsIcon />} iconPosition="start" label={t('tabs.insights')} />
          <Tab value="analyze" icon={<PsychologyOutlinedIcon />} iconPosition="start" label={t('tabs.analyze')} />
        </Tabs>

        {tab === 'script' && (
          <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Stack spacing={2}>
              {/* Stacked at every width: each control gets its own full-width
                  row, matching the reference layout on wide screens too. */}
              <Stack spacing={1} useFlexGap>
                {/* The data-source switch shares its row with the page help
                    icon (pushed to the far right). */}
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                  }}
                >
                  <ToggleButtonGroup
                    value={dataSource}
                    exclusive
                    size="small"
                    onChange={(_event, value: 'grid' | 'snapshot' | null) => {
                      if (value) handleDataSourceChange(value)
                    }}
                    aria-label={t('dataSource.aria')}
                    sx={{
                      flexShrink: 0,
                      '& .MuiToggleButton-root': { minHeight: 48, px: 1.5, textTransform: 'none' },
                    }}
                  >
                    <ToggleButton value="grid" aria-label={t('dataSource.gridAria')}>
                      <GridOnIcon fontSize="small" sx={{ mr: 0.5 }} />
                      {t('dataSource.grid')}
                    </ToggleButton>
                    <ToggleButton value="snapshot" aria-label={t('dataSource.snapshotAria')}>
                      <StorageIcon fontSize="small" sx={{ mr: 0.5 }} />
                      {t('dataSource.snapshot')}
                    </ToggleButton>
                  </ToggleButtonGroup>
                  <Tooltip title={t('help.openTooltip')}>
                    <IconButton
                      aria-label={t('help.openAria')}
                      onClick={() => setHelpOpen(true)}
                      sx={{ flexShrink: 0, minWidth: 48, minHeight: 48 }}
                    >
                      <HelpOutlineOutlinedIcon />
                    </IconButton>
                  </Tooltip>
                </Stack>

                {dataSource === 'snapshot' && (
                  <FormControl size="small" sx={{ minWidth: '100%' }}>
                    <InputLabel shrink>{t('dataSource.snapshotLabel')}</InputLabel>
                    <Select
                      value={snapshotId}
                      onChange={(e: SelectChangeEvent) => handleSelectSnapshot(e.target.value)}
                      label={t('dataSource.snapshotLabel')}
                      displayEmpty
                      disabled={snapshotsLoading || snapshots.length === 0}
                      renderValue={(v) => {
                        const found = snapshots.find((s) => s.id === v)
                        if (found) return found.name
                        return snapshotsLoading
                          ? t('common.loading')
                          : t('dataSource.selectSnapshot')
                      }}
                    >
                      {snapshots.map((s) => (
                        <MenuItem key={s.id} value={s.id}>
                          {t('dataSource.snapshotOption', {
                            name: s.name,
                            rows: s.row_count.toLocaleString(),
                          })}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}

                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
                  {dataSource === 'grid' ? (
                    snapshotForSubtitle.rows.length > 0 ? (
                      <Trans
                        ns="script"
                        i18nKey="dataSource.gridRows"
                        count={snapshotForSubtitle.rows.length}
                        components={{ b: <b /> }}
                      />
                    ) : (
                      t('dataSource.gridEmpty')
                    )
                  ) : selectedSnapshot ? (
                    snapshotRowsLoading ? (
                      <Trans
                        ns="script"
                        i18nKey="dataSource.snapshotLoading"
                        values={{ name: selectedSnapshot.name }}
                        components={{ b: <b /> }}
                      />
                    ) : (
                      <Trans
                        ns="script"
                        i18nKey="dataSource.snapshotRows"
                        count={selectedSnapshotRowCount}
                        values={{ name: selectedSnapshot.name }}
                        components={{ b: <b /> }}
                      />
                    )
                  ) : (
                    t('dataSource.snapshotEmpty')
                  )}
                </Typography>

                <Stack data-tour="script-template" spacing={1} useFlexGap>
                  {/* Wide screens: the dropdown grows to fill the row and the
                      View button stays beside it. Phones: the 100% minWidth
                      wraps the button onto its own row, as before. */}
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <FormControl
                      size="small"
                      sx={{ flexGrow: 1, minWidth: { xs: '100%', md: 0 } }}
                    >
                      <InputLabel shrink>{t('templates.label')}</InputLabel>
                      <Select
                        value={selectedTemplate}
                        onChange={(e: SelectChangeEvent) => handleSelectTemplate(e.target.value)}
                        label={t('templates.label')}
                        displayEmpty
                        sx={{ height: 48 }}
                        renderValue={(v) =>
                          v !== ''
                            ? v
                            : templatesLoading
                              ? t('common.loading')
                              : t('templates.select')
                        }
                      >
                        {templates.map((tmpl) => (
                          <MenuItem key={tmpl.name} value={tmpl.name}>
                            {tmpl.title ? `${tmpl.title} (${tmpl.name})` : tmpl.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Button
                      variant="outlined"
                      startIcon={<VisibilityIcon />}
                      onClick={() => {
                        setTemplateOpen(true)
                        if (templates.length === 0) void loadTemplates()
                      }}
                      sx={{ flexShrink: 0, minHeight: 48 }}
                      aria-haspopup="dialog"
                    >
                      {t('common.view')}
                    </Button>
                  </Stack>
                </Stack>
              </Stack>

              {snapshotError && (
                <Alert severity="error" onClose={() => setSnapshotError(null)}>
                  {snapshotError}
                </Alert>
              )}

              {templateError && (
                <Alert severity="error" onClose={() => setTemplateError(null)}>
                  {templateError}
                </Alert>
              )}

              <Box sx={{ position: 'relative' }} aria-busy={templateBusy !== ''}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {t('script.pythonLabel')}
                </Typography>
                <CodeEditor
                  ariaLabel={t('script.pythonLabel')}
                  language="python"
                  value={scriptText}
                  onChange={setScriptText}
                  placeholder={t('script.placeholder')}
                />
                {/* Progress indicator while a template's source is fetched —
                    shown for both the template picker and the template library. */}
                {templateBusy !== '' && (
                  <Box
                    role="status"
                    aria-live="polite"
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 1,
                      px: 2,
                      textAlign: 'center',
                      borderRadius: 1,
                      bgcolor: (theme) => alpha(theme.palette.background.paper, 0.72),
                    }}
                  >
                    <CircularProgress size={28} />
                    <Typography variant="body2" color="text.secondary">
                      {t('script.loadingTemplate')}
                    </Typography>
                  </Box>
                )}
              </Box>

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                useFlexGap
                sx={{ alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
              >
                <Button
                  variant="contained"
                  startIcon={
                    scriptRunning ? <CircularProgress size={18} color="inherit" /> : <PlayArrowIcon />
                  }
                  onClick={() => void handleRunScript()}
                  disabled={scriptRunning || !scriptText.trim()}
                  sx={{ minHeight: 48 }}
                >
                  {scriptRunning ? t('script.running') : t('script.run')}
                </Button>
                <>
                  <Button
                    variant="outlined"
                    startIcon={<CodeIcon />}
                    onClick={(event) => setExampleMenuAnchor(event.currentTarget)}
                    disabled={scriptRunning}
                    sx={{ minHeight: 48 }}
                  >
                    {t('script.insertExample')}
                  </Button>
                  <Menu
                    anchorEl={exampleMenuAnchor}
                    open={Boolean(exampleMenuAnchor)}
                    onClose={() => setExampleMenuAnchor(null)}
                  >
                    {SCRIPT_EXAMPLES.map((example) => (
                      <MenuItem
                        key={example.labelKey}
                        onClick={() => handleInsertExample(example.code)}
                      >
                        {t(example.labelKey)}
                      </MenuItem>
                    ))}
                  </Menu>
                </>
                <Button
                  variant="outlined"
                  startIcon={<AutoAwesomeIcon />}
                  onClick={() => onOpenAi?.('script')}
                  disabled={scriptRunning}
                  sx={{ minHeight: 48 }}
                >
                  {t('script.aiAssist')}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<SaveIcon />}
                  onClick={openSaveScriptDialog}
                  disabled={savingScript || !scriptText.trim()}
                  sx={{ minHeight: 48 }}
                >
                  {t('script.save')}
                </Button>
                {/* The count rides in the button's top-right corner, matching the
                    Custom button on the Query tab. */}
                <span style={{ display: 'flex' }}>
                  <Badge
                    badgeContent={scripts.length}
                    max={99}
                    color="primary"
                    sx={{
                      display: 'flex',
                      width: { xs: '100%', sm: 'auto' },
                      '& .MuiBadge-badge': { fontWeight: 700, fontSize: 11 },
                    }}
                  >
                    <Button
                      variant="outlined"
                      startIcon={<BookmarksIcon />}
                      onClick={() => setCustomOpen(true)}
                      sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
                    >
                      {t('script.custom')}
                    </Button>
                  </Badge>
                </span>
              </Stack>

              {scriptRunning && (
                <Paper variant="outlined" sx={{ p: 1.5 }}>
                  <Stack spacing={1}>
                    <LinearProgress />
                    <Typography variant="caption" color="text.secondary">
                      {t('script.runningLog')}
                    </Typography>
                    {liveOutput && (
                      <Box
                        ref={liveOutputRef}
                        sx={{
                          bgcolor: 'action.hover',
                          borderRadius: 1,
                          p: 1.5,
                          maxHeight: 320,
                          overflow: 'auto',
                          m: 0,
                        }}
                      >
                        <Box
                          component="pre"
                          sx={{
                            fontFamily: 'Consolas, monospace',
                            fontSize: '0.8125rem',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            m: 0,
                          }}
                        >
                          {renderOutputLinks(liveOutput)}
                        </Box>
                      </Box>
                    )}
                  </Stack>
                </Paper>
              )}

              {scriptResult && (
                <Paper variant="outlined" sx={{ p: 1.5 }}>
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Chip
                        size="small"
                        color={scriptResult.ok ? 'success' : 'error'}
                        variant="outlined"
                        label={scriptResult.ok ? t('script.finished') : t('script.failed')}
                      />
                      <Typography variant="caption" color="text.secondary">
                        {t('script.resultMeta', {
                          rows: scriptResult.row_count.toLocaleString(),
                          ms: scriptResult.elapsed_ms.toLocaleString(),
                        })}
                      </Typography>
                      <Box sx={{ flexGrow: 1 }} />
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<ContentCopyIcon />}
                        onClick={() => void copyScriptOutput()}
                        disabled={!scriptResult.stdout && !scriptResult.stderr}
                        sx={{ minHeight: 36 }}
                      >
                        {copiedOutput ? t('script.copied') : t('script.copyOutput')}
                      </Button>
                    </Stack>
                    {scriptResult.message && (
                      <Alert severity="warning" sx={{ py: 0 }}>
                        {scriptResult.message}
                      </Alert>
                    )}
                    {scriptResult.stdout && (
                      <Typography
                        component="pre"
                        sx={{
                          fontFamily: 'Consolas, monospace',
                          fontSize: '0.8125rem',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          bgcolor: 'action.hover',
                          borderRadius: 1,
                          p: 1.5,
                          m: 0,
                          maxHeight: 320,
                          overflow: 'auto',
                        }}
                      >
                        {renderOutputLinks(scriptResult.stdout)}
                      </Typography>
                    )}
                    {scriptResult.stderr && (
                      <Typography
                        component="pre"
                        sx={{
                          fontFamily: 'Consolas, monospace',
                          fontSize: '0.8125rem',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          bgcolor: 'error.light',
                          color: 'error.contrastText',
                          borderRadius: 1,
                          p: 1.5,
                          m: 0,
                          maxHeight: 320,
                          overflow: 'auto',
                        }}
                      >
                        {renderOutputLinks(scriptResult.stderr)}
                      </Typography>
                    )}
                    {!scriptResult.stdout && !scriptResult.stderr && (
                      <Typography variant="body2" color="text.secondary">
                        {t('script.noOutput')}
                      </Typography>
                    )}
                  </Stack>
                </Paper>
              )}
            </Stack>
          </Paper>
        )}

        {tab === 'chart' && (
          <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
            {chartResult ? (
              <ChartsPanel
                source={chartSource}
                result={chartResult}
                aiOption={aiOption}
                onClearAi={() => setAiOption(null)}
                onAiChart={() => onOpenAi?.('chart')}
              />
            ) : (
              <Box sx={{ textAlign: 'center', py: 6, px: 2 }}>
                <BarChartIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
                <Typography variant="h6" gutterBottom>
                  {t('chart.emptyTitle')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t('chart.emptyBody')}
                </Typography>
              </Box>
            )}
          </Paper>
        )}

        {tab === 'insights' && <InsightPanel />}

        {tab === 'analyze' && <AnalyzePanel />}
      </Stack>

      {/* Custom (pre-defined) scripts — pop-up under the Script tab */}
      <Dialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        fullWidth
        maxWidth="lg"
        fullScreen={customFullScreen}
        slotProps={{ paper: { sx: { height: { xs: '100%', sm: 'min(90vh, 860px)' } } } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
          <BookmarksIcon color="primary" />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>{t('custom.title')}</Box>
          <IconButton onClick={() => setCustomOpen(false)} aria-label={t('custom.closeAria')}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <>
            {loading && <LinearProgress />}
            {loadError && (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" size="small" onClick={() => void refresh()}>
                    {t('common.retry')}
                  </Button>
                }
              >
                {loadError}
              </Alert>
            )}
            {!loading && !loadError && scripts.length === 0 && (
              <Paper variant="outlined" sx={{ textAlign: 'center', py: 6, px: 2 }}>
                <TerminalIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
                <Typography variant="h6" gutterBottom>
                  {t('custom.emptyTitle')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t('custom.emptyBody')}
                </Typography>
              </Paper>
            )}
            {scripts.length > 0 && (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label={t('custom.tableAria')}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 600 }}>{t('custom.colConnection')}</TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>{t('custom.colName')}</TableCell>
                      <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {t('custom.colLanguage')}
                      </TableCell>
                      <TableCell
                        sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}
                      >
                        {t('custom.colDataSource')}
                      </TableCell>
                      <TableCell
                        sx={{ fontWeight: 600, display: { xs: 'none', sm: 'table-cell' } }}
                      >
                        {t('custom.colDescription')}
                      </TableCell>
                      <TableCell
                        sx={{
                          fontWeight: 600,
                          display: { xs: 'none', md: 'table-cell' },
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t('custom.colUpdated')}
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {t('custom.colActions')}
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {scripts.map((script) => (
                      <TableRow key={script.id} hover>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          <Typography variant="body2" color="text.secondary">
                            {connectionLabel(script.connection_id)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            sx={{ fontWeight: 600, wordBreak: 'break-word' }}
                          >
                            {script.name}
                          </Typography>
                          {/* On phones the Data source/Description/Updated columns are
                              hidden, so fold the key facts into the name cell. */}
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: { xs: 'block', md: 'none' } }}
                          >
                            {script.query
                              ? t('custom.tableSource', { table: script.query.table })
                              : script.sql
                                ? t('custom.customSqlSource')
                                : t('custom.noDataSource')}
                          </Typography>
                          {script.description && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: { xs: 'block', sm: 'none' } }}
                            >
                              {script.description}
                            </Typography>
                          )}
                          <Typography
                            variant="caption"
                            color="text.disabled"
                            sx={{ display: { xs: 'block', md: 'none' } }}
                          >
                            {t('custom.updatedDate', {
                              date: new Date(script.updated_at).toLocaleDateString(),
                            })}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            color={script.language === 'python' ? 'success' : 'warning'}
                            variant="outlined"
                            label={script.language === 'python' ? t('custom.langPython') : t('custom.langJs')}
                          />
                        </TableCell>
                        <TableCell
                          sx={{ display: { xs: 'none', md: 'table-cell' }, color: 'text.secondary' }}
                        >
                          {script.query
                            ? t('custom.tableSource', { table: script.query.table })
                            : script.sql
                              ? t('custom.customSqlSource')
                              : t('custom.noDataSource')}
                        </TableCell>
                        <TableCell
                          sx={{
                            display: { xs: 'none', sm: 'table-cell' },
                            color: 'text.secondary',
                            maxWidth: 320,
                          }}
                        >
                          {script.description || '—'}
                        </TableCell>
                        <TableCell
                          sx={{ display: { xs: 'none', md: 'table-cell' }, whiteSpace: 'nowrap' }}
                        >
                          {new Date(script.updated_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell align="right">
                          <Stack
                            direction="row"
                            spacing={0.5}
                            sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
                          >
                            <Tooltip title={t('custom.openInEditor')}>
                              <IconButton
                                size="small"
                                color="primary"
                                aria-label={t('custom.openAria', { name: script.name })}
                                onClick={() => openInEditor(script)}
                                sx={{ width: 48, height: 48 }}
                              >
                                <FileOpenIcon />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title={t('custom.edit')}>
                              <IconButton
                                size="small"
                                aria-label={t('custom.editAria', { name: script.name })}
                                onClick={() => openEdit(script)}
                                sx={{ width: 48, height: 48 }}
                              >
                                <EditIcon />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title={t('custom.delete')}>
                              <IconButton
                                size="small"
                                color="error"
                                aria-label={t('custom.deleteAria', { name: script.name })}
                                onClick={() => setDeleteTarget({ id: script.id, name: script.name })}
                                sx={{ width: 48, height: 48 }}
                              >
                                <DeleteIcon />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        </DialogContent>
      </Dialog>

      {/* Script templates — the published catalog, opened by the View button */}
      <Dialog
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        fullWidth
        maxWidth="lg"
        fullScreen={templateFullScreen}
        slotProps={{ paper: { sx: { height: { xs: '100%', sm: 'min(90vh, 860px)' } } } }}
      >
        <DialogTitle
          sx={{ display: 'flex', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 1, pr: 1 }}
        >
          <CodeIcon color="primary" sx={{ mt: { xs: 1, sm: 0 } }} />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            {t('templates.dialogTitle')}
            <Typography variant="caption" component="div" color="text.secondary">
              <Trans ns="script" i18nKey="templates.dialogSubtitle" components={{ code: <code /> }} />
            </Typography>
          </Box>
          <IconButton
            onClick={() => void loadTemplates()}
            disabled={templatesLoading}
            aria-label={t('templates.refreshAria')}
            sx={{ width: 48, height: 48 }}
          >
            {templatesLoading ? <CircularProgress size={20} /> : <RefreshIcon />}
          </IconButton>
          <IconButton
            onClick={() => setTemplateOpen(false)}
            aria-label={t('templates.closeAria')}
            sx={{ width: 48, height: 48 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {templatesLoading && templates.length === 0 && <LinearProgress sx={{ mb: 2 }} />}
          {templateError && (
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => void loadTemplates()}>
                  {t('common.retry')}
                </Button>
              }
              sx={{ mb: 2 }}
            >
              {templateError}
            </Alert>
          )}
          {!templatesLoading && !templateError && templates.length === 0 && (
            <Paper variant="outlined" sx={{ textAlign: 'center', py: 6, px: 2 }}>
              <CodeIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
              <Typography variant="h6" gutterBottom>
                {t('templates.emptyTitle')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <Trans ns="script" i18nKey="templates.emptyBody" components={{ code: <code /> }} />
              </Typography>
            </Paper>
          )}
          {templates.length > 0 && (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('templates.tableAria')}>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell sx={{ fontWeight: 600 }}>{t('templates.colTemplate')}</TableCell>
                    <TableCell
                      sx={{
                        fontWeight: 600,
                        display: { xs: 'none', md: 'table-cell' },
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t('templates.colFile')}
                    </TableCell>
                    <TableCell
                      sx={{ fontWeight: 600, display: { xs: 'none', sm: 'table-cell' } }}
                    >
                      {t('templates.colApplicable')}
                    </TableCell>
                    <TableCell
                      sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}
                    >
                      {t('templates.colDescription')}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        fontWeight: 600,
                        display: { xs: 'none', md: 'table-cell' },
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t('templates.colSize')}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>
                      {t('templates.colUse')}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        fontWeight: 600,
                        // Wrap on phones: a nowrap label would widen the column past the
                        // narrow dialog and push the example link off screen.
                        whiteSpace: { xs: 'normal', sm: 'nowrap' },
                      }}
                    >
                      {t('templates.colExample')}
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {templates.map((tmpl) => {
                    const busy = templateBusy === tmpl.name
                    const expanded = expandedTemplate === tmpl.name
                    const requires = tmpl.details?.requires ?? []
                    const optional = tmpl.details?.optional ?? []
                    const outputs = tmpl.details?.outputs ?? []
                    const hasDetails =
                      requires.length > 0 || optional.length > 0 || outputs.length > 0
                    const label = tmpl.title || tmpl.name
                    const detailId = `template-details-${tmpl.name}`
                    return (
                      <Fragment key={tmpl.name}>
                        <TableRow hover>
                          <TableCell padding="checkbox">
                            <IconButton
                              onClick={() => setExpandedTemplate(expanded ? '' : tmpl.name)}
                              aria-label={
                                expanded
                                  ? t('templates.hideDetails', { label })
                                  : t('templates.showDetails', { label })
                              }
                              aria-expanded={expanded}
                              aria-controls={expanded ? detailId : undefined}
                              sx={{ width: 48, height: 48 }}
                            >
                              {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                            </IconButton>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {label}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: { xs: 'block', md: 'none' }, wordBreak: 'break-word' }}
                            >
                              {[tmpl.filename, tmpl.size].filter(Boolean).join(' · ')}
                            </Typography>
                          </TableCell>
                          <TableCell
                            sx={{
                              display: { xs: 'none', md: 'table-cell' },
                              fontFamily: 'monospace',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {tmpl.filename}
                          </TableCell>
                          <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
                            {tmpl.appliesTo || '—'}
                          </TableCell>
                          <TableCell
                            sx={{ display: { xs: 'none', md: 'table-cell' }, color: 'text.secondary' }}
                          >
                            {tmpl.description || '—'}
                          </TableCell>
                          <TableCell
                            align="right"
                            sx={{
                              display: { xs: 'none', md: 'table-cell' },
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {tmpl.size || '—'}
                          </TableCell>
                          <TableCell align="right">
                            <Tooltip title={t('templates.useTooltip')}>
                              {/* A disabled IconButton swallows mouse events, so it is
                                  wrapped in a span for the tooltip to still fire. */}
                              <span>
                                <IconButton
                                  onClick={() => void handleUseTemplate(tmpl)}
                                  disabled={busy}
                                  aria-label={t('templates.useAria', { label })}
                                  sx={{ width: 48, height: 48 }}
                                >
                                  {busy ? (
                                    <CircularProgress size={16} color="inherit" />
                                  ) : (
                                    <FileOpenIcon />
                                  )}
                                </IconButton>
                              </span>
                            </Tooltip>
                          </TableCell>
                          <TableCell align="right">
                            {tmpl.example ? (
                              <Tooltip title={tmpl.example.label || t('templates.sampleDashboard')}>
                                <Link
                                  component="button"
                                  type="button"
                                  onClick={() => void openExample(tmpl)}
                                  disabled={exampleBusy === tmpl.name}
                                  underline="hover"
                                  sx={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 0.5,
                                    minHeight: 48,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {exampleBusy === tmpl.name ? (
                                    <CircularProgress size={16} color="inherit" />
                                  ) : (
                                    <VisibilityIcon fontSize="small" />
                                  )}
                                  {t('common.view')}
                                </Link>
                              </Tooltip>
                            ) : (
                              <Typography variant="body2" color="text.disabled">
                                —
                              </Typography>
                            )}
                          </TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow>
                            <TableCell
                              colSpan={8}
                              id={detailId}
                              sx={{ bgcolor: 'action.hover', py: 2.5 }}
                            >
                              <Stack spacing={2}>
                                {tmpl.description && (
                                  <Typography variant="body2">{tmpl.description}</Typography>
                                )}
                                {hasDetails ? (
                                  <Box
                                    sx={{
                                      display: 'grid',
                                      gap: 2,
                                      gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                                    }}
                                  >
                                    {requires.length > 0 && (
                                      <Box>
                                        <Typography variant="subtitle2" gutterBottom>
                                          {t('templates.requires')}
                                        </Typography>
                                        <Stack
                                          direction="row"
                                          useFlexGap
                                          spacing={0.5}
                                          sx={{ flexWrap: 'wrap' }}
                                        >
                                          {requires.map((column) => (
                                            <Chip
                                              key={column}
                                              size="small"
                                              variant="outlined"
                                              label={column}
                                            />
                                          ))}
                                        </Stack>
                                      </Box>
                                    )}
                                    {optional.length > 0 && (
                                      <Box>
                                        <Typography variant="subtitle2" gutterBottom>
                                          {t('templates.optional')}
                                        </Typography>
                                        <Stack
                                          direction="row"
                                          useFlexGap
                                          spacing={0.5}
                                          sx={{ flexWrap: 'wrap' }}
                                        >
                                          {optional.map((column) => (
                                            <Chip
                                              key={column}
                                              size="small"
                                              variant="outlined"
                                              label={column}
                                            />
                                          ))}
                                        </Stack>
                                      </Box>
                                    )}
                                    {outputs.length > 0 && (
                                      <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
                                        <Typography variant="subtitle2" gutterBottom>
                                          {t('templates.outputs')}
                                        </Typography>
                                        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                                          {outputs.map((output) => (
                                            <li key={output}>
                                              <Typography variant="body2">{output}</Typography>
                                            </li>
                                          ))}
                                        </Box>
                                      </Box>
                                    )}
                                  </Box>
                                ) : (
                                  <Typography variant="body2" color="text.secondary">
                                    {t('templates.noDetails')}
                                  </Typography>
                                )}
                                {tmpl.updated && (
                                  <Typography variant="caption" color="text.secondary">
                                    {t('templates.updated', { date: tmpl.updated })}
                                  </Typography>
                                )}
                              </Stack>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DialogContent>
      </Dialog>

      {/* Sample-dashboard viewer. Shown in-app rather than via window.open so it
          works inside the native WebView2 window, where popups are intercepted. */}
      <Dialog
        open={examplePreview !== null}
        onClose={closeExamplePreview}
        fullScreen={exampleFullScreen}
        maxWidth={false}
        slotProps={{
          paper: {
            sx: {
              width: { xs: '100%', md: '90vw' },
              height: exampleFullScreen ? '100%' : '88vh',
              maxWidth: 'none',
              maxHeight: 'none',
              m: { md: 3 },
            },
          },
        }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
          <InsightsIcon color="primary" />
          <Box
            sx={{
              flexGrow: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {examplePreview?.title || t('templates.sampleDashboard')}
          </Box>
          <IconButton
            onClick={closeExamplePreview}
            aria-label={t('templates.viewerCloseAria')}
            sx={{ width: 48, height: 48 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, display: 'flex', overflow: 'hidden' }}>
          {examplePreview && (
            <iframe
              src={examplePreview.url}
              title={examplePreview.title}
              style={{ border: 0, width: '100%', height: '100%', background: '#fff' }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Save script as pre-defined dialog */}
      {/* How-to pop-up: opened from the help icon on the data-source row */}
      <Dialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        fullWidth
        maxWidth="sm"
        fullScreen={helpFullScreen}
        slotProps={{ paper: { sx: { height: { xs: '100%', sm: 'auto' }, maxHeight: '92vh' } } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
          <HelpOutlineOutlinedIcon color="primary" />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>{t('help.title')}</Box>
          <IconButton
            onClick={() => setHelpOpen(false)}
            aria-label={t('help.closeAria')}
            sx={{ width: 48, height: 48 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2">
              <Trans ns="script" i18nKey="help.intro" components={{ b: <b />, code: <code /> }} />
            </Typography>
            <Box component="ol" sx={{ m: 0, pl: 3, '& li': { mb: 1, typography: 'body2', pl: 0.5 } }}>
              <li>
                <Trans ns="script" i18nKey="help.step1" components={{ b: <b />, code: <code /> }} />
              </li>
              <li>
                <Trans ns="script" i18nKey="help.step2" components={{ b: <b />, code: <code /> }} />
              </li>
              <li>
                <Trans ns="script" i18nKey="help.step3" components={{ b: <b />, code: <code /> }} />
              </li>
              <li>
                <Trans ns="script" i18nKey="help.step4" components={{ b: <b />, code: <code /> }} />
              </li>
            </Box>
            <Divider />
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t('help.tipTitle')}</Typography>
              <Typography variant="body2" color="text.secondary">
                <Trans ns="script" i18nKey="help.tipIntro" components={{ b: <b /> }} />
              </Typography>
              <Box component="ol" sx={{ m: 0, pl: 3, '& li': { typography: 'body2', pl: 0.5 } }}>
                <li>
                  <Trans ns="script" i18nKey="help.tipTask" components={{ b: <b />, code: <code /> }} />
                </li>
                <li>
                  <Trans
                    ns="script"
                    i18nKey="help.tipContract"
                    components={{ b: <b />, code: <code /> }}
                  />
                </li>
                <li>
                  <Trans ns="script" i18nKey="help.tipSample" components={{ b: <b />, code: <code /> }} />
                </li>
              </Box>
              <Typography variant="body2" color="text.secondary">
                {t('help.tipOutro')}
              </Typography>
            </Stack>
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'action.hover' }}>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: 'text.secondary',
                  }}
                >
                  {t('help.promptHeading')}
                </Typography>
                <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => void copyPrompt()}>
                  {promptCopied ? t('help.copied') : t('help.copy')}
                </Button>
              </Stack>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  fontFamily: 'Consolas, monospace',
                  fontSize: '0.78rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  userSelect: 'text',
                }}
              >
                {t('help.copilotPrompt')}
              </Box>
            </Paper>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* Save script as pre-defined */}
      <Dialog open={saveScriptDialogOpen} onClose={() => setSaveScriptDialogOpen(false)}>
        <DialogTitle>{t('saveDialog.title')}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={1.5}>
            <FormControl fullWidth size="small">
              <InputLabel id="save-script-select-label">{t('saveDialog.existingLabel')}</InputLabel>
              <Select
                labelId="save-script-select-label"
                label={t('saveDialog.existingLabel')}
                value={selectedScriptId}
                onChange={handleScriptSelectChange}
                disabled={scriptsLoading}
              >
                <MenuItem value="">
                  <em>{t('saveDialog.noneNew')}</em>
                </MenuItem>
                {existingScripts.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label={t('saveDialog.nameLabel')}
              value={saveScriptName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSaveScriptName(event.target.value)}
              fullWidth
              required
              autoFocus
              placeholder={t('saveDialog.namePlaceholder')}
            />
            <TextField
              label={t('saveDialog.descriptionLabel')}
              value={saveScriptDescription}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSaveScriptDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              placeholder={t('saveDialog.descriptionPlaceholder')}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {t('saveDialog.hint')}
            </Typography>
          </Stack>
          {saveScriptError && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {saveScriptError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setSaveScriptDialogOpen(false)} disabled={savingScript} sx={{ minHeight: 44 }}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSaveScript()}
            disabled={savingScript}
            startIcon={savingScript ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            sx={{ minHeight: 44 }}
          >
            {selectedScriptId ? t('saveDialog.update') : t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit script name, connection, data source & description */}
      <Dialog open={editTarget !== null} onClose={() => setEditTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t('editDialog.title')}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={1.5}>
            <TextField
              label={t('editDialog.nameLabel')}
              value={editName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setEditName(event.target.value)}
              fullWidth
              required
              autoFocus
            />
            <FormControl fullWidth size="small">
              <InputLabel id="edit-script-connection-label">
                {t('editDialog.connectionLabel')}
              </InputLabel>
              <Select
                labelId="edit-script-connection-label"
                label={t('editDialog.connectionLabel')}
                value={editConnection}
                onChange={(e: SelectChangeEvent) => setEditConnection(e.target.value)}
              >
                <MenuItem value="">
                  <em>{t('common.noConnection')}</em>
                </MenuItem>
                {connections.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name || c.dsn || t('common.unnamedConnection')}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel id="edit-script-source-label">{t('editDialog.sourceLabel')}</InputLabel>
              <Select
                labelId="edit-script-source-label"
                label={t('editDialog.sourceLabel')}
                value={editSource}
                onChange={(e: SelectChangeEvent) => setEditSource(e.target.value as EditSourceKind)}
              >
                {editTarget?.query ? (
                  <MenuItem value="query">
                    {t('editDialog.sourceTable', { table: editTarget.query.table })}
                  </MenuItem>
                ) : null}
                <MenuItem value="sql">{t('editDialog.sourceSql')}</MenuItem>
                <MenuItem value="none">{t('editDialog.sourceNone')}</MenuItem>
              </Select>
            </FormControl>
            {editSource === 'sql' ? (
              <TextField
                label={t('editDialog.sqlLabel')}
                value={editSql}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setEditSql(event.target.value)}
                fullWidth
                multiline
                minRows={4}
                placeholder={t('editDialog.sqlPlaceholder')}
              />
            ) : null}
            <TextField
              label={t('editDialog.descriptionLabel')}
              value={editDescription}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setEditDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              placeholder={t('editDialog.descriptionPlaceholder')}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditTarget(null)} disabled={editing} sx={{ minHeight: 44 }}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleEditConfirmed()}
            disabled={editing || !editName.trim()}
            startIcon={editing ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            sx={{ minHeight: 44 }}
          >
            {t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs">
        <DialogTitle>{t('deleteDialog.title', { name: deleteTarget?.name })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t('deleteDialog.body')}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting} sx={{ minHeight: 44 }}>
            {t('common.cancel')}
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDeleteConfirmed()}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
            sx={{ minHeight: 44 }}
          >
            {t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Run without grid data — the grid is empty, but the script may not need it */}
      <Dialog
        open={runWithoutDataOpen}
        onClose={() => setRunWithoutDataOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('noDataDialog.title')}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            {t('noDataDialog.warning')}
          </Alert>
          <Typography variant="body2" color="text.secondary">
            {t('noDataDialog.body')}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRunWithoutDataOpen(false)} sx={{ minHeight: 44 }}>
            {t('noDataDialog.stop')}
          </Button>
          <Button
            variant="contained"
            color="warning"
            startIcon={<PlayArrowIcon />}
            onClick={() => void handleConfirmRunWithoutData()}
            sx={{ minHeight: 44 }}
          >
            {t('noDataDialog.proceed')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={noticeSeverity}
          variant="filled"
          onClose={() => setNotice(null)}
        >
          {notice}
        </Alert>
      </Snackbar>
    </Box>
  )
}

// The page stays mounted while another tab is shown, so memoising it keeps a
// view switch from re-rendering every other page in the shell.
export default memo(ScriptPage)
