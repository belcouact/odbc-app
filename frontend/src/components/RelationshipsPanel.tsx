/**
 * Relationships between warehouse snapshots (BI page).
 *
 * A relationship links two stored snapshots on one column pair, so a row in
 * one table can be drilled down to its rows in another. The panel manages the
 * saved links (create / edit / delete) and an explore dialog with two views:
 * a master-detail drill and a flat join preview.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import AddIcon from '@mui/icons-material/Add'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import SchemaIcon from '@mui/icons-material/Schema'
import SearchIcon from '@mui/icons-material/Search'
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
import LinkIcon from '@mui/icons-material/Link'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
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
import RelationshipsDiagram from './RelationshipsDiagram'
import { api } from '../api/client'
import type {
  RelationshipJoinPreview,
  SnapshotDetail,
  SnapshotMeta,
  SnapshotRelationship,
} from '../api/client'

/** Rows shown in the drill's master table / related sections. */
const DRILL_ROW_LIMIT = 100
/** Rows fetched for the flat join preview. */
const JOIN_ROW_LIMIT = 500

/** Columns rendered in drill tables (wide snapshots stay readable). */
const DRILL_COLUMN_LIMIT = 6

interface RelationshipsPanelProps {
  /** Warehouse snapshots — the tables a relationship can link. */
  snapshots: SnapshotMeta[]
  onNotice: (message: string) => void
  /** Fired after a relationship is created, updated or deleted. */
  onChanged?: () => void
}

