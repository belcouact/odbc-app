/**
 * BI page — store the current Query result grid in a local SQLite warehouse,
 * then reopen stored snapshots to chart or inspect the rows.
 *
 * The warehouse is a per-machine file under %APPDATA%\ODBCQueryApp\data\
 * (see backend/app/warehouse.py). Read-only reference data such as the bundled
 * Pantone TCX table lives separately in the app's app/data/ folder.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, memo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
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

type Notice = { message: string; severity: 'success' | 'error' }

function BiPage({ ref, onLoadToGrid }: BiPageProps = {}) {
  const { t } = useTranslation('bi')
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

  const [notice, setNotice] = useState<Notice | null>(null)

  const loadList = useCallback(async () => {
    // Event-driven refresh (button, tab activation): setstate is fine here.
    try {
      const [info, list] = await fetchList()
      setWarehouse(info)
      setSnapshots(list)
      setListError('')
    } catch (err) {
      setListError(err instanceof Error ? err.message : t('messages.loadWarehouseFailed'))
    } finally {
      setListLoading(false)
    }
  }, [t])

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
          setListError(err instanceof Error ? err.message : t('messages.loadWarehouseFailed'))
        }
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [t])

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
      setNotice({
        message: err instanceof Error ? err.message : t('messages.openSnapshotFailed'),
        severity: 'error',
      })
      setSelectedId(null)
    } finally {
      setDetailLoading(false)
      setDashboardLoading(false)
    }
  }, [t])

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
      setNotice({
        message: t('messages.updateSuccess', {
          name: updated.name,
          rows: formatCount(updated.row_count),
        }),
        severity: 'success',
      })
      await loadList()
    } catch (err) {
      setNotice({
        message: err instanceof Error ? err.message : t('messages.updateFailed'),
        severity: 'error',
      })
    } finally {
      setUpdateBusy(false)
    }
  }, [updateTarget, canUpdateFromGrid, workspace, selectedId, loadList, t])

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
        setNotice({
          message: t('messages.loadSuccess', { name: detail.name }),
          severity: 'success',
        })
      } catch (err) {
        setNotice({
          message: err instanceof Error ? err.message : t('messages.loadFailed'),
          severity: 'error',
        })
      } finally {
        setLoadBusyId(null)
      }
    },
    [onLoadToGrid, loadBusyId, t],
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
      setNotice({
        message: t('messages.renameSuccess', { name: updated.name }),
        severity: 'success',
      })
    } catch (err) {
      setNotice({
        message: err instanceof Error ? err.message : t('messages.renameFailed'),
        severity: 'error',
      })
    } finally {
      setRenameBusy(false)
    }
  }, [renameTarget, renameValue, t])

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
      setNotice({ message: t('messages.deleteSuccess'), severity: 'success' })
      await loadList()
    } catch (err) {
      setNotice({
        message: err instanceof Error ? err.message : t('messages.deleteFailed'),
        severity: 'error',
      })
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteTarget, selectedId, loadList, t])

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
            message: err instanceof Error ? err.message : t('messages.joinFailed'),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [chartJoinId, t])

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
        setNotice({ message, severity: 'success' })
      } catch (err) {
        setVisuals(previous)
        setNotice({
          message: err instanceof Error ? err.message : t('messages.saveDashboardFailed'),
          severity: 'error',
        })
      } finally {
        setDashboardSaving(false)
      }
    },
    [selectedId, visuals, t],
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
      setAiError(err instanceof Error ? err.message : t('messages.aiFailed'))
    } finally {
      setAiBusy(false)
    }
  }, [aiPrompt, aiBusy, activeColumns, activeRows, t])

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
      void persistVisuals(next, t('messages.visualUpdated'))
    } else {
      const added: DashboardVisual[] = configs.map((config) => ({
        id: newVisualId(),
        title: visualTitle(config),
        size: 'medium',
        config,
      }))
      void persistVisuals(
        [...visuals, ...added],
        t('messages.addedVisuals', { count: added.length }),
      )
    }
    setEditingVisualId(null)
    setEditingPreset(null)
    setAiOpen(false)
    setAiCharts([])
    setAiPicked([])
    setTab('dashboard')
  }, [aiPicked, aiCharts, editingVisualId, visuals, persistVisuals, t])

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
          t('messages.visualUpdated'),
        )
      } else {
        void persistVisuals(
          [...visuals, { id: newVisualId(), title: visualTitle(config), size: 'medium', config }],
          t('messages.addedVisuals', { count: 1 }),
        )
      }
      setEditingVisualId(null)
      setEditingPreset(null)
      setTab('dashboard')
    },
    [editingVisualId, visuals, persistVisuals, t],
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
        title: `${visual.title}${t('messages.copySuffix')}`,
      }
      const index = visuals.findIndex((item) => item.id === id)
      const next = [...visuals]
      next.splice(index + 1, 0, copy)
      void persistVisuals(next, t('messages.visualDuplicated'))
    },
    [visuals, persistVisuals, t],
  )

  const handleMoveVisual = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = visuals.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= visuals.length) return
      const next = [...visuals]
      ;[next[index], next[target]] = [next[target], next[index]]
      void persistVisuals(next, t('messages.visualMoved'))
    },
    [visuals, persistVisuals, t],
  )

  const handleResizeVisual = useCallback(
    (id: string, size: VisualSize) => {
      void persistVisuals(
        visuals.map((visual) => (visual.id === id ? { ...visual, size } : visual)),
        t('messages.tileResized'),
      )
    },
    [visuals, persistVisuals, t],
  )

  const handleRemoveVisual = useCallback(
    (id: string) => {
      if (editingVisualId === id) {
        setEditingVisualId(null)
      }
      void persistVisuals(
        visuals.filter((visual) => visual.id !== id),
        t('messages.visualRemoved'),
      )
    },
    [visuals, editingVisualId, persistVisuals, t],
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
            <Typography variant="h5">{t('title')}</Typography>
            <Tooltip title={t('help.tooltip')}>
              <IconButton
                aria-label={t('help.aria')}
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
            {t('subtitle')}
          </Typography>
          {warehouse && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mt: 0.5, wordBreak: 'break-all' }}
            >
              {t('warehouse.summary', {
                snapshots: formatCount(warehouse.snapshot_count),
                rows: formatCount(warehouse.row_count),
                size: formatBytes(warehouse.size_bytes),
                path: warehouse.path,
              })}
            </Typography>
          )}
        </Box>

        {listError && <Alert severity="error">{listError}</Alert>}

        {/* ---- Warehouse: snapshots + relationships (tabbed, collapsible) ---- */}
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <BookmarksIcon fontSize="small" color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
              {t('warehouse.title')}
            </Typography>
            <Tooltip title={t('warehouse.reloadTooltip')}>
              <span>
                <IconButton onClick={() => void loadList()} disabled={listLoading} aria-label={t('warehouse.reloadAria')}>
                  {listLoading ? <CircularProgress size={20} /> : <RefreshIcon />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={warehouseExpanded ? t('warehouse.collapse') : t('warehouse.expand')}>
              <IconButton
                aria-expanded={warehouseExpanded}
                aria-label={warehouseExpanded ? t('warehouse.collapseAria') : t('warehouse.expandAria')}
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
                <Tab value="snapshots" label={t('tabs.snapshots', { n: snapshots.length })} />
                <Tab value="relationships" label={t('tabs.relationships', { n: relationships.length })} />
              </Tabs>

              {warehouseTab === 'snapshots' &&
                (snapshots.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    {listLoading ? t('warehouse.loading') : t('warehouse.empty')}
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
                        <Chip label={t('warehouse.rowsChip', { n: formatCount(snapshot.row_count) })} size="small" variant="outlined" />
                        <Chip label={t('warehouse.columnsChip', { n: formatCount(snapshot.columns.length) })} size="small" variant="outlined" />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {formatWhen(snapshot.created_at)}
                      </Typography>
                    </Box>
                    <Tooltip
                      title={
                        onLoadToGrid
                          ? t('warehouse.loadTooltip')
                          : t('warehouse.loadTooltipDisabled')
                      }
                    >
                      <span>
                        <IconButton
                          size="small"
                          aria-label={t('warehouse.loadAria', { name: snapshot.name })}
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
                          ? t('warehouse.updateTooltip')
                          : t('warehouse.updateTooltipDisabled')
                      }
                    >
                      <span>
                        <IconButton
                          size="small"
                          aria-label={t('warehouse.updateAria', { name: snapshot.name })}
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
                      aria-label={t('warehouse.renameAria')}
                      onClick={(event) => { event.stopPropagation(); openRename(snapshot) }}
                      sx={{ minWidth: 48, minHeight: 48 }}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      aria-label={t('warehouse.deleteAria')}
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
                    <TableCell>{t('table.name')}</TableCell>
                    <TableCell>{t('table.source')}</TableCell>
                    <TableCell align="right">{t('table.rows')}</TableCell>
                    <TableCell align="right">{t('table.columns')}</TableCell>
                    <TableCell>{t('table.created')}</TableCell>
                    <TableCell align="right">{t('table.actions')}</TableCell>
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
                              ? t('warehouse.loadTooltip')
                              : t('warehouse.loadTooltipDisabled')
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              aria-label={t('warehouse.loadAria', { name: snapshot.name })}
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
                              ? t('warehouse.updateTooltip')
                              : t('warehouse.updateTooltipDisabled')
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              aria-label={t('warehouse.updateAria', { name: snapshot.name })}
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
                        <IconButton size="small" aria-label={t('warehouse.renameAria')} onClick={(event) => { event.stopPropagation(); openRename(snapshot) }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" aria-label={t('warehouse.deleteAria')} onClick={(event) => { event.stopPropagation(); setDeleteTarget(snapshot) }}>
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
                  onNotice={(message) =>
                    setNotice({
                      message,
                      severity: message.startsWith('Failed') ? 'error' : 'success',
                    })
                  }
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
              {t('detail.meta', {
                rows: formatCount(detail.row_count),
                columns: formatCount(columnNames(detail).length),
                when: formatWhen(detail.created_at),
              })}
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
                  label={t('tabs.dashboard', { n: visuals.length })}
                />
                <Tab
                  value="chart"
                  icon={<BarChartIcon fontSize="small" />}
                  iconPosition="start"
                  label={t('tabs.chart')}
                />
                <Tab
                  value="data"
                  icon={<TableChartIcon fontSize="small" />}
                  iconPosition="start"
                  label={t('tabs.data')}
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
                  aiLabel={editingVisualId ? t('chart.aiLabelRedesign') : t('chart.aiLabelOpen')}
                  onAddToDashboard={handlePinConfig}
                  addLabel={editingVisualId ? t('chart.addLabelUpdate') : t('chart.addLabelAdd')}
                />
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  {t('detail.noRowsToChart')}
                </Typography>
              )
            ) : previewColumns.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                {t('detail.noStoredRows')}
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
                    {t('detail.showingFirst', {
                      shown: formatCount(previewRows.length),
                      total: formatCount(detail.rows.length),
                    })}
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
          {t('help.title')}
          <IconButton
            aria-label={t('help.close')}
            onClick={() => setHelpOpen(false)}
            sx={{ ml: 'auto', minWidth: 48, minHeight: 48 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            <Trans t={t} i18nKey="help.intro" components={{ strong: <strong /> }} />
          </Typography>
          <Box component="ol" sx={{ m: 0, p: 0, pl: 2.5, '& li': { mb: 1, typography: 'body2', pl: 0.5 } }}>
            <li>
              <Trans t={t} i18nKey="help.saveGrid" components={{ strong: <strong />, em: <em /> }} />
            </li>
            <li>
              <Trans
                t={t}
                i18nKey="help.manage"
                components={{
                  strong: <strong />,
                  inputIcon: <InputIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} />,
                  syncIcon: <SyncIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} />,
                  editIcon: <EditIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} />,
                  deleteIcon: <DeleteIcon fontSize="inherit" sx={{ verticalAlign: 'text-bottom' }} />,
                }}
              />
            </li>
            <li>
              <Trans t={t} i18nKey="help.relationships" components={{ strong: <strong />, em: <em /> }} />
            </li>
            <li>
              <Trans t={t} i18nKey="help.dashboardTab" components={{ strong: <strong /> }} />
            </li>
            <li>
              <Trans t={t} i18nKey="help.chartTab" components={{ strong: <strong /> }} />
            </li>
            <li>
              <Trans t={t} i18nKey="help.dataTab" components={{ strong: <strong /> }} />
            </li>
          </Box>
          <Divider sx={{ my: 2 }} />
          <Typography variant="body2" color="text.secondary">
            <Trans
              t={t}
              i18nKey="help.storage"
              components={{ storagePath: <Box component="code" sx={{ wordBreak: 'break-all' }} /> }}
            />
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
          {editingVisualId ? t('ai.titleRedesign') : t('ai.titleBuilder')}
          <IconButton
            aria-label={t('ai.closeAria')}
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
              label={t('ai.dataLabel')}
              value={chartJoinId}
              onChange={(event) => setChartJoinId(event.target.value)}
              helperText={joinSelected ? t('ai.helperJoined') : t('ai.helperPlain')}
              sx={{ mb: 2 }}
            >
              <MenuItem value="">
                {t('ai.thisTable', {
                  name: detail?.name ?? t('ai.currentData'),
                  n: formatCount(detail?.row_count ?? 0),
                })}
              </MenuItem>
              {chartJoins.map((rel) => (
                <MenuItem key={rel.id} value={rel.id} sx={{ display: 'block', py: 0.75 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {rel.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('ai.viaJoin', {
                      left: rel.left_column,
                      right: rel.right_column,
                      joinType: rel.join_type,
                    })}
                  </Typography>
                </MenuItem>
              ))}
            </TextField>
          )}
          {joinLoading && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="caption" color="text.secondary">
                {t('ai.buildingJoin')}
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
                {t('ai.columnsHeading', { n: formatCount(activeColumns.length) })}
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
                  {t('ai.tryExample')}
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
            label={t('ai.describeLabel')}
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
              {aiBusy ? t('ai.busy') : aiCharts.length > 0 ? t('ai.regenerate') : t('ai.generate')}
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
                {t('ai.suggested')}
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
                          slotProps={{ input: { 'aria-label': t('ai.includeAria', { title: visualTitle(config) }) } }}
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
                              {t('ai.noKpiColumns')}
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
                                  {t('ai.noChartData')}
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
            {t('ai.close')}
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title={joinSelected ? t('ai.pinTooltip') : ''}>
            <span>
              <Button
                variant="contained"
                onClick={handlePinCharts}
                disabled={joinSelected || aiPicked.length === 0}
                sx={{ minHeight: 44 }}
              >
                {editingVisualId
                  ? t('chart.addLabelUpdate')
                  : aiPicked.length > 0
                    ? t('ai.addCount', { n: aiPicked.length })
                    : t('chart.addLabelAdd')}
              </Button>
            </span>
          </Tooltip>
        </DialogActions>
      </Dialog>

      {/* ---- Rename dialog ---- */}
      <Dialog open={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('dialogs.renameTitle')}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={t('dialogs.nameLabel')}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)} disabled={renameBusy}>
            {t('dialogs.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleRename()}
            disabled={renameBusy || renameValue.trim().length === 0}
          >
            {t('dialogs.save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- Delete confirmation ---- */}
      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('dialogs.deleteTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('dialogs.deleteBody', {
              name: deleteTarget?.name ?? '',
              rows: formatCount(deleteTarget?.row_count ?? 0),
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
            {t('dialogs.cancel')}
          </Button>
          <Button color="error" variant="contained" onClick={() => void handleDelete()} disabled={deleteBusy}>
            {t('dialogs.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- Update-from-grid confirmation ---- */}
      <Dialog open={Boolean(updateTarget)} onClose={() => setUpdateTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('dialogs.updateTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('dialogs.updateBody', {
              stored: formatCount(updateTarget?.row_count ?? 0),
              name: updateTarget?.name ?? '',
              rows: formatCount(workspace.rows.length),
              columns: formatCount(workspace.columns.length),
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUpdateTarget(null)} disabled={updateBusy}>
            {t('dialogs.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleUpdate()}
            disabled={updateBusy || !canUpdateFromGrid}
            startIcon={updateBusy ? <CircularProgress size={18} color="inherit" /> : <SyncIcon />}
          >
            {t('dialogs.update')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={notice?.severity ?? 'success'}
          variant="filled"
          onClose={() => setNotice(null)}
        >
          {notice?.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default memo(BiPage)
