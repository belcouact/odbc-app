/**
 * BI page — store the current Query result grid in a local SQLite warehouse,
 * then reopen stored snapshots to chart or inspect the rows.
 *
 * The warehouse is a per-machine file under %APPDATA%\ODBCQueryApp\data\
 * (see backend/app/warehouse.py). Read-only reference data such as the bundled
 * Pantone TCX table lives separately in the app's app/data/ folder.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, memo } from 'react'
import type { Ref } from 'react'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BarChartIcon from '@mui/icons-material/BarChart'
import BookmarksIcon from '@mui/icons-material/Bookmarks'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import HelpOutlineOutlinedIcon from '@mui/icons-material/HelpOutlineOutlined'
import InputIcon from '@mui/icons-material/Input'
import RefreshIcon from '@mui/icons-material/Refresh'
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard'
import SyncIcon from '@mui/icons-material/Sync'
import TableChartIcon from '@mui/icons-material/TableChart'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
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
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { api } from '../api/client'
import type {
  AiDashboardChart,
  RelationshipJoinPreview,
  SnapshotDetail,
  SnapshotMeta,
  SnapshotRelationship,
  WarehouseInfo,
} from '../api/client'
import ChartsPanel from '../components/ChartsPanel'
import type { ChartPreset } from '../components/ChartsPanel'
import DashboardPanel from '../components/DashboardPanel'
import EChart from '../components/EChart'
import KpiCards from '../components/KpiCards'
import RelationshipsPanel from '../components/RelationshipsPanel'
import { subscribe } from '../editorBus'
import type { GridLoadPayload } from '../editorBus'
import type { QueryResult, QuerySource } from '../types'
import type { EChartsOption } from 'echarts'
import { aiDashboardExamples, aiExamplePlaceholder } from '../utils/columns'
import {
  aiChartToVisual,
  buildVisualChart,
  newVisualId,
  visualTitle,
  type DashboardVisual,
  type VisualConfig,
  type VisualSize,
} from '../utils/visual'
import { getWorkspaceSnapshot } from '../workspaceBus'
import type { WorkspaceSnapshot } from '../workspaceBus'

/** Imperative API the shell uses to refresh this page when its tab is opened. */
export interface BiPageHandle {
  /** Re-read the grid snapshot and re-fetch the warehouse + snapshot list. */
  refresh: () => void
}

interface BiPageProps {
  ref?: Ref<BiPageHandle>
  /** Load a snapshot's rows back into the Query grid (swaps the view there). */
  onLoadToGrid?: (payload: GridLoadPayload) => void
}

/** Rows rendered in the snapshot data preview before the list is truncated. */
const PREVIEW_ROW_LIMIT = 200

/** Row cap for the joined chart dataset (the backend's own ceiling is 5000). */
const JOIN_PREVIEW_LIMIT = 5000

/** Fetches warehouse info + snapshot list; callers map the result to state. */
const fetchList = () => Promise.all([api.getWarehouseInfo(), api.listSnapshots()])