/** Compact read-only preview table used inside the explore dialog. */
function MiniTable({
  columns,
  rows,
  highlightColumn,
  onRowClick,
  emptyText,
  maxHeight = 320,
}: {
  columns: string[]
  rows: Record<string, unknown>[]
  highlightColumn?: string
  onRowClick?: (row: Record<string, unknown>) => void
  emptyText: string
  maxHeight?: number
}) {
  const shown = columns.slice(0, DRILL_COLUMN_LIMIT)
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
        {emptyText}
      </Typography>
    )
  }
  return (
    <TableContainer sx={{ maxHeight, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            {shown.map((name) => (
              <TableCell key={name} sx={{ whiteSpace: 'nowrap' }}>
                {name}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow
              key={index}
              hover
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              sx={{ cursor: onRowClick ? 'pointer' : undefined }}
            >
              {shown.map((name) => {
                const value = row[name]
                return (
                  <TableCell
                    key={name}
                    sx={{
                      whiteSpace: 'nowrap',
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      ...(highlightColumn === name
                        ? { bgcolor: 'action.selected', fontWeight: 600 }
                        : {}),
                    }}
                  >
                    {value === null || value === undefined ? '' : String(value)}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

interface ExploreDialogProps {
  relationship: SnapshotRelationship
  /** All relationships — the drill follows every link that leaves the base table. */
  relationships: SnapshotRelationship[]
  onClose: () => void
}

/** Two-view explorer: master-detail drill + flat join preview. */
function ExploreDialog({ relationship, relationships, onClose }: ExploreDialogProps) {
  const compact = useMediaQuery((theme) => theme.breakpoints.down('sm'))
  const [view, setView] = useState<'drill' | 'join'>('drill')

  // Row payloads of the involved snapshots, fetched once and cached.
  const detailsRef = useRef<Map<string, Awaited<ReturnType<typeof api.getSnapshot>>>>(new Map())
  const [base, setBase] = useState<SnapshotDetail | null>(null)
  const [baseLoading, setBaseLoading] = useState(false)
  const [baseError, setBaseError] = useState('')
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null)
  const [relatedLoading, setRelatedLoading] = useState(false)

  const [preview, setPreview] = useState<RelationshipJoinPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  const baseId = relationship.left_snapshot_id

  const fetchDetail = useCallback(async (id: string) => {
    const cached = detailsRef.current.get(id)
    if (cached) return cached
    const detail = await api.getSnapshot(id)
    detailsRef.current.set(id, detail)
    return detail
  }, [])

  // Load the base table's rows when the dialog opens.
  useEffect(() => {
    let cancelled = false
    setView('drill')
    setSelectedRow(null)
    setBase(null)
    setBaseError('')
    setPreview(null)
    setPreviewError('')
    setBaseLoading(true)
    fetchDetail(baseId)
      .then((detail) => {
        if (!cancelled) setBase(detail)
      })
      .catch((err: unknown) => {
        if (!cancelled) setBaseError(err instanceof Error ? err.message : 'Failed to load the table')
      })
      .finally(() => {
        if (!cancelled) setBaseLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [baseId, fetchDetail])

  // Flat join preview loads lazily, only when the user opens that view.
  useEffect(() => {
    if (view !== 'join' || preview || previewLoading) return
    let cancelled = false
    setPreviewLoading(true)
    api
      .previewRelationship(relationship.id, JOIN_ROW_LIMIT)
      .then((data) => {
        if (!cancelled) setPreview(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : 'Failed to build the join')
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, preview, previewLoading, relationship.id])

  /** Every relationship that starts at the base table (drill targets). */
  const outgoing = relationships.filter((item) => item.left_snapshot_id === baseId)

  /** Related rows per relationship for the selected base row. */
  const [relatedRows, setRelatedRows] = useState<
    { relationship: SnapshotRelationship; rows: Record<string, unknown>[]; columns: string[] }[]
  >([])

  useEffect(() => {
    if (!selectedRow) {
      setRelatedRows([])
      return
    }
    let cancelled = false
    setRelatedLoading(true)
    void (async () => {
      const sections: typeof relatedRows = []
      for (const item of outgoing) {
        try {
          const detail = await fetchDetail(item.right_snapshot_id)
          const key = selectedRow[item.left_column]
          const matched =
            key === null || key === undefined
              ? []
              : detail.rows.filter((row) => String(row[item.right_column]) === String(key))
          const columns =
            detail.columns.map((column) => column.name).length > 0
              ? detail.columns.map((column) => column.name)
              : Object.keys(detail.rows[0] ?? {})
          sections.push({ relationship: item, rows: matched, columns })
        } catch {
          // A section that fails to load just stays empty; the rest keep working.
        }
      }
      if (!cancelled) setRelatedRows(sections)
      if (!cancelled) setRelatedLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow, baseId, fetchDetail])

  const baseColumns = base
    ? base.columns.length > 0
      ? base.columns.map((column) => column.name)
      : Object.keys(base.rows[0] ?? {})
    : []

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg" fullScreen={compact}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 7 }}>
        <SearchIcon fontSize="small" />
        Explore — {relationship.left_name}
        <IconButton
          aria-label="Close explore"
          onClick={onClose}
          sx={{ position: 'absolute', top: 8, right: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Tabs
          value={view}
          onChange={(_event, value: 'drill' | 'join') => setView(value)}
          sx={{ borderBottom: 1, borderColor: 'divider', mb: 1.5 }}
        >
          <Tab value="drill" label="Drill down" />
          <Tab value="join" label="Joined view" />
        </Tabs>

        {view === 'drill' ? (
          <Stack spacing={1.5}>
            {baseLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress />
              </Box>
            )}
            {baseError && <Alert severity="error">{baseError}</Alert>}
            {base && (
              <>
                <Typography variant="caption" color="text.secondary">
                  Click a row to see its related rows in the linked tables
                  {base.rows.length > DRILL_ROW_LIMIT
                    ? ` — showing the first ${DRILL_ROW_LIMIT.toLocaleString()} of ${base.row_count.toLocaleString()} rows`
                    : ''}
                  .
                </Typography>
                <MiniTable
                  columns={baseColumns}
                  rows={base.rows.slice(0, DRILL_ROW_LIMIT)}
                  highlightColumn={relationship.left_column}
                  onRowClick={(row) => setSelectedRow(row)}
                  emptyText="This table has no stored rows."
                />
                {selectedRow && (
                  <Stack spacing={1.5} sx={{ pt: 1 }}>
                    <Typography variant="subtitle2">
                      Related rows for{' '}
                      <Box component="span" sx={{ fontFamily: 'monospace' }}>
                        {relationship.left_column}
                      </Box>{' '}
                      ={' '}
                      <Box component="span" sx={{ fontFamily: 'monospace' }}>
                        {String(selectedRow[relationship.left_column] ?? '')}
                      </Box>
                    </Typography>
                    {outgoing.length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        No relationships start at this table.
                      </Typography>
                    )}
                    {relatedLoading && (
                      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                        <CircularProgress size={24} />
                      </Box>
                    )}
                    {relatedRows.map((section) => (
                      <Box key={section.relationship.id}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}>
                          <LinkIcon fontSize="small" color="primary" />
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {section.relationship.right_name}
                          </Typography>
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`${section.relationship.left_column} = ${section.relationship.right_column}`}
                          />
                          <Chip size="small" label={`${section.rows.length} row(s)`} />
                        </Stack>
                        <MiniTable
                          columns={section.columns}
                          rows={section.rows.slice(0, DRILL_ROW_LIMIT)}
                          highlightColumn={section.relationship.right_column}
                          emptyText="No matching rows in this table."
                          maxHeight={240}
                        />
                      </Box>
                    ))}
                  </Stack>
                )}
              </>
            )}
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            {previewLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress />
              </Box>
            )}
            {previewError && <Alert severity="error">{previewError}</Alert>}
            {preview && (
              <>
                <Typography variant="caption" color="text.secondary">
                  {relationship.left_name} {relationship.join_type} join {relationship.right_name} on{' '}
                  {relationship.left_column} = {relationship.right_column} — {preview.total.toLocaleString()} rows
                  {preview.truncated ? ` (first ${JOIN_ROW_LIMIT.toLocaleString()} shown)` : ''} ·{' '}
                  {preview.matched_left.toLocaleString()} of {preview.left_row_count.toLocaleString()} left rows
                  matched.
                </Typography>
                <MiniTable
                  columns={preview.columns}
                  rows={preview.rows}
                  emptyText="The join produced no rows."
                  maxHeight={520}
                />
              </>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

/** Blank relationship form values (also the edit payload shape). */
interface RelationshipForm {
  name: string
  left_snapshot_id: string
  left_column: string
  join_type: string
  right_snapshot_id: string
  right_column: string
}

const EMPTY_FORM: RelationshipForm = {
  name: '',
  left_snapshot_id: '',
  left_column: '',
  join_type: 'left',
  right_snapshot_id: '',
  right_column: '',
}

export default function RelationshipsPanel({
  snapshots,
  onNotice,
  onChanged,
}: RelationshipsPanelProps) {
  const compact = useMediaQuery('(max-width:700px)')
  const editorFullScreen = useMediaQuery((theme) => theme.breakpoints.down('sm'))

  const [relationships, setRelationships] = useState<SnapshotRelationship[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // ---- Editor (create / edit) ----
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RelationshipForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<SnapshotRelationship | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [exploreTarget, setExploreTarget] = useState<SnapshotRelationship | null>(null)
  /** Full-warehouse diagram (tables as nodes, relationships as lines). */
  const [diagramOpen, setDiagramOpen] = useState(false)

  // Initial load — promise callbacks keep state updates off the effect's
  // synchronous path (lint: react/set-state-in-effect).
  useEffect(() => {
    let cancelled = false
    api
      .listRelationships()
      .then((list) => {
        if (!cancelled) {
          setRelationships(list)
          setError('')
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load relationships')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setEditorOpen(true)
  }, [])

  const openEdit = useCallback((relationship: SnapshotRelationship) => {
    setEditingId(relationship.id)
    setForm({
      name: relationship.name,
      left_snapshot_id: relationship.left_snapshot_id,
      left_column: relationship.left_column,
      join_type: relationship.join_type,
      right_snapshot_id: relationship.right_snapshot_id,
      right_column: relationship.right_column,
    })
    setEditorOpen(true)
  }, [])

  const formValid =
    form.left_snapshot_id.length > 0 &&
    form.left_column.length > 0 &&
    form.right_snapshot_id.length > 0 &&
    form.right_column.length > 0

  const handleSave = async () => {
    if (!formValid) return
    const leftName = snapshots.find((item) => item.id === form.left_snapshot_id)?.name ?? ''
    const rightName = snapshots.find((item) => item.id === form.right_snapshot_id)?.name ?? ''
    const payload = {
      // An unnamed relationship gets a descriptive default.
      name: form.name.trim() || `${leftName} → ${rightName}`,
      left_snapshot_id: form.left_snapshot_id,
      left_column: form.left_column,
      join_type: form.join_type,
      right_snapshot_id: form.right_snapshot_id,
      right_column: form.right_column,
    }
    setSaving(true)
    try {
      const saved =
        editingId !== null
          ? await api.updateRelationship(editingId, payload)
          : await api.createRelationship(payload)
      setRelationships((prev) =>
        editingId !== null
          ? prev.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...prev],
      )
      setEditorOpen(false)
      onNotice(editingId !== null ? 'Relationship updated' : 'Relationship saved')
      onChanged?.()
    } catch (err) {
      onNotice(err instanceof Error ? err.message : 'Failed to save the relationship')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await api.deleteRelationship(deleteTarget.id)
      setRelationships((prev) => prev.filter((item) => item.id !== deleteTarget.id))
      setDeleteTarget(null)
      onNotice('Relationship deleted')
      onChanged?.()
    } catch (err) {
      onNotice(err instanceof Error ? err.message : 'Failed to delete the relationship')
    } finally {
      setDeleteBusy(false)
    }
  }

  /** Column options for the editor's selects. */
  const columnsOf = (id: string): string[] =>
    snapshots.find((item) => item.id === id)?.columns.map((column) => column.name) ?? []

  const actionSx = { minWidth: 48, minHeight: 48 } as const

  return (
    <Box>
      {/* Toolbar (the tab label carries the section title) */}
      <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {relationships.length > 0 && (
          <Tooltip title="See all relationships in one diagram">
            <Button
              size="small"
              variant="outlined"
              startIcon={<SchemaIcon />}
              onClick={() => setDiagramOpen(true)}
              sx={{ minHeight: 40, mr: 1 }}
            >
              Diagram
            </Button>
          </Tooltip>
        )}
        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={openCreate} sx={{ minHeight: 40 }}>
          New relationship
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Link warehouse tables on a shared column, then drill from a row in one table to its rows in
        another.
      </Typography>

      {error && <Alert severity="error">{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      ) : relationships.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          No relationships yet — link two snapshots on a shared column (e.g. NAME = NAME).
        </Typography>
      ) : (
        <Stack spacing={1}>
          {relationships.map((relationship) => (
            <Paper key={relationship.id} variant="outlined" sx={{ p: 1.25 }}>
              <Stack
                direction={compact ? 'column' : 'row'}
                spacing={1}
                sx={{ alignItems: compact ? 'stretch' : 'center' }}
              >
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
                    {relationship.name}
                  </Typography>
                  <Stack direction="row" spacing={0.75} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                    <Chip
                      size="small"
                      icon={<LinkIcon />}
                      label={`${relationship.left_name}.${relationship.left_column} = ${relationship.right_name}.${relationship.right_column}`}
                    />
                    <Chip size="small" variant="outlined" label={relationship.join_type} />
                  </Stack>
                </Box>
                <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                  <Tooltip title="Explore — drill into related rows or preview the join">
                    <IconButton
                      size="small"
                      aria-label={`Explore ${relationship.name}`}
                      onClick={() => setExploreTarget(relationship)}
                      sx={actionSx}
                    >
                      <SearchIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit relationship">
                    <IconButton
                      size="small"
                      aria-label={`Edit ${relationship.name}`}
                      onClick={() => openEdit(relationship)}
                      sx={actionSx}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete relationship">
                    <IconButton
                      size="small"
                      aria-label={`Delete ${relationship.name}`}
                      onClick={() => setDeleteTarget(relationship)}
                      sx={actionSx}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      {/* ---- Create / edit dialog ---- */}
      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        fullWidth
        maxWidth="sm"
        fullScreen={editorFullScreen}
      >
        <DialogTitle sx={{ position: 'relative', pr: 7 }}>
          {editingId !== null ? 'Edit relationship' : 'New relationship'}
          <IconButton
            aria-label="Close relationship editor"
            onClick={() => setEditorOpen(false)}
            disabled={saving}
            sx={{ position: 'absolute', top: 8, right: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField
              label="Name (optional)"
              size="small"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="e.g. Colour readings to LIMS"
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                select
                fullWidth
                required
                size="small"
                label="Left table"
                value={form.left_snapshot_id}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    left_snapshot_id: event.target.value,
                    left_column: '',
                  }))
                }
              >
                {snapshots.map((snapshot) => (
                  <MenuItem key={snapshot.id} value={snapshot.id}>
                    {snapshot.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                fullWidth
                required
                size="small"
                label="Left column"
                value={form.left_column}
                onChange={(event) => setForm((prev) => ({ ...prev, left_column: event.target.value }))}
                disabled={form.left_snapshot_id.length === 0}
              >
                {columnsOf(form.left_snapshot_id).map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                select
                fullWidth
                required
                size="small"
                label="Right table"
                value={form.right_snapshot_id}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    right_snapshot_id: event.target.value,
                    right_column: '',
                  }))
                }
              >
                {snapshots.map((snapshot) => (
                  <MenuItem key={snapshot.id} value={snapshot.id}>
                    {snapshot.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                fullWidth
                required
                size="small"
                label="Right column"
                value={form.right_column}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, right_column: event.target.value }))
                }
                disabled={form.right_snapshot_id.length === 0}
              >
                {columnsOf(form.right_snapshot_id).map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <TextField
              select
              size="small"
              label="Join type"
              value={form.join_type}
              onChange={(event) => setForm((prev) => ({ ...prev, join_type: event.target.value }))}
              helperText="Left keeps unmatched rows of the left table; inner keeps only matches."
            >
              <MenuItem value="left">Left join</MenuItem>
              <MenuItem value="inner">Inner join</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditorOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void handleSave()} disabled={saving || !formValid}>
            {editingId !== null ? 'Save changes' : 'Save relationship'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- Delete confirmation ---- */}
      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete relationship</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete “{deleteTarget?.name}”? The snapshots themselves are not touched.
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

      {/* ---- Explore dialog ---- */}
      {exploreTarget && (
        <ExploreDialog
          relationship={exploreTarget}
          relationships={relationships}
          onClose={() => setExploreTarget(null)}
        />
      )}

      {/* ---- Relationship diagram ---- */}
      <Dialog
        open={diagramOpen}
        onClose={() => setDiagramOpen(false)}
        fullWidth
        maxWidth="md"
        fullScreen={editorFullScreen}
      >
        <DialogTitle sx={{ position: 'relative', pr: 7 }}>
          Relationship diagram
          <IconButton
            aria-label="Close relationship diagram"
            onClick={() => setDiagramOpen(false)}
            sx={{ position: 'absolute', top: 8, right: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Every saved relationship as a line between its tables — hover a line for details, scroll
            to zoom.
          </Typography>
          <RelationshipsDiagram
            relationships={relationships}
            height={editorFullScreen ? 340 : 440}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiagramOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
