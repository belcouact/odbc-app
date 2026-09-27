/**
 * BI page — store the current Query result grid in a local SQLite warehouse,
 * then reopen stored snapshots to chart or inspect the rows.
 *
 * The warehouse is a per-machine file under %APPDATA%\ODBCQueryApp\data\
 * (see backend/app/warehouse.py). Read-only reference data such as the bundled
 * Pantone TCX table lives separately in the app's app/data/ folder.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useState, memo } from 'react'
import type { Ref } from 'react'
import BarChartIcon from '@mui/icons-material/BarChart'
import BookmarksIcon from '@mui/icons-material/Bookmarks'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import RefreshIcon from '@mui/icons-material/Refresh'
import SaveIcon from '@mui/icons-material/Save'
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard'
import SyncIcon from '@mui/icons-material/Sync'
import TableChartIcon from '@mui/icons-material/TableChart'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
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
import type { SnapshotDetail, SnapshotMeta, WarehouseInfo } from '../api/client'
import ChartsPanel from '../components/ChartsPanel'
import type { ChartPreset } from '../components/ChartsPanel'
import DashboardPanel from '../components/DashboardPanel'
import { subscribe } from '../editorBus'
import type { QueryResult, QuerySource, AiMode } from '../types'
import type { EChartsOption } from 'echarts'
import {
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
  /** Open the AI sidebar (used by the chart builder's AI chart button). */
  onOpenAi?: (mode: AiMode) => void
}

/** Rows rendered in the snapshot data preview before the list is truncated. */
const PREVIEW_ROW_LIMIT = 200

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

/** Default snapshot name — a timestamp is enough to tell runs apart. */
function defaultSnapshotName(): string {
  const stamp = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
  return `Grid result — ${stamp}`
}

/** Column names for a snapshot, falling back to the first row's keys. */
function columnNames(detail: SnapshotDetail): string[] {
  if (detail.columns.length > 0) return detail.columns.map((column) => column.name)
  return Object.keys(detail.rows[0] ?? {})
}

