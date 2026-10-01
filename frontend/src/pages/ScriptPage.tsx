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
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import SaveIcon from '@mui/icons-material/Save'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BarChartIcon from '@mui/icons-material/BarChart'
import BookmarksIcon from '@mui/icons-material/Bookmarks'
import CodeIcon from '@mui/icons-material/Code'
import FunctionsIcon from '@mui/icons-material/Functions'
import RefreshIcon from '@mui/icons-material/Refresh'
import StorageIcon from '@mui/icons-material/Storage'
import TerminalIcon from '@mui/icons-material/Terminal'
import VisibilityIcon from '@mui/icons-material/Visibility'
import Alert from '@mui/material/Alert'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
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
import { api, downloadBlob } from '../api/client'
import type { DownloadResult, SnapshotMeta } from '../api/client'
import type {
  AiMode,
  DbConnection,
  GridDrillFilter,
  QueryResult,
  QuerySource,
  ScriptEntry,
  ScriptOutputFile,
  ScriptRunResult,
  ScriptTemplate,
} from '../types'
import { emit, subscribe } from '../editorBus'
import { getWorkspaceSnapshot } from '../workspaceBus'
import ChartsPanel from '../components/ChartsPanel'
import SummaryPanel from '../components/SummaryPanel'

type ScriptTab = 'script' | 'chart' | 'summary'

interface DeleteTarget {
  id: string
  name: string
}

interface EditTarget {
  id: string
  name: string
  description: string
}

/** Imperative API the shell uses to refresh this page when its tab is opened. */
export interface ScriptPageHandle {
  /** Re-fetch the saved scripts and connections so the lists are current. */
  refresh: () => void
}

interface ScriptPageProps {
  /** Open the global AI sidebar in the given specialty (Query / Analyze / Chart). */
  onOpenAi?: (mode: AiMode) => void
  /** Drill through from the Summary tab: filter the Query grid by these
   *  conditions and reveal it. An empty array only clears the filter. */
  onDrillThrough?: (filters: GridDrillFilter[]) => void
  /** The shell asks the page to refresh through this handle when the tab is
   *  opened. A boolean "active" prop would instead re-render the page on every
   *  switch — including the ones where it is only being hidden. */
  ref?: Ref<ScriptPageHandle>
}

/** Ready-to-run snippets that work on any grid table. They never reference a
 *  specific column name — instead they detect text/numeric columns from the
 *  data itself (data is a list of row dicts). */