function formatCount(value: number): string {
  return value.toLocaleString()
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/** Column names for a snapshot, falling back to the first row's keys. */
function columnNames(detail: SnapshotDetail): string[] {
  if (detail.columns.length > 0) return detail.columns.map((column) => column.name)
  return Object.keys(detail.rows[0] ?? {})
}

function BiPage({ ref, onLoadToGrid }: BiPageProps = {}) {
  const isCompact = useMediaQuery('(max-width:700px)')

  /** How-to pop-up for this page (opened from the help icon). */
  const [helpOpen, setHelpOpen] = useState(false)

  const [warehouse, setWarehouse] = useState<WarehouseInfo | null>(null)
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')

  // The grid the Query tab currently holds — what "Update from grid" captures.
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => getWorkspaceSnapshot())

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SnapshotDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [tab, setTab] = useState<'dashboard' | 'chart' | 'data'>('dashboard')

  // The opened snapshot's dashboard: the visuals the user pinned, plus which one
  // (if any) is currently loaded back into the chart builder for editing.
  const [visuals, setVisuals] = useState<DashboardVisual[]>([])
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [dashboardSaving, setDashboardSaving] = useState(false)
  const [editingVisualId, setEditingVisualId] = useState<string | null>(null)
  /** Config of the tile being edited, pushed into the Chart tab's builder. */
  const [editingPreset, setEditingPreset] = useState<ChartPreset | null>(null)

  // ---- AI dashboard builder pop-up (the BI "Chart" tab) ----
  /** Whether the AI chart pop-up is open. */
  const [aiOpen, setAiOpen] = useState(false)
  /** The user's plain-language description of the dashboard they want. */
  const [aiPrompt, setAiPrompt] = useState('')
  /** Chart specs the AI designed for the current prompt. */
  const [aiCharts, setAiCharts] = useState<AiDashboardChart[]>([])
  /** Indices of the designed charts selected to pin to the dashboard. */
  const [aiPicked, setAiPicked] = useState<number[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  /** Collapsible "Columns in this data" chip list (collapsed to keep the pop-up compact). */
  const [aiColumnsOpen, setAiColumnsOpen] = useState(false)

  // AI-generated chart option handed over by the AI sidebar (targeted at BI).
  const [aiOption, setAiOption] = useState<{ option: EChartsOption; nonce: number } | null>(null)

  const [renameTarget, setRenameTarget] = useState<SnapshotMeta | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<SnapshotMeta | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [updateTarget, setUpdateTarget] = useState<SnapshotMeta | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  /** Snapshot row whose "load to grid" is being fetched (spinner in that row). */
  const [loadBusyId, setLoadBusyId] = useState<string | null>(null)

  // ---- Relationships for joined chart data ----
  /** Saved relationships; filtered down to those touching the opened snapshot. */
  const [relationships, setRelationships] = useState<SnapshotRelationship[]>([])
  /** Bumped by the relationships panel after edits, reloading the list here. */
  const [relationshipsVersion, setRelationshipsVersion] = useState(0)
  /** Relationship whose joined preview feeds the chart builder ('' = plain table). */
  const [chartJoinId, setChartJoinId] = useState('')
  /** Latest join preview, tagged with its relationship id (derive, don't sync-reset). */
  const [joinData, setJoinData] = useState<{ id: string; preview: RelationshipJoinPreview } | null>(
    null,
  )
  /** Latest join error, tagged with the id it belongs to. */
  const [joinError, setJoinError] = useState<{ id: string; message: string } | null>(null)
  /** Fetched join previews by relationship id, so re-selecting is instant. */
  const joinCacheRef = useRef<Map<string, RelationshipJoinPreview>>(new Map())

  /** Active tab of the combined warehouse section. */
  const [warehouseTab, setWarehouseTab] = useState<'snapshots' | 'relationships'>('snapshots')
  /** Whether the combined warehouse section shows its body. */
  const [warehouseExpanded, setWarehouseExpanded] = useState(true)

  const [notice, setNotice] = useState('')

  const loadList = useCallback(async () => {
    // Event-driven refresh (button, tab activation): setstate is fine here.
    try {
      const [info, list] = await fetchList()
      setWarehouse(info)
      setSnapshots(list)
      setListError('')
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load the warehouse')
    } finally {
      setListLoading(false)
    }
  }, [])

  // Initial load — promise callbacks keep state updates off the effect's
  // synchronous path (lint: react/set-state-in-effect).
  useEffect(() => {
    let cancelled = false
    fetchList()
      .then(([info, list]) => {
        if (!cancelled) {
          setWarehouse(info)
          setSnapshots(list)
          setListError('')
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : 'Failed to load the warehouse')
        }
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = useCallback(() => {
    setWorkspace(getWorkspaceSnapshot())
    void loadList()
  }, [loadList])

  // AI sidebar chart results targeted at BI land here; the sidebar only emits
  // target 'bi' when the chart mode was opened from this page.
  useEffect(() => {
    return subscribe((action) => {
      if (action.type === 'apply-chart' && action.target === 'bi') {
        setAiOption({ option: action.option, nonce: Date.now() })
      }
    })
  }, [])

  // The shell calls this when the BI tab is opened, so results saved elsewhere
  // show up without re-rendering this page on every tab switch.
  useImperativeHandle(ref, () => ({ refresh }), [refresh])

  // ---- Open a snapshot ----
  const openSnapshot = useCallback(async (id: string) => {
    setSelectedId(id)
    setDetail(null)
    setVisuals([])
    setEditingVisualId(null)
    setEditingPreset(null)
    setAiOpen(false)
    setAiPrompt('')
    setAiCharts([])
    setAiPicked([])
    setAiError('')
    // Chart data restarts on the plain table; cached join previews are stale
    // after a data refresh, so drop them too.
    setChartJoinId('')
    setJoinData(null)
    setJoinError(null)
    joinCacheRef.current.clear()
    setDetailLoading(true)
    setDashboardLoading(true)
    try {
      const [data, dashboard] = await Promise.all([api.getSnapshot(id), api.getDashboard(id)])
      setDetail(data)
      setVisuals(dashboard.visuals)
      // A snapshot that already has visuals is a dashboard first; otherwise the
      // user still has to build one, so open the chart builder.
      setTab(dashboard.visuals.length > 0 ? 'dashboard' : 'chart')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to open the snapshot')
      setSelectedId(null)
    } finally {
      setDetailLoading(false)
      setDashboardLoading(false)
    }
  }, [])

  // ---- Refresh an existing snapshot from the grid ----
  // The snapshot keeps its id, name and dashboard, so its charts survive a
  // data refresh; only the stored rows and source metadata are replaced.
  const canUpdateFromGrid = workspace.rows.length > 0

  const handleUpdate = useCallback(async () => {
    if (!updateTarget || !canUpdateFromGrid) return
    setUpdateBusy(true)
    try {
      const updated = await api.updateSnapshotData(updateTarget.id, {
        source: 'grid',
        connection_id: workspace.connectionId || null,
        sql_text: workspace.sqlText || null,
        columns: workspace.columns.map((name) => ({
          name,
          type: workspace.columnTypes[name] ?? '',
        })),
        rows: workspace.rows,
      })
      setSnapshots((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      if (selectedId === updated.id) {
        setDetail(await api.getSnapshot(updated.id))
        // The rows changed, so any cached join previews are stale.
        joinCacheRef.current.clear()
        setJoinData(null)
      }
      setUpdateTarget(null)
      setNotice(
        `Updated "${updated.name}" with ${formatCount(updated.row_count)} rows from the grid`,
      )
      await loadList()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to update the snapshot')
    } finally {
      setUpdateBusy(false)
    }
  }, [updateTarget, canUpdateFromGrid, workspace, selectedId, loadList])

  // ---- Load a snapshot back into the Query grid ----
  // The rows travel through the editor bus (App switches to the Query view);
  // stored column types ride along so the grid keeps its type chips.
  const handleLoadToGrid = useCallback(
    async (snapshot: SnapshotMeta) => {
      if (!onLoadToGrid || loadBusyId) return
      setLoadBusyId(snapshot.id)
      try {
        const detail = await api.getSnapshot(snapshot.id)
        onLoadToGrid({
          name: detail.name,
          columns: detail.columns,
          rows: detail.rows,
        })
        setNotice(`Loaded "${detail.name}" into the grid`)
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Failed to load the snapshot')
      } finally {
        setLoadBusyId(null)
      }
    },
    [onLoadToGrid, loadBusyId],
  )

  // ---- Rename ----
  const openRename = useCallback((snapshot: SnapshotMeta) => {
    setRenameTarget(snapshot)
    setRenameValue(snapshot.name)
  }, [])

  const handleRename = useCallback(async () => {
    if (!renameTarget) return
    const name = renameValue.trim()
    if (!name) return
    setRenameBusy(true)
    try {
      const updated = await api.renameSnapshot(renameTarget.id, name)
      setSnapshots((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      setDetail((prev) => (prev && prev.id === updated.id ? { ...prev, name: updated.name } : prev))
      setRenameTarget(null)
      setNotice(`Renamed to "${updated.name}"`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to rename the snapshot')
    } finally {
      setRenameBusy(false)
    }
  }, [renameTarget, renameValue])

  // ---- Delete ----
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await api.deleteSnapshot(deleteTarget.id)
      if (selectedId === deleteTarget.id) {
        setSelectedId(null)
        setDetail(null)
        setVisuals([])
        setEditingVisualId(null)
        setAiOpen(false)
      }
      setDeleteTarget(null)
      setNotice('Snapshot deleted')
      await loadList()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to delete the snapshot')
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteTarget, selectedId, loadList])

  // ---- Chart / data views for the opened snapshot ----
  // ChartsPanel aggregates client-side from result.rows and needs no query
  // re-run, so a stored snapshot can be charted fully offline.
  const chartResult = useMemo<QueryResult | null>(() => {
    if (!detail || detail.rows.length === 0) return null
    // The stored columns carry their types (grid type edits travel with the
    // save), so the chart builder's column panel honors them rather than
    // re-sampling the rows.
    const storedTypes = new Map(
      (detail.columns ?? []).map((column) => [column.name, column.type]),
    )
    return {
      rows: detail.rows,
      columns: columnNames(detail).map((name) => ({ name, type: storedTypes.get(name) ?? '' })),
      row_count: detail.rows.length,
      elapsed_ms: 0,
      sql: detail.sql_text ?? '',
    }
  }, [detail])

  // ChartsPanel takes a QuerySource (unused for rendering, but required by its
  // API). A snapshot only remembers the SQL it came from, so reconstruct that.
  const chartSource = useMemo<QuerySource>(() => {
    const sql = detail?.sql_text?.trim()
    if (sql) return { kind: 'sql', connectionId: detail?.connection_id ?? '', sql }
    return { kind: 'upload' }
  }, [detail])

  // ---- Joined chart data (relationships touching the opened snapshot) ----
  // Promise callbacks keep state updates off the effect's synchronous path.
  useEffect(() => {
    let cancelled = false
    api
      .listRelationships()
      .then((list) => {
        if (!cancelled) setRelationships(list)
      })
      .catch(() => {
        // Chart joins are optional sugar; the relationships panel surfaces
        // load errors, so this silently keeps them hidden.
      })
    return () => {
      cancelled = true
    }
  }, [relationshipsVersion])

  /** Relationships that touch the opened snapshot in either direction. */
  const chartJoins = useMemo(
    () =>
      selectedId
        ? relationships.filter(
            (item) => item.left_snapshot_id === selectedId || item.right_snapshot_id === selectedId,
          )
        : [],
    [relationships, selectedId],
  )

  // Fetch (or reuse) the flat join preview for the selected relationship.
  useEffect(() => {
    if (!chartJoinId) return
    let cancelled = false
    const cached = joinCacheRef.current.get(chartJoinId)
    const pending = cached
      ? Promise.resolve(cached)
      : api.previewRelationship(chartJoinId, JOIN_PREVIEW_LIMIT)
    pending
      .then((preview) => {
        joinCacheRef.current.set(chartJoinId, preview)
        if (!cancelled) setJoinData({ id: chartJoinId, preview })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setJoinError({
            id: chartJoinId,
            message: err instanceof Error ? err.message : 'Failed to build the joined table',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [chartJoinId])

  /** True once the preview for the current selection has arrived. */
  const joinActive = Boolean(chartJoinId) && joinData?.id === chartJoinId
  const joinLoading = Boolean(chartJoinId) && !joinActive

  /** The joined table reshaped into a QueryResult for ChartsPanel. */
  const joinResult = useMemo<QueryResult | null>(() => {
    if (!joinActive || !joinData) return null
    return {
      rows: joinData.preview.rows,
      // Join columns are flat names (collisions already prefixed server-side);
      // kinds are re-detected from the rows by the chart builder.
      columns: joinData.preview.columns.map((name) => ({ name, type: '' })),
      row_count: joinData.preview.rows.length,
      elapsed_ms: 0,
      sql: '',
    }
  }, [joinActive, joinData])

  // The dataset the AI pop-up describes and previews: the joined table when a
  // relationship is selected, otherwise the snapshot's own rows.
  const activeResult = useMemo(() => joinResult ?? chartResult, [joinResult, chartResult])
  const activeRows = activeResult?.rows ?? []
  const activeColumns = activeResult?.columns ?? []
  /** Data-aware example prompt shown as the AI builder dialog's placeholder. */
  const aiExample = useMemo(
    () => aiExamplePlaceholder(activeColumns, activeRows, 'dashboard'),
    [activeResult, activeColumns, activeRows],
  )
  /** One-click multi-chart example prompts shown above the AI builder's input. */
  const aiExamples = useMemo(
    () => aiDashboardExamples(activeColumns, activeRows),
    [activeResult, activeColumns, activeRows],
  )

  // ---- Dashboard editing ----
  // Every change is written straight through to the warehouse so the dashboard
  // survives a reload; on failure the previous list is restored.
  const persistVisuals = useCallback(
    async (next: DashboardVisual[], message: string) => {
      if (!selectedId) return
      const previous = visuals
      setVisuals(next)
      setDashboardSaving(true)
      try {
        const saved = await api.saveDashboard(selectedId, next)
        setVisuals(saved.visuals)
        setNotice(message)
      } catch (err) {
        setVisuals(previous)
        setNotice(err instanceof Error ? err.message : 'Failed to save the dashboard')
      } finally {
        setDashboardSaving(false)
      }
    },
    [selectedId, visuals],
  )

  /** Ask the AI to design charts for the description in the pop-up. */
  const handleGenerateCharts = useCallback(async () => {
    const requirement = aiPrompt.trim()
    if (!requirement || aiBusy) return
    setAiBusy(true)
    setAiError('')
    try {
      const { charts } = await api.aiDashboard({
        requirement,
        columns: activeColumns,
        rows: activeRows,
      })
      setAiCharts(charts)
      // Select everything the AI proposed; the user can deselect before pinning.
      setAiPicked(charts.map((_chart, index) => index))
    } catch (err) {
      setAiCharts([])
      setAiPicked([])
      setAiError(err instanceof Error ? err.message : 'The AI request failed. Please try again.')
    } finally {
      setAiBusy(false)
    }
  }, [aiPrompt, aiBusy, activeColumns, activeRows])

  /** Tick or untick a designed chart for pinning. */
  const togglePick = useCallback((index: number) => {
    setAiPicked((prev) =>
      prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index],
    )
  }, [])

  /** Pin the selected AI-designed charts (or replace the tile being edited). */
  const handlePinCharts = useCallback(() => {
    const configs = aiPicked
      .slice()
      .sort((a, b) => a - b)
      .map((index) => aiCharts[index])
      .filter((spec): spec is AiDashboardChart => Boolean(spec))
      .map((spec) => aiChartToVisual(spec))
    if (configs.length === 0) return

    if (editingVisualId) {
      // The first selected chart replaces the tile being redesigned; any extra
      // selections are appended as new tiles.
      const [first, ...rest] = configs
      const next = visuals.map((visual) =>
        visual.id === editingVisualId
          ? { ...visual, title: visualTitle(first), config: first }
          : visual,
      )
      for (const config of rest) {
        next.push({ id: newVisualId(), title: visualTitle(config), size: 'medium', config })
      }
      void persistVisuals(next, 'Visual updated')
    } else {
      const added: DashboardVisual[] = configs.map((config) => ({
        id: newVisualId(),
        title: visualTitle(config),
        size: 'medium',
        config,
      }))
      void persistVisuals(
        [...visuals, ...added],
        `Added ${added.length} visual${added.length === 1 ? '' : 's'} to the dashboard`,
      )
    }
    setEditingVisualId(null)
    setEditingPreset(null)
    setAiOpen(false)
    setAiCharts([])
    setAiPicked([])
    setTab('dashboard')
  }, [aiPicked, aiCharts, editingVisualId, visuals, persistVisuals])

  /**
   * Pin a manually built chart config from the Chart tab: replace the tile being
   * edited, or append a new one, then return to the dashboard.
   */
  const handlePinConfig = useCallback(
    (config: VisualConfig) => {
      if (editingVisualId) {
        void persistVisuals(
          visuals.map((visual) =>
            visual.id === editingVisualId
              ? { ...visual, title: visualTitle(config), config }
              : visual,
          ),
          'Visual updated',
        )
      } else {
        void persistVisuals(
          [...visuals, { id: newVisualId(), title: visualTitle(config), size: 'medium', config }],
          'Added 1 visual to the dashboard',
        )
      }
      setEditingVisualId(null)
      setEditingPreset(null)
      setTab('dashboard')
    },
    [editingVisualId, visuals, persistVisuals],
  )

  /** Load an existing tile's config into the Chart tab's builder for editing. */
  const handleEditVisual = useCallback(
    (id: string) => {
      const visual = visuals.find((item) => item.id === id)
      if (!visual) return
      setEditingVisualId(id)
      setEditingPreset({ ...visual.config, nonce: Date.now() })
      setTab('chart')
    },
    [visuals],
  )

  const handleDuplicateVisual = useCallback(
    (id: string) => {
      const visual = visuals.find((item) => item.id === id)
      if (!visual) return
      const copy: DashboardVisual = {
        ...visual,
        id: newVisualId(),
        title: `${visual.title} (copy)`,
      }
      const index = visuals.findIndex((item) => item.id === id)
      const next = [...visuals]
      next.splice(index + 1, 0, copy)
      void persistVisuals(next, 'Visual duplicated')
    },
    [visuals, persistVisuals],
  )

  const handleMoveVisual = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = visuals.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= visuals.length) return
      const next = [...visuals]
      ;[next[index], next[target]] = [next[target], next[index]]
      void persistVisuals(next, 'Visual moved')
    },
    [visuals, persistVisuals],
  )

  const handleResizeVisual = useCallback(
    (id: string, size: VisualSize) => {
      void persistVisuals(
        visuals.map((visual) => (visual.id === id ? { ...visual, size } : visual)),
        'Tile resized',
      )
    },
    [visuals, persistVisuals],
  )

  const handleRemoveVisual = useCallback(
    (id: string) => {
      if (editingVisualId === id) {
        setEditingVisualId(null)
      }
      void persistVisuals(
        visuals.filter((visual) => visual.id !== id),
        'Visual removed from the dashboard',
      )
    },
    [visuals, editingVisualId, persistVisuals],
  )

  /** Open the AI dashboard builder for a brand-new build (dashboard tab). */
  const handleBuildChart = useCallback(() => {
    setEditingVisualId(null)
    setEditingPreset(null)
    setAiCharts([])
    setAiPicked([])
    setAiError('')
    setAiOpen(true)
  }, [])

  /**
   * Open the AI dashboard builder to redesign the tile currently loaded in the
   * Chart tab — the editing target is kept so its own "Update" replaces it.
   */
  const handleRedesignWithAi = useCallback(() => {
    setAiCharts([])
    setAiPicked([])
    setAiError('')
    setAiOpen(true)
  }, [])

  /** ECharts previews for the AI-designed specs, built from the active rows. */
  const aiPreviews = useMemo(
    () =>
      aiCharts.map((spec, index) => ({
        spec,
        index,
        chart: buildVisualChart(activeRows, aiChartToVisual(spec)),
      })),
    [aiCharts, activeRows],
  )

  // A dashboard tile always renders from the snapshot's own rows, so a joined
  // chart (whose columns live in the joined table) cannot be pinned.
  const joinSelected = Boolean(chartJoinId)

  const previewColumns = detail ? columnNames(detail) : []
  const previewRows = detail ? detail.rows.slice(0, PREVIEW_ROW_LIMIT) : []

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Stack spacing={{ xs: 2, md: 2.5 }}>
        {/* ---- Header ---- */}
        <Box>
          {/* Page title shares its row with the help icon (pushed to the far right). */}
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Typography variant="h5">Dashboard</Typography>
            <Tooltip title="How to use this page">
              <IconButton
                aria-label="How to use this page"
                onClick={() => setHelpOpen(true)}
                // The 48px touch target would otherwise inflate the title row
                // (32px line -> 48px) and push the subtitle down; the negative
                // vertical margin cancels that extra height so the title and
                // paragraph spacing matches the Query / Analyze pages.
                sx={{ flexShrink: 0, minWidth: 48, minHeight: 48, my: -1 }}
              >
                <HelpOutlineOutlinedIcon />
              </IconButton>
            </Tooltip>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Save queried data to a local SQLite warehouse, then build a dashboard from it or
            inspect the rows.
          </Typography>
          {warehouse && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mt: 0.5, wordBreak: 'break-all' }}
            >
              {formatCount(warehouse.snapshot_count)} snapshots ·{' '}
              {formatCount(warehouse.row_count)} rows · {formatBytes(warehouse.size_bytes)} —{' '}
              {warehouse.path}
            </Typography>
          )}
        </Box>

        {listError && <Alert severity="error">{listError}</Alert>}

        {/* ---- Warehouse: snapshots + relationships (tabbed, collapsible) ---- */}
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <BookmarksIcon fontSize="small" color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
              Warehouse
            </Typography>
            <Tooltip title="Reload the snapshot list">
              <span>
                <IconButton onClick={() => void loadList()} disabled={listLoading} aria-label="Reload snapshots">
                  {listLoading ? <CircularProgress size={20} /> : <RefreshIcon />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={warehouseExpanded ? 'Collapse section' : 'Expand section'}>
              <IconButton
                aria-expanded={warehouseExpanded}
                aria-label={warehouseExpanded ? 'Collapse warehouse section' : 'Expand warehouse section'}
                onClick={() => setWarehouseExpanded((v) => !v)}
                sx={{
                  transform: warehouseExpanded ? 'rotate(180deg)' : 'none',
                  transition: (theme) => theme.transitions.create('transform', { duration: 200 }),
                }}
              >
                <ExpandMoreIcon />
              </IconButton>
            </Tooltip>
          </Stack>

          {warehouseExpanded && (
            <>
              <Tabs
                value={warehouseTab}
                onChange={(_, next: 'snapshots' | 'relationships') => setWarehouseTab(next)}
                sx={{ borderBottom: 1, borderColor: 'divider', mb: 1.5 }}
              >
                <Tab value="snapshots" label={`Snapshots (${snapshots.length})`} />
                <Tab value="relationships" label={`Relationships (${relationships.length})`} />
              </Tabs>

              {warehouseTab === 'snapshots' &&
                (snapshots.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    {listLoading
                      ? 'Loading…'
                      : 'Nothing stored yet — save a result grid from the Query tab.'}
                  </Typography>
                ) : isCompact ? (
            /* Mobile: one card per snapshot — no horizontal scrolling. */
            <Stack spacing={1.5}>
              {snapshots.map((snapshot) => (
                <Paper
                  key={snapshot.id}
                  variant="outlined"
                  onClick={() => void openSnapshot(snapshot.id)}
                  sx={{
                    p: 1.5,
                    cursor: 'pointer',
                    borderColor: selectedId === snapshot.id ? 'primary.main' : undefined,
                    bgcolor: selectedId === snapshot.id ? 'action.selected' : undefined,
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ wordBreak: 'break-word' }}>
                        {snapshot.name}
                      </Typography>
                      <Stack direction="row" spacing={0.75} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                        <Chip label={snapshot.source} size="small" />
                        <Chip label={`${formatCount(snapshot.row_count)} rows`} size="small" variant="outlined" />
                        <Chip label={`${formatCount(snapshot.columns.length)} columns`} size="small" variant="outlined" />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {formatWhen(snapshot.created_at)}
                      </Typography>
                    </Box>
                    <Tooltip
                      title={
                        onLoadToGrid
                          ? 'Load these rows into the Query grid'
                          : 'Loading into the grid is unavailable'
                      }
                    >
                      <span>
                        <IconButton
                          size="small"
                          aria-label={`Load ${snapshot.name} into the grid`}
                          disabled={!onLoadToGrid || loadBusyId === snapshot.id}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleLoadToGrid(snapshot)
                          }}
                          sx={{ minWidth: 48, minHeight: 48 }}
                        >
                          {loadBusyId === snapshot.id ? (
                            <CircularProgress size={20} />
                          ) : (
                            <InputIcon fontSize="small" />
                          )}
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip
                      title={
                        canUpdateFromGrid
                          ? 'Replace the stored rows with the current grid data'
                          : 'No grid data to update from'
                      }
                    >
                      <span>
                        <IconButton
                          size="small"
                          aria-label={`Update ${snapshot.name} from the grid`}
                          disabled={!canUpdateFromGrid}
                          onClick={(event) => {
                            event.stopPropagation()
                            setUpdateTarget(snapshot)
                          }}
                          sx={{ minWidth: 48, minHeight: 48 }}
                        >
                          <SyncIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <IconButton
                      size="small"
                      aria-label="Rename snapshot"
                      onClick={(event) => { event.stopPropagation(); openRename(snapshot) }}
                      sx={{ minWidth: 48, minHeight: 48 }}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      aria-label="Delete snapshot"
                      onClick={(event) => { event.stopPropagation(); setDeleteTarget(snapshot) }}
                      sx={{ minWidth: 48, minHeight: 48 }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell align="right">Rows</TableCell>
                    <TableCell align="right">Columns</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {snapshots.map((snapshot) => (
                    <TableRow
                      key={snapshot.id}
                      hover
                      selected={selectedId === snapshot.id}
                      onClick={() => void openSnapshot(snapshot.id)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell sx={{ maxWidth: 320 }}>
                        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                          {snapshot.name}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip label={snapshot.source} size="small" />
                      </TableCell>
                      <TableCell align="right">{formatCount(snapshot.row_count)}</TableCell>
                      <TableCell align="right">{formatCount(snapshot.columns.length)}</TableCell>
                      <TableCell>{formatWhen(snapshot.created_at)}</TableCell>
                      <TableCell align="right">
                        <Tooltip
                          title={
                            onLoadToGrid
                              ? 'Load these rows into the Query grid'
                              : 'Loading into the grid is unavailable'
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              aria-label={`Load ${snapshot.name} into the grid`}
                              disabled={!onLoadToGrid || loadBusyId === snapshot.id}
                              onClick={(event) => {
                                event.stopPropagation()
                                void handleLoadToGrid(snapshot)
                              }}
                            >
                              {loadBusyId === snapshot.id ? (
                                <CircularProgress size={20} />
                              ) : (
                                <InputIcon fontSize="small" />
                              )}
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip
                          title={
                            canUpdateFromGrid
                              ? 'Replace the stored rows with the current grid data'
                              : 'No grid data to update from'
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              aria-label={`Update ${snapshot.name} from the grid`}
                              disabled={!canUpdateFromGrid}
                              onClick={(event) => {
                                event.stopPropagation()
                                setUpdateTarget(snapshot)
                              }}
                            >
                              <SyncIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <IconButton size="small" aria-label="Rename snapshot" onClick={(event) => { event.stopPropagation(); openRename(snapshot) }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" aria-label="Delete snapshot" onClick={(event) => { event.stopPropagation(); setDeleteTarget(snapshot) }}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
                ))}

              {warehouseTab === 'relationships' && (
                <RelationshipsPanel
                  snapshots={snapshots}
                  onNotice={setNotice}
                  onChanged={() => setRelationshipsVersion((v) => v + 1)}
                />
              )}
            </>
          )}
        </Paper>

        {/* ---- Opened snapshot: chart or data ---- */}
        {detailLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {detail && (
          <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
              {detail.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatCount(detail.row_count)} rows · {formatCount(columnNames(detail).length)} columns ·{' '}
              {formatWhen(detail.created_at)}
              {detail.sql_text ? ` · ${detail.sql_text.split('\n')[0].trim().slice(0, 80)}` : ''}
            </Typography>

            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1, mb: 1.5 }}>
              <Tabs
                value={tab}
                onChange={(_event, value: 'dashboard' | 'chart' | 'data') => setTab(value)}
                variant="scrollable"
                scrollButtons="auto"
                allowScrollButtonsMobile
                sx={{ flexGrow: 1, minWidth: 0, borderBottom: 1, borderColor: 'divider' }}
              >
                <Tab
                  value="dashboard"
                  icon={<SpaceDashboardIcon fontSize="small" />}
                  iconPosition="start"
                  label={`Dashboard (${visuals.length})`}
                />
                <Tab
                  value="chart"
                  icon={<BarChartIcon fontSize="small" />}
                  iconPosition="start"
                  label="Chart"
                />
                <Tab
                  value="data"
                  icon={<TableChartIcon fontSize="small" />}
                  iconPosition="start"
                  label="Data"
                />
              </Tabs>
              {dashboardSaving && <CircularProgress size={18} />}
            </Stack>

            {tab === 'dashboard' ? (
              <DashboardPanel
                visuals={visuals}
                rows={detail.rows}
                loading={dashboardLoading}
                editingVisualId={editingVisualId}
                onAdd={handleBuildChart}
                onEdit={handleEditVisual}
                onDuplicate={handleDuplicateVisual}
                onMove={handleMoveVisual}
                onResize={handleResizeVisual}
                onRemove={handleRemoveVisual}
              />
            ) : tab === 'chart' ? (
              chartResult ? (
                <ChartsPanel
                  source={chartSource}
                  result={chartResult}
                  preset={editingPreset}
                  aiOption={aiOption}
                  onClearAi={() => setAiOption(null)}
                  onAiChart={editingVisualId ? handleRedesignWithAi : handleBuildChart}
                  aiLabel={editingVisualId ? 'Redesign with AI' : 'Open AI chart builder'}
                  onAddToDashboard={handlePinConfig}
                  addLabel={editingVisualId ? 'Update visual' : 'Add to dashboard'}
                />
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  This snapshot has no rows to chart.
                </Typography>
              )
            ) : previewColumns.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                This snapshot has no stored rows.
              </Typography>
            ) : (
              <>
                <TableContainer sx={{ maxHeight: 480 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        {previewColumns.map((name) => (
                          <TableCell key={name} sx={{ whiteSpace: 'nowrap' }}>
                            {name}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {previewRows.map((row, index) => (
                        <TableRow key={index} hover>
                          {previewColumns.map((name) => {
                            const value = row[name]
                            return (
                              <TableCell key={name} sx={{ whiteSpace: 'nowrap' }}>
                                {value === null || value === undefined ? '' : String(value)}
                              </TableCell>
                            )
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                {detail.rows.length > previewRows.length && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Showing the first {formatCount(previewRows.length)} of{' '}
                    {formatCount(detail.rows.length)} rows.
                  </Typography>
                )}
              </>
            )}
          </Paper>
        )}
      </Stack>

      {/* ---- How-to dialog ---- */}
      <Dialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        fullScreen={isCompact}
        fullWidth
        maxWidth="sm"
        slotProps={{ paper: { sx: { height: { xs: '100%', sm: 'auto' }, maxHeight: '92vh' } } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <HelpOutlineOutlinedIcon fontSize="small" />
          How to use this page
          <IconButton
            aria-label="Close help"
            onClick={() => setHelpOpen(false)}
            sx={{ ml: 'auto', minWidth: 48, minHeight: 48 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This page keeps your query results as <strong>snapshots</strong> in a local SQLite
            warehouse on this machine, so you can chart them later without re-running the query.
          </Typography>
          <Box component="ol" sx={{ m: 0, p: 0, pl: 2.5, '& li': { mb: 1, typography: 'body2', pl: 0.5 } }}>
            <li>
              <strong>Save the current grid</strong> — run a query (or upload a file) in the Query
              tab, then press <em>Save data</em> in the results toolbar. The rows are copied into the
              local warehouse, so later re-queries do not change saved data.
            </li>
            <li>
              <strong>Manage snapshots</strong> — click a row in the list to open it. Use{' '}
              <InputIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} /> to load a
              snapshot's rows back into the Query grid,{' '}
              <SyncIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} /> to update a
              snapshot from the current result grid (existing visuals are kept),{' '}
              <EditIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} /> to rename, and{' '}
              <DeleteIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} /> to delete.
            </li>
            <li>
              <strong>Relationships</strong> — link two snapshots on a shared column (e.g. NAME =
              NAME), then use <em>Explore</em> to drill from a row in one table to its related rows
              in the other, or to preview the flat joined table. Relationships are saved in the
              warehouse and can be edited or deleted at any time.
            </li>
            <li>
              <strong>Dashboard tab</strong> — persistent visuals saved with the snapshot: add
              charts/tables, then edit, duplicate, move, resize or remove each tile.
            </li>
            <li>
              <strong>Chart tab</strong> — describe the dashboard you want in plain language; the AI
              reads this snapshot's column names and designs several charts. Preview each one, untick
              the ones you do not want, then pin the rest to the dashboard.
            </li>
            <li>
              <strong>Data tab</strong> — inspect the stored rows (first 200 shown).
            </li>
          </Box>
          <Divider sx={{ my: 2 }} />
          <Typography variant="body2" color="text.secondary">
            All snapshots are stored per-machine under{' '}
            <Box component="code" sx={{ wordBreak: 'break-all' }}>
              %APPDATA%\ODBCQueryApp\data\
            </Box>{' '}
            — nothing is uploaded to a server.
          </Typography>
        </DialogContent>
      </Dialog>

      {/* ---- AI dashboard builder pop-up (the Chart tab) ---- */}
      <Dialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        fullScreen={isCompact}
        fullWidth
        maxWidth="lg"
        slotProps={{ paper: { sx: { height: { xs: '100%', sm: 'auto' }, maxHeight: '92vh' } } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <AutoAwesomeIcon fontSize="small" color="primary" />
          {editingVisualId ? 'Redesign a dashboard chart' : 'AI dashboard builder'}
          <IconButton
            aria-label="Close AI chart builder"
            onClick={() => setAiOpen(false)}
            sx={{ ml: 'auto', minWidth: 48, minHeight: 48 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {chartJoins.length > 0 && (
            <TextField
              select
              fullWidth
              size="small"
              label="Chart data"
              value={chartJoinId}
              onChange={(event) => setChartJoinId(event.target.value)}
              helperText={
                joinSelected
                  ? 'The AI charts the joined table — pinning to the dashboard works from the plain table only.'
                  : 'Pick a relationship to let the AI chart across the linked table.'
              }
              sx={{ mb: 2 }}
            >
              <MenuItem value="">
                This table — {detail?.name ?? 'current data'} ({formatCount(detail?.row_count ?? 0)} rows)
              </MenuItem>
              {chartJoins.map((rel) => (
                <MenuItem key={rel.id} value={rel.id} sx={{ display: 'block', py: 0.75 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {rel.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    via {rel.left_column} = {rel.right_column} · {rel.join_type} join
                  </Typography>
                </MenuItem>
              ))}
            </TextField>
          )}
          {joinLoading && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="caption" color="text.secondary">
                Building the joined table…
              </Typography>
            </Stack>
          )}
          {joinSelected && joinError?.id === chartJoinId && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {joinError.message}
            </Alert>
          )}

          <Stack
            direction="row"
            useFlexGap
            spacing={1}
            sx={{ flexWrap: 'wrap', alignItems: 'center', mb: aiColumnsOpen ? 1 : 2 }}
          >
            <ButtonBase
              onClick={() => setAiColumnsOpen((open) => !open)}
              aria-expanded={aiColumnsOpen}
              aria-controls="bi-ai-columns"
              sx={{
                display: 'flex',
                justifyContent: 'flex-start',
                alignItems: 'center',
                gap: 0.5,
                px: 0.5,
                minHeight: 44,
                borderRadius: 1,
                textAlign: 'left',
                color: 'text.primary',
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Columns in this data ({formatCount(activeColumns.length)})
              </Typography>
              <ExpandMoreIcon
                fontSize="small"
                sx={{
                  color: 'text.secondary',
                  transform: aiColumnsOpen ? 'rotate(180deg)' : 'none',
                  transition: (theme) => theme.transitions.create('transform', { duration: 200 }),
                }}
              />
            </ButtonBase>

            {aiExamples.length > 0 && (
              <Stack
                direction="row"
                useFlexGap
                spacing={0.5}
                sx={{ flexWrap: 'wrap', alignItems: 'center', ml: { sm: 'auto' } }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: { xs: 'none', sm: 'block' }, mr: 0.5 }}
                >
                  Try an example:
                </Typography>
                {aiExamples.map((example) => (
                  <Button
                    key={example.label}
                    size="small"
                    variant="outlined"
                    color="primary"
                    startIcon={<AutoAwesomeIcon fontSize="inherit" />}
                    onClick={() => setAiPrompt(example.prompt)}
                    disabled={aiBusy}
                    title={example.prompt}
                    sx={{ minHeight: { xs: 44, sm: 34 }, textTransform: 'none', whiteSpace: 'nowrap' }}
                  >
                    {example.label}
                  </Button>
                ))}
              </Stack>
            )}
          </Stack>
          {aiColumnsOpen && (
            <Box id="bi-ai-columns" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
              {activeColumns.map((column) => (
                <Chip
                  key={column.name}
                  label={column.name}
                  size="small"
                  variant="outlined"
                  title={column.type || undefined}
                />
              ))}
            </Box>
          )}

          <TextField
            autoFocus={!isCompact}
            fullWidth
            multiline
            minRows={3}
            maxRows={8}
            label="Describe the dashboard you want"
            placeholder={aiExample}
            value={aiPrompt}
            onChange={(event) => setAiPrompt(event.target.value)}
            disabled={aiBusy}
          />

          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', mt: 1.5, flexWrap: 'wrap' }}>
            <Button
              variant="contained"
              startIcon={
                aiBusy ? <CircularProgress size={18} color="inherit" /> : <AutoAwesomeIcon />
              }
              onClick={() => void handleGenerateCharts()}
              disabled={aiBusy || aiPrompt.trim().length === 0}
              sx={{ minHeight: 48 }}
            >
              {aiBusy
                ? 'Designing charts…'
                : aiCharts.length > 0
                  ? 'Regenerate charts'
                  : 'Generate charts'}
            </Button>
          </Stack>

          {aiError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {aiError}
            </Alert>
          )}

          {aiPreviews.length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Suggested charts — untick any you do not want
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
                }}
              >
                {aiPreviews.map(({ spec, index, chart }) => {
                  const picked = aiPicked.includes(index)
                  const config = aiChartToVisual(spec)
                  return (
                    <Paper
                      key={index}
                      variant="outlined"
                      sx={{
                        p: 1,
                        minWidth: 0,
                        borderColor: picked ? 'primary.main' : 'divider',
                        borderWidth: picked ? 2 : 1,
                      }}
                    >
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                        <Checkbox
                          checked={picked}
                          onChange={() => togglePick(index)}
                          slotProps={{ input: { 'aria-label': `Include ${visualTitle(config)}` } }}
                        />
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 600 }}>
                            {visualTitle(config)}
                          </Typography>
                          {spec.subtitle && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                              sx={{ display: 'block' }}
                            >
                              {spec.subtitle}
                            </Typography>
                          )}
                        </Box>
                      </Stack>
                      <Box sx={{ position: 'relative', height: 220, mt: 0.5 }}>
                        {spec.chartType === 'kpi' ? (
                          chart.kpiCards.length > 0 ? (
                            <KpiCards cards={chart.kpiCards} />
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              No numeric columns for KPI cards.
                            </Typography>
                          )
                        ) : (
                          <>
                            <EChart option={chart.option} />
                            {!chart.hasData && (
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
                                <Typography variant="caption" color="text.secondary">
                                  No data for this chart — try rephrasing your description.
                                </Typography>
                              </Box>
                            )}
                          </>
                        )}
                      </Box>
                    </Paper>
                  )
                })}
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button onClick={() => setAiOpen(false)} sx={{ minHeight: 44, minWidth: 48 }}>
            Close
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip
            title={
              joinSelected
                ? 'Pinning works from the plain table — switch "Chart data" back to this table first.'
                : ''
            }
          >
            <span>
              <Button
                variant="contained"
                onClick={handlePinCharts}
                disabled={joinSelected || aiPicked.length === 0}
                sx={{ minHeight: 44 }}
              >
                {editingVisualId
                  ? 'Update visual'
                  : aiPicked.length > 0
                    ? `Add ${aiPicked.length} to dashboard`
                    : 'Add to dashboard'}
              </Button>
            </span>
          </Tooltip>
        </DialogActions>
      </Dialog>

      {/* ---- Rename dialog ---- */}
      <Dialog open={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Rename snapshot</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Name"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)} disabled={renameBusy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleRename()}
            disabled={renameBusy || renameValue.trim().length === 0}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- Delete confirmation ---- */}
      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete snapshot</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete “{deleteTarget?.name}” and its {formatCount(deleteTarget?.row_count ?? 0)} stored rows?
            This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={() => void handleDelete()} disabled={deleteBusy}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- Update-from-grid confirmation ---- */}
      <Dialog open={Boolean(updateTarget)} onClose={() => setUpdateTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Update snapshot from grid</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {`Replace the ${formatCount(updateTarget?.row_count ?? 0)} stored rows in “${updateTarget?.name}” with the current grid data (${formatCount(workspace.rows.length)} rows · ${formatCount(workspace.columns.length)} columns)? The snapshot's charts and dashboard are kept.`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUpdateTarget(null)} disabled={updateBusy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleUpdate()}
            disabled={updateBusy || !canUpdateFromGrid}
            startIcon={updateBusy ? <CircularProgress size={18} color="inherit" /> : <SyncIcon />}
          >
            Update
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={5000}
        onClose={() => setNotice('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={notice.startsWith('Failed') ? 'error' : 'success'}
          variant="filled"
          onClose={() => setNotice('')}
        >
          {notice}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default memo(BiPage)
