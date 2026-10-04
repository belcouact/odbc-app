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
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('relationships')
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
        if (!cancelled) setBaseError(err instanceof Error ? err.message : t('errors.loadTable'))
      })
      .finally(() => {
        if (!cancelled) setBaseLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [baseId, fetchDetail, t])

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
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : t('errors.buildJoin'))
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, preview, previewLoading, relationship.id, t])

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
        {t('explore.title', { name: relationship.left_name })}
        <IconButton
          aria-label={t('explore.ariaClose')}
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
          <Tab value="drill" label={t('explore.tabs.drill')} />
          <Tab value="join" label={t('explore.tabs.join')} />
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
                  {base.rows.length > DRILL_ROW_LIMIT
                    ? t('explore.drillHintTruncated', {
                        n: DRILL_ROW_LIMIT.toLocaleString(),
                        total: base.row_count.toLocaleString(),
                      })
                    : t('explore.drillHint')}
                </Typography>
                <MiniTable
                  columns={baseColumns}
                  rows={base.rows.slice(0, DRILL_ROW_LIMIT)}
                  highlightColumn={relationship.left_column}
                  onRowClick={(row) => setSelectedRow(row)}
                  emptyText={t('explore.noStoredRows')}
                />
                {selectedRow && (
                  <Stack spacing={1.5} sx={{ pt: 1 }}>
                    <Typography variant="subtitle2">
                      {t('explore.relatedRowsFor')}{' '}
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
                        {t('explore.noOutgoing')}
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
                          <Chip size="small" label={t('explore.rowCount', { count: section.rows.length })} />
                        </Stack>
                        <MiniTable
                          columns={section.columns}
                          rows={section.rows.slice(0, DRILL_ROW_LIMIT)}
                          highlightColumn={section.relationship.right_column}
                          emptyText={t('explore.noMatchingRows')}
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
                  {t('explore.joinSummary', {
                    left: relationship.left_name,
                    join: t(`joinTypes.${relationship.join_type}`),
                    right: relationship.right_name,
                    lcol: relationship.left_column,
                    rcol: relationship.right_column,
                    total: preview.total.toLocaleString(),
                    truncated: preview.truncated
                      ? t('explore.joinTruncated', { n: JOIN_ROW_LIMIT.toLocaleString() })
                      : '',
                    matched: preview.matched_left.toLocaleString(),
                    leftRows: preview.left_row_count.toLocaleString(),
                  })}
                </Typography>
                <MiniTable
                  columns={preview.columns}
                  rows={preview.rows}
                  emptyText={t('explore.joinEmpty')}
                  maxHeight={520}
                />
              </>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('actions.close')}</Button>
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
  const { t } = useTranslation('relationships')
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
        if (!cancelled) setError(err instanceof Error ? err.message : t('errors.loadList'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [t])

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
      onNotice(editingId !== null ? t('notices.updated') : t('notices.saved'))
      onChanged?.()
    } catch (err) {
      onNotice(err instanceof Error ? err.message : t('errors.save'))
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
      onNotice(t('notices.deleted'))
      onChanged?.()
    } catch (err) {
      onNotice(err instanceof Error ? err.message : t('errors.delete'))
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
          <Tooltip title={t('toolbar.diagramTooltip')}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<SchemaIcon />}
              onClick={() => setDiagramOpen(true)}
              sx={{ minHeight: 40, mr: 1 }}
            >
              {t('toolbar.diagram')}
            </Button>
          </Tooltip>
        )}
        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={openCreate} sx={{ minHeight: 40 }}>
          {t('toolbar.new')}
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {t('toolbar.intro')}
      </Typography>

      {error && <Alert severity="error">{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      ) : relationships.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          {t('list.empty')}
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
                    <Chip
                      size="small"
                      variant="outlined"
                      label={t(`joinTypeShort.${relationship.join_type}`)}
                    />
                  </Stack>
                </Box>
                <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                  <Tooltip title={t('list.exploreTooltip')}>
                    <IconButton
                      size="small"
                      aria-label={t('list.exploreAria', { name: relationship.name })}
                      onClick={() => setExploreTarget(relationship)}
                      sx={actionSx}
                    >
                      <SearchIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t('list.editTooltip')}>
                    <IconButton
                      size="small"
                      aria-label={t('list.editAria', { name: relationship.name })}
                      onClick={() => openEdit(relationship)}
                      sx={actionSx}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t('list.deleteTooltip')}>
                    <IconButton
                      size="small"
                      aria-label={t('list.deleteAria', { name: relationship.name })}
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
          {editingId !== null ? t('editor.titleEdit') : t('editor.titleNew')}
          <IconButton
            aria-label={t('editor.ariaClose')}
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
              label={t('editor.name')}
              size="small"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={t('editor.namePlaceholder')}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                select
                fullWidth
                required
                size="small"
                label={t('editor.leftTable')}
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
                label={t('editor.leftColumn')}
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
                label={t('editor.rightTable')}
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
                label={t('editor.rightColumn')}
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
              label={t('editor.joinType')}
              value={form.join_type}
              onChange={(event) => setForm((prev) => ({ ...prev, join_type: event.target.value }))}
              helperText={t('editor.joinHelper')}
            >
              <MenuItem value="left">{t('joinTypeNames.left')}</MenuItem>
              <MenuItem value="inner">{t('joinTypeNames.inner')}</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditorOpen(false)} disabled={saving}>
            {t('actions.cancel')}
          </Button>
          <Button variant="contained" onClick={() => void handleSave()} disabled={saving || !formValid}>
            {editingId !== null ? t('editor.saveEdit') : t('editor.saveNew')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- Delete confirmation ---- */}
      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('delete.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('delete.confirm', { name: deleteTarget?.name ?? '' })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
            {t('actions.cancel')}
          </Button>
          <Button color="error" variant="contained" onClick={() => void handleDelete()} disabled={deleteBusy}>
            {t('actions.delete')}
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
          {t('diagram.title')}
          <IconButton
            aria-label={t('diagram.ariaClose')}
            onClick={() => setDiagramOpen(false)}
            sx={{ position: 'absolute', top: 8, right: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {t('diagram.caption')}
          </Typography>
          <RelationshipsDiagram
            relationships={relationships}
            height={editorFullScreen ? 340 : 440}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiagramOpen(false)}>{t('actions.close')}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