const SCRIPT_EXAMPLES: { label: string; code: string }[] = [
  {
    label: 'Overview & basic statistics',
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
    label: 'Group by a category (mean of a numeric column)',
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
    label: 'Correlation between numeric columns',
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
    label: 'Find outliers (IQR) in numeric columns',
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
    label: 'Export grid to Excel (Downloads folder)',
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

function ScriptPage({ onOpenAi, onDrillThrough, ref }: ScriptPageProps = {}) {
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

  // ---- Template scripts (Supabase ``templates/`` catalog, bundled fallback) ----
  /** Whether the "use template" toggle is on. On by default so the Script tab
   *  opens with the template list ready instead of an empty editor. */
  const [useTemplate, setUseTemplate] = useState(true)
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
  /** Stem whose source is being fetched, so only that row shows a spinner. */
  const [templateBusy, setTemplateBusy] = useState('')
  /** Stem of the row whose detail panel is open (one at a time). */
  const [expandedTemplate, setExpandedTemplate] = useState('')
  /** Stem whose sample dashboard is being fetched, so only that row spins. */
  const [exampleBusy, setExampleBusy] = useState('')

  /** Fetch the published template list (Supabase catalog, bundled fallback). */
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplateError(null)
    try {
      setTemplates(await api.listScriptTemplates())
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : 'Failed to load templates')
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  // Load the template list when the toggle is switched on.
  useEffect(() => {
    if (!useTemplate || templates.length > 0) return
    void loadTemplates()
  }, [useTemplate, templates.length, loadTemplates])

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
      setTemplateError(err instanceof Error ? err.message : `Failed to load template '${name}'`)
      return false
    } finally {
      setTemplateBusy('')
    }
  }, [])

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
      setNotice(`Loaded “${tmpl.title || tmpl.name}” into the editor`)
    }
  }

  /** Open a template's sample dashboard, rendered, in a new tab.
   *
   *  The bucket serves HTML objects as ``text/plain`` with ``nosniff``, so
   *  linking straight at the object URL would show source code. Fetching the
   *  bytes (CORS is open) and handing the browser a ``text/html`` blob makes it
   *  render the dashboard instead. */
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
      window.open(blobUrl, '_blank', 'noopener')
      // Release the blob once the new tab has had time to load it.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    } catch (err) {
      setNotice(
        `Could not open the example dashboard: ${err instanceof Error ? err.message : 'download failed'}`,
      )
    } finally {
      setExampleBusy('')
    }
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
  const [editing, setEditing] = useState(false)

  const [notice, setNotice] = useState<string | null>(null)

  // ---- Pre-defined scripts list ----
  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [list, connectionList] = await Promise.all([api.getScripts(), api.getConnections()])
      setScripts(list)
      setConnections(connectionList)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load pre-defined scripts')
    } finally {
      setLoading(false)
    }
  }, [])

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
      setSnapshotError(err instanceof Error ? err.message : 'Failed to load the snapshot')
    } finally {
      setSnapshotRowsLoading(false)
    }
  }, [])

  /** Fetch the snapshot list lazily — only once the snapshot source is picked. */
  const loadSnapshotList = useCallback(async () => {
    setSnapshotsLoading(true)
    setSnapshotError(null)
    try {
      setSnapshots(await api.listSnapshots())
    } catch (err) {
      setSnapshotError(err instanceof Error ? err.message : 'Failed to load snapshots')
    } finally {
      setSnapshotsLoading(false)
    }
  }, [])

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
  }> => {
    if (dataSource === 'snapshot') {
      if (!snapshotId) {
        return { error: 'Choose a snapshot under Analyze → Script → Snapshot data first.' }
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
                setSnapshotError(err instanceof Error ? err.message : 'Failed to load the snapshot')
                return null
              })
      if (rows === null) return { error: `Could not load snapshot "${snapshotId}".` }
      return rows.length > 0
        ? { rows }
        : { error: 'The selected snapshot has no stored rows.' }
    }
    const snapshotNow = getWorkspaceSnapshot()
    if (!snapshotNow.rows || snapshotNow.rows.length === 0) {
      return { error: 'No grid data — run a query or upload a file in the Query tab first.' }
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
        setNotice(err instanceof Error ? err.message : `Failed to save "${file.filename}"`)
        return
      }
    }
    if (cancelled && saved.length === 0) {
      setNotice('Export cancelled.')
    } else if (saved.length === 1) {
      const { filename, path } = saved[0]
      setNotice(path ? `Saved "${filename}" to ${path}` : `Saved "${filename}".`)
    } else if (saved.length > 1) {
      setNotice(`Saved ${saved.length} files to Downloads.`)
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
        stderr: err instanceof Error ? err.message : 'Script failed',
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
        stderr: 'Enter a script to run.',
        elapsed_ms: 0,
        row_count: 0,
        timed_out: false,
        message: null,
      })
      return
    }
    const resolved = await resolveScriptData()
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
      setSaveScriptError('Enter a name for the script.')
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
      setNotice(
        selectedScriptId
          ? `Updated pre-defined script "${name}".`
          : `Saved as pre-defined script "${name}".`,
      )
      void refresh()
    } catch (err) {
      setSaveScriptError(err instanceof Error ? err.message : 'Failed to save script')
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
      setNotice(`Deleted "${deleteTarget.name}".`)
      setDeleteTarget(null)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  const openEdit = (script: ScriptEntry) => {
    setEditTarget({ id: script.id, name: script.name, description: script.description ?? '' })
    setEditName(script.name)
    setEditDescription(script.description ?? '')
  }

  const handleEditConfirmed = async () => {
    if (!editTarget) return
    const name = editName.trim()
    if (!name) {
      setNotice('Enter a name.')
      return
    }
    setEditing(true)
    try {
      // Connection is defined by the script's data source, not here.
      const updated = await api.updateScript(editTarget.id, {
        name,
        description: editDescription,
      })
      setScripts((current) => current.map((s) => (s.id === editTarget.id ? updated : s)))
      setNotice(`Updated "${name}".`)
      setEditTarget(null)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setEditing(false)
    }
  }

  // Resolve a connection id -> display label (connection name, else DSN).
  const connectionLabel = useMemo(() => {
    const map = new Map(connections.map((c) => [c.id, c]))
    return (connectionId?: string | null): string => {
      if (!connectionId) return 'No connection'
      const conn = map.get(connectionId)
      if (!conn) return 'Deleted connection'
      return conn.name || conn.dsn || 'Unnamed connection'
    }
  }, [connections])

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

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h5">Analyze</Typography>
          <Typography variant="body2" color="text.secondary">
            Script, chart or summarize the rows currently in the grid. Scripts
            run in Python with the rows passed as <b>data</b> (a list of row
            dicts), and the Summary tab aggregates them in the browser.
          </Typography>
        </Box>

        <Tabs
          value={tab}
          onChange={(_event, value: ScriptTab) => setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="script" icon={<TerminalIcon />} iconPosition="start" label="Script" />
          <Tab value="chart" icon={<BarChartIcon />} iconPosition="start" label="Chart" />
          <Tab value="summary" icon={<FunctionsIcon />} iconPosition="start" label="Summary" />
        </Tabs>

        {tab === 'script' && (
          <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Stack spacing={2}>
              {/* Stacked at every width: each control gets its own full-width
                  row, matching the reference layout on wide screens too. */}
              <Stack spacing={1} useFlexGap>
                <ToggleButtonGroup
                  value={dataSource}
                  exclusive
                  size="small"
                  onChange={(_event, value: 'grid' | 'snapshot' | null) => {
                    if (value) handleDataSourceChange(value)
                  }}
                  aria-label="Script data source"
                  sx={{
                    flexShrink: 0,
                    '& .MuiToggleButton-root': { minHeight: 48, px: 1.5, textTransform: 'none' },
                  }}
                >
                  <ToggleButton value="grid" aria-label="Use grid data">
                    <GridOnIcon fontSize="small" sx={{ mr: 0.5 }} />
                    Grid data
                  </ToggleButton>
                  <ToggleButton value="snapshot" aria-label="Use snapshot data">
                    <StorageIcon fontSize="small" sx={{ mr: 0.5 }} />
                    Snapshot data
                  </ToggleButton>
                </ToggleButtonGroup>

                {dataSource === 'snapshot' && (
                  <FormControl size="small" sx={{ minWidth: '100%' }}>
                    <InputLabel shrink>Snapshot</InputLabel>
                    <Select
                      value={snapshotId}
                      onChange={(e: SelectChangeEvent) => handleSelectSnapshot(e.target.value)}
                      label="Snapshot"
                      displayEmpty
                      disabled={snapshotsLoading || snapshots.length === 0}
                      renderValue={(v) => {
                        const found = snapshots.find((s) => s.id === v)
                        if (found) return found.name
                        return snapshotsLoading ? 'Loading…' : 'Select a snapshot…'
                      }}
                    >
                      {snapshots.map((s) => (
                        <MenuItem key={s.id} value={s.id}>
                          {`${s.name} — ${s.row_count.toLocaleString()} rows`}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}

                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
                  {dataSource === 'grid' ? (
                    snapshotForSubtitle.rows.length > 0 ? (
                      <>
                        Data source: <b>all grid table data</b> —{' '}
                        {snapshotForSubtitle.rows.length.toLocaleString()} row
                        {snapshotForSubtitle.rows.length === 1 ? '' : 's'} in the grid.
                      </>
                    ) : (
                      'Data source: grid table data — no rows yet. Run a query or upload a file in the Query tab first.'
                    )
                  ) : selectedSnapshot ? (
                    <>
                      Data source: <b>{selectedSnapshot.name}</b> —{' '}
                      {snapshotRowsLoading
                        ? 'loading rows…'
                        : `${selectedSnapshotRowCount.toLocaleString()} stored row${
                            selectedSnapshotRowCount === 1 ? '' : 's'
                          }.`}
                    </>
                  ) : (
                    'Data source: stored snapshot — pick one to run the script against it.'
                  )}
                </Typography>

                <Stack data-tour="script-template" spacing={1} useFlexGap>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={useTemplate}
                        onChange={(e) => {
                          setUseTemplate(e.target.checked)
                          if (!e.target.checked) setSelectedTemplate('')
                        }}
                        sx={{ '& .MuiSvgIcon-root': { fontSize: 24 } }}
                      />
                    }
                    label="Use template"
                  />
                  {/* Wide screens: the dropdown grows to fill the row and the
                      View button stays beside it. Phones: the 100% minWidth
                      wraps the button onto its own row, as before. */}
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    {useTemplate && (
                      <FormControl
                        size="small"
                        sx={{ flexGrow: 1, minWidth: { xs: '100%', md: 0 } }}
                      >
                        <InputLabel shrink>Template</InputLabel>
                        <Select
                          value={selectedTemplate}
                          onChange={(e: SelectChangeEvent) => handleSelectTemplate(e.target.value)}
                          label="Template"
                          displayEmpty
                          renderValue={(v) =>
                            v !== '' ? v : templatesLoading ? 'Loading…' : 'Select a template…'
                          }
                        >
                          {templates.map((t) => (
                            <MenuItem key={t.name} value={t.name}>
                              {t.title ? `${t.title} (${t.name})` : t.name}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    )}
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
                      View
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
                <TextField
                  label="Python script"
                  value={scriptText}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setScriptText(event.target.value)}
                  fullWidth
                  multiline
                  rows={8}
                  placeholder={
                    "# data is the queried rows (list of dicts)\n# Use \"Insert example\" below to load ready-to-run code that works on any grid table."
                  }
                  sx={{ '& textarea': { fontFamily: 'Consolas, monospace', fontSize: '0.875rem' } }}
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
                      Loading template…
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
                  {scriptRunning ? 'Running…' : 'Run script'}
                </Button>
                <>
                  <Button
                    variant="outlined"
                    startIcon={<CodeIcon />}
                    onClick={(event) => setExampleMenuAnchor(event.currentTarget)}
                    disabled={scriptRunning}
                    sx={{ minHeight: 48 }}
                  >
                    Insert example
                  </Button>
                  <Menu
                    anchorEl={exampleMenuAnchor}
                    open={Boolean(exampleMenuAnchor)}
                    onClose={() => setExampleMenuAnchor(null)}
                  >
                    {SCRIPT_EXAMPLES.map((example) => (
                      <MenuItem key={example.label} onClick={() => handleInsertExample(example.code)}>
                        {example.label}
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
                  AI assist
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<SaveIcon />}
                  onClick={openSaveScriptDialog}
                  disabled={savingScript || !scriptText.trim()}
                  sx={{ minHeight: 48 }}
                >
                  Save
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
                      Custom
                    </Button>
                  </Badge>
                </span>
              </Stack>

              {scriptRunning && (
                <Paper variant="outlined" sx={{ p: 1.5 }}>
                  <Stack spacing={1}>
                    <LinearProgress />
                    <Typography variant="caption" color="text.secondary">
                      Script running… output appears below as it is produced.
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
                        label={scriptResult.ok ? 'Finished' : 'Failed'}
                      />
                      <Typography variant="caption" color="text.secondary">
                        {scriptResult.row_count.toLocaleString()} data rows ·{' '}
                        {scriptResult.elapsed_ms.toLocaleString()} ms
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
                        {copiedOutput ? 'Copied!' : 'Copy output'}
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
                        Script finished with no output.
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
                  Nothing to chart yet
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Run a query or upload a file in the Query tab — the Analyze
                  chart uses the rows currently loaded in the grid.
                </Typography>
              </Box>
            )}
          </Paper>
        )}

        {tab === 'summary' && (
          <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
            <SummaryPanel result={chartResult} onDrillThrough={onDrillThrough} />
          </Paper>
        )}
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
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>Custom scripts</Box>
          <IconButton onClick={() => setCustomOpen(false)} aria-label="Close custom scripts">
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
                    Retry
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
                  No pre-defined scripts saved
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Write a Python script in the Script tab and press “Save as
                  custom”. Queried data is passed to the script automatically.
                </Typography>
              </Paper>
            )}
            {scripts.length > 0 && (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label="Custom scripts">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 600 }}>Connection</TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                      <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Language
                      </TableCell>
                      <TableCell
                        sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}
                      >
                        Data source
                      </TableCell>
                      <TableCell
                        sx={{ fontWeight: 600, display: { xs: 'none', sm: 'table-cell' } }}
                      >
                        Description
                      </TableCell>
                      <TableCell
                        sx={{
                          fontWeight: 600,
                          display: { xs: 'none', md: 'table-cell' },
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Updated
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Actions
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
                              ? `Table: ${script.query.table}`
                              : script.sql
                                ? 'Custom SQL data source'
                                : 'No data source'}
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
                            Updated {new Date(script.updated_at).toLocaleDateString()}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            color={script.language === 'python' ? 'success' : 'warning'}
                            variant="outlined"
                            label={script.language === 'python' ? 'Python' : 'JS'}
                          />
                        </TableCell>
                        <TableCell
                          sx={{ display: { xs: 'none', md: 'table-cell' }, color: 'text.secondary' }}
                        >
                          {script.query
                            ? `Table: ${script.query.table}`
                            : script.sql
                              ? 'Custom SQL data source'
                              : 'No data source'}
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
                            <Tooltip title="Open in editor">
                              <IconButton
                                size="small"
                                color="primary"
                                aria-label={`Open ${script.name} in editor`}
                                onClick={() => openInEditor(script)}
                                sx={{ width: 48, height: 48 }}
                              >
                                <FileOpenIcon />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Edit">
                              <IconButton
                                size="small"
                                aria-label={`Edit ${script.name}`}
                                onClick={() => openEdit(script)}
                                sx={{ width: 48, height: 48 }}
                              >
                                <EditIcon />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Delete">
                              <IconButton
                                size="small"
                                color="error"
                                aria-label={`Delete ${script.name}`}
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
            Script templates
            <Typography variant="caption" component="div" color="text.secondary">
              Discovered in the Supabase <code>templates/</code> folder — pick one to load into the
              editor.
            </Typography>
          </Box>
          <IconButton
            onClick={() => void loadTemplates()}
            disabled={templatesLoading}
            aria-label="Refresh templates"
            sx={{ width: 48, height: 48 }}
          >
            {templatesLoading ? <CircularProgress size={20} /> : <RefreshIcon />}
          </IconButton>
          <IconButton
            onClick={() => setTemplateOpen(false)}
            aria-label="Close script templates"
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
                  Retry
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
                No templates published
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Publish scripts with <code>backend/publish_templates.py</code>. They appear
                here automatically — no new app build needed.
              </Typography>
            </Paper>
          )}
          {templates.length > 0 && (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label="Script templates">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell sx={{ fontWeight: 600 }}>Template</TableCell>
                    <TableCell
                      sx={{
                        fontWeight: 600,
                        display: { xs: 'none', md: 'table-cell' },
                        whiteSpace: 'nowrap',
                      }}
                    >
                      File name
                    </TableCell>
                    <TableCell
                      sx={{ fontWeight: 600, display: { xs: 'none', sm: 'table-cell' } }}
                    >
                      Applicable data
                    </TableCell>
                    <TableCell
                      sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}
                    >
                      Description
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        fontWeight: 600,
                        display: { xs: 'none', md: 'table-cell' },
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Size
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>
                      Use template
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
                      Example output
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {templates.map((t) => {
                    const busy = templateBusy === t.name
                    const expanded = expandedTemplate === t.name
                    const requires = t.details?.requires ?? []
                    const optional = t.details?.optional ?? []
                    const outputs = t.details?.outputs ?? []
                    const hasDetails =
                      requires.length > 0 || optional.length > 0 || outputs.length > 0
                    const label = t.title || t.name
                    const detailId = `template-details-${t.name}`
                    return (
                      <Fragment key={t.name}>
                        <TableRow hover>
                          <TableCell padding="checkbox">
                            <IconButton
                              onClick={() => setExpandedTemplate(expanded ? '' : t.name)}
                              aria-label={
                                expanded ? `Hide details for ${label}` : `Show details for ${label}`
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
                              {[t.filename, t.size].filter(Boolean).join(' · ')}
                            </Typography>
                          </TableCell>
                          <TableCell
                            sx={{
                              display: { xs: 'none', md: 'table-cell' },
                              fontFamily: 'monospace',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t.filename}
                          </TableCell>
                          <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
                            {t.appliesTo || '—'}
                          </TableCell>
                          <TableCell
                            sx={{ display: { xs: 'none', md: 'table-cell' }, color: 'text.secondary' }}
                          >
                            {t.description || '—'}
                          </TableCell>
                          <TableCell
                            align="right"
                            sx={{
                              display: { xs: 'none', md: 'table-cell' },
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t.size || '—'}
                          </TableCell>
                          <TableCell align="right">
                            <Tooltip title="Use template">
                              {/* A disabled IconButton swallows mouse events, so it is
                                  wrapped in a span for the tooltip to still fire. */}
                              <span>
                                <IconButton
                                  onClick={() => void handleUseTemplate(t)}
                                  disabled={busy}
                                  aria-label={`Use template: ${label}`}
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
                            {t.example ? (
                              <Tooltip title={t.example.label || 'Sample dashboard'}>
                                <Link
                                  component="button"
                                  type="button"
                                  onClick={() => void openExample(t)}
                                  disabled={exampleBusy === t.name}
                                  underline="hover"
                                  sx={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 0.5,
                                    minHeight: 48,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {exampleBusy === t.name ? (
                                    <CircularProgress size={16} color="inherit" />
                                  ) : (
                                    <OpenInNewIcon fontSize="small" />
                                  )}
                                  View
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
                                {t.description && (
                                  <Typography variant="body2">{t.description}</Typography>
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
                                          Requires these columns
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
                                          Optional columns
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
                                          What it outputs
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
                                    No extra details published for this template.
                                  </Typography>
                                )}
                                {t.updated && (
                                  <Typography variant="caption" color="text.secondary">
                                    Updated {t.updated}
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

      {/* Save script as pre-defined dialog */}
      <Dialog open={saveScriptDialogOpen} onClose={() => setSaveScriptDialogOpen(false)}>
        <DialogTitle>Save script as pre-defined</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={1.5}>
            <FormControl fullWidth size="small">
              <InputLabel id="save-script-select-label">Existing script (optional)</InputLabel>
              <Select
                labelId="save-script-select-label"
                label="Existing script (optional)"
                value={selectedScriptId}
                onChange={handleScriptSelectChange}
                disabled={scriptsLoading}
              >
                <MenuItem value="">
                  <em>None — save as new</em>
                </MenuItem>
                {existingScripts.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="Script name"
              value={saveScriptName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSaveScriptName(event.target.value)}
              fullWidth
              required
              autoFocus
              placeholder="e.g. Yield SPC by lot"
            />
            <TextField
              label="Description (optional)"
              value={saveScriptDescription}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSaveScriptDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              placeholder="What this script is for — shown on the pre-defined card."
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Saved to Analyze → Script → Custom. Running it later re-runs the current data source and
              passes the rows to the script.
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
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSaveScript()}
            disabled={savingScript}
            startIcon={savingScript ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            sx={{ minHeight: 44 }}
          >
            {selectedScriptId ? 'Update' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit script name, connection & description */}
      <Dialog open={editTarget !== null} onClose={() => setEditTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit pre-defined script</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={1.5}>
            <TextField
              label="Script name"
              value={editName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setEditName(event.target.value)}
              fullWidth
              required
              autoFocus
            />
            <TextField
              label="Description (optional)"
              value={editDescription}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setEditDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              placeholder="What this script is for — shown on the pre-defined card."
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditTarget(null)} disabled={editing} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleEditConfirmed()}
            disabled={editing || !editName.trim()}
            startIcon={editing ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            sx={{ minHeight: 44 }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs">
        <DialogTitle>Delete “{deleteTarget?.name}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This pre-defined script will be permanently deleted.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDeleteConfirmed()}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
            sx={{ minHeight: 44 }}
          >
            Delete
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
          severity={
            notice?.startsWith('Deleted') ||
            notice?.startsWith('Updated') ||
            notice?.startsWith('Saved') ||
            notice?.startsWith('Loaded') ||
            notice?.startsWith('Copied')
              ? 'success'
              : 'error'
          }
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