function BiPage({ ref, onOpenAi }: BiPageProps = {}) {
  const isCompact = useMediaQuery('(max-width:700px)')

  const [warehouse, setWarehouse] = useState<WarehouseInfo | null>(null)
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')

  // The grid the Query tab currently holds — what "Save" would capture.
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => getWorkspaceSnapshot())
  const [draftName, setDraftName] = useState(() => defaultSnapshotName())
  const [saving, setSaving] = useState(false)

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
  const [chartPreset, setChartPreset] = useState<ChartPreset | null>(null)

  // AI-generated chart option handed over by the AI sidebar (targeted at BI).
  const [aiOption, setAiOption] = useState<{ option: EChartsOption; nonce: number } | null>(null)

  const [renameTarget, setRenameTarget] = useState<SnapshotMeta | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<SnapshotMeta | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [updateTarget, setUpdateTarget] = useState<SnapshotMeta | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  const [notice, setNotice] = useState('')

  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const [info, list] = await Promise.all([api.getWarehouseInfo(), api.listSnapshots()])
      setWarehouse(info)
      setSnapshots(list)
      setListError('')
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load the warehouse')
    } finally {
      setListLoading(false)
    }
  }, [])

  const refresh = useCallback(() => {
    setWorkspace(getWorkspaceSnapshot())
    setDraftName((current) => current || defaultSnapshotName())
    void loadList()
  }, [loadList])

  useEffect(() => {
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

  // ---- Save the current grid ----
  const canSave = workspace.rows.length > 0 && draftName.trim().length > 0 && !saving

  const openSnapshot = useCallback(async (id: string) => {
    setSelectedId(id)
    setDetail(null)
    setVisuals([])
    setEditingVisualId(null)
    setChartPreset(null)
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

  const handleSave = useCallback(async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const created = await api.createSnapshot({
        name: draftName.trim(),
        source: 'grid',
        connection_id: workspace.connectionId || null,
        sql_text: workspace.sqlText || null,
        columns: workspace.columns.map((name) => ({ name, type: '' })),
        rows: workspace.rows,
      })
      setNotice(`Saved "${created.name}" (${formatCount(created.row_count)} rows)`)
      setDraftName('')
      await loadList()
      void openSnapshot(created.id)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to save the snapshot')
    } finally {
      setSaving(false)
    }
  }, [canSave, draftName, workspace, loadList, openSnapshot])

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
        columns: workspace.columns.map((name) => ({ name, type: '' })),
        rows: workspace.rows,
      })
      setSnapshots((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      if (selectedId === updated.id) {
        setDetail(await api.getSnapshot(updated.id))
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
        setChartPreset(null)
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
    return {
      rows: detail.rows,
      columns: columnNames(detail).map((name) => ({ name, type: '' })),
      row_count: detail.rows.length,
      elapsed_ms: 0,
      sql: detail.sql_text ?? '',
    }
  }, [detail])

  const chartSource: QuerySource = { kind: 'upload' }

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

  /** Pin the chart builder's current configuration (or update the tile being edited). */
  const handleAddVisual = useCallback(
    (config: VisualConfig) => {
      if (editingVisualId) {
        const next = visuals.map((visual) =>
          visual.id === editingVisualId
            ? { ...visual, title: visualTitle(config), config }
            : visual,
        )
        void persistVisuals(next, 'Visual updated')
      } else {
        const visual: DashboardVisual = {
          id: newVisualId(),
          title: visualTitle(config),
          size: 'medium',
          config,
        }
        void persistVisuals([...visuals, visual], 'Visual added to the dashboard')
      }
      setEditingVisualId(null)
      setChartPreset(null)
      setTab('dashboard')
    },
    [editingVisualId, visuals, persistVisuals],
  )

  /** Reopen a tile's config in the chart builder. */
  const handleEditVisual = useCallback(
    (id: string) => {
      const visual = visuals.find((item) => item.id === id)
      if (!visual) return
      setEditingVisualId(id)
      setChartPreset({ ...visual.config, nonce: Date.now() })
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
        setChartPreset(null)
      }
      void persistVisuals(
        visuals.filter((visual) => visual.id !== id),
        'Visual removed from the dashboard',
      )
    },
    [visuals, editingVisualId, persistVisuals],
  )

  /** Start a fresh chart from the dashboard's empty state. */
  const handleBuildChart = useCallback(() => {
    setEditingVisualId(null)
    setChartPreset(null)
    setTab('chart')
  }, [])

  const previewColumns = detail ? columnNames(detail) : []
  const previewRows = detail ? detail.rows.slice(0, PREVIEW_ROW_LIMIT) : []

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Stack spacing={{ xs: 2, md: 2.5 }}>
        {/* ---- Header ---- */}
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            BI
          </Typography>
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

        {/* ---- Save the current result grid ---- */}
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ alignItems: { xs: 'stretch', sm: 'flex-end' } }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Current result grid
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {workspace.rows.length > 0
                  ? `${formatCount(workspace.rows.length)} rows · ${formatCount(workspace.columns.length)} columns`
                  : 'No grid data — run a query or upload a file in the Query tab first.'}
              </Typography>
            </Box>
            <TextField
              label="Snapshot name"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              disabled={workspace.rows.length === 0 || saving}
              size="small"
              fullWidth={isCompact}
              sx={{ flexGrow: 1, minWidth: { sm: 240 } }}
            />
            <Button
              variant="contained"
              startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
              onClick={() => void handleSave()}
              disabled={!canSave}
              sx={{ flexShrink: 0 }}
            >
              Save to warehouse
            </Button>
          </Stack>
        </Paper>

        {/* ---- Stored snapshots ---- */}
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
            <BookmarksIcon fontSize="small" color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
              Snapshots
            </Typography>
            <Tooltip title="Reload the snapshot list">
              <span>
                <IconButton onClick={() => void loadList()} disabled={listLoading} aria-label="Reload snapshots">
                  {listLoading ? <CircularProgress size={20} /> : <RefreshIcon />}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          {snapshots.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              {listLoading ? 'Loading…' : 'Nothing stored yet — save a result grid above.'}
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
                  preset={chartPreset}
                  aiOption={aiOption}
                  onClearAi={() => setAiOption(null)}
                  onAiChart={() => onOpenAi?.('chart')}
                  onAddToDashboard={handleAddVisual}
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
        message={notice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}

export default memo(BiPage)
