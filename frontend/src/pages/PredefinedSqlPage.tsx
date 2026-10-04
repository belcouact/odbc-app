import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import DeleteIcon from '@mui/icons-material/Delete'
import DescriptionIcon from '@mui/icons-material/Description'
import EditIcon from '@mui/icons-material/Edit'
import FileOpenIcon from '@mui/icons-material/FileOpen'
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import SaveIcon from '@mui/icons-material/Save'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import { api, downloadBlob } from '../api/client'
import type { DbConnection, QueryDef, SavedQuery, SavedSqlQuery } from '../types'
import { emit } from '../editorBus'

interface PredefinedSqlPageProps {
  /** True while this list is the visible workspace mode; triggers a refresh. */
  active?: boolean
  /** Switch the workspace to the matching editor mode after loading. */
  onOpenInEditor?: (kind: 'builder' | 'sql') => void
}

type ListTab = 'builder' | 'sql'

interface DeleteTarget {
  kind: ListTab
  id: string
  name: string
}

interface EditTarget {
  kind: ListTab
  id: string
  name: string
  description: string
  /** Current connection of a custom SQL entry (SQL tab only). */
  connectionId?: string | null
}

export default function PredefinedSqlPage({ active, onOpenInEditor }: PredefinedSqlPageProps) {
  const { t } = useTranslation('script')
  const [builderQueries, setBuilderQueries] = useState<SavedQuery[]>([])
  const [sqlQueries, setSqlQueries] = useState<SavedSqlQuery[]>([])
  const [connections, setConnections] = useState<DbConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editConnectionId, setEditConnectionId] = useState('')
  const [editing, setEditing] = useState(false)
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

  // ---- Parameter prompt dialog (builder queries with prompts) ----
  const [promptTarget, setPromptTarget] = useState<SavedQuery | null>(null)
  const [promptValues, setPromptValues] = useState<Record<string, string>>({})
  /** True when confirmation should also run the query, not just load it. */
  const [promptAutoRun, setPromptAutoRun] = useState(false)

  // ---- One-click report export ----
  const [reportingId, setReportingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [builderList, sqlList, connectionList] = await Promise.all([
        api.getSavedQueries(),
        api.getSqlQueries(),
        api.getConnections(),
      ])
      setBuilderQueries(builderList)
      setSqlQueries(sqlList)
      setConnections(connectionList)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('predefined.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The workspace stays mounted (hidden) between tab switches, so re-fetch
  // the latest saved queries every time this list becomes visible again.
  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  const openInEditor = (kind: ListTab, definition: Record<string, unknown>) => {
    if (kind === 'builder') {
      emit({ type: 'load-builder', query: definition })
    } else {
      emit({ type: 'load-sql', sql: String(definition.sql ?? '') })
    }
    onOpenInEditor?.(kind)
  }

  /** Fold the entered prompt values into the saved query's filters. */
  const mergePromptedQuery = (
    saved: SavedQuery,
    values: Record<string, string>,
  ): QueryDef => {
    const merged: QueryDef = { ...saved.query, filters: [...(saved.query.filters ?? [])] }
    for (const param of saved.parameters ?? []) {
      const raw = (values[param.name] ?? '').trim()
      const isNullOp = param.operator === 'is null' || param.operator === 'is not null'
      if (!raw && !isNullOp) continue
      merged.filters.push({ column: param.column, operator: param.operator, value: raw })
    }
    return merged
  }

  /** Open (and optionally run) a builder query, prompting for parameter values first. */
  const openBuilder = (saved: SavedQuery, autoRun: boolean) => {
    const params = saved.parameters ?? []
    if (params.length > 0) {
      const defaults: Record<string, string> = {}
      for (const p of params) defaults[p.name] = p.default ?? ''
      setPromptTarget(saved)
      setPromptValues(defaults)
      setPromptAutoRun(autoRun)
      return
    }
    emit({ type: 'load-builder', query: saved.query as unknown as Record<string, unknown> })
    onOpenInEditor?.('builder')
    if (autoRun) window.setTimeout(() => emit({ type: 'request-run' }), 150)
  }

  const handlePromptConfirmed = () => {
    if (!promptTarget) return
    const merged = mergePromptedQuery(promptTarget, promptValues)
    emit({ type: 'load-builder', query: merged as unknown as Record<string, unknown> })
    onOpenInEditor?.('builder')
    setPromptTarget(null)
    if (promptAutoRun) window.setTimeout(() => emit({ type: 'request-run' }), 150)
  }

  /** One-click report: export a saved builder query as the 4-sheet Excel report. */
  const handleExportReport = async (saved: SavedQuery) => {
    setReportingId(saved.id)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const filename = `${saved.name.replace(/[^\w.-]+/g, '_')}_${stamp}.xlsx`
      const blob = await api.exportReport(saved.query, saved.name)
      const savedToDisk = await downloadBlob(blob, filename)
      if (savedToDisk.cancelled) {
        setNotice(t('predefined.reportCancelled'))
        return
      }
      setNotice(
        savedToDisk.savedPath
          ? t('predefined.reportExportedTo', { path: savedToDisk.savedPath })
          : t('predefined.reportExported', { filename }),
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('predefined.reportFailed'))
    } finally {
      setReportingId(null)
    }
  }

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.kind === 'builder') {
        await api.deleteSavedQuery(deleteTarget.id)
        setBuilderQueries((current) => current.filter((q) => q.id !== deleteTarget.id))
      } else {
        await api.deleteSqlQuery(deleteTarget.id)
        setSqlQueries((current) => current.filter((q) => q.id !== deleteTarget.id))
      }
      showNotice(t('notices.deleted', { name: deleteTarget.name }), 'success')
      setDeleteTarget(null)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('notices.failedToDelete'))
    } finally {
      setDeleting(false)
    }
  }

  const openEdit = (
    kind: ListTab,
    id: string,
    name: string,
    description?: string,
    connectionId?: string | null,
  ) => {
    setEditTarget({ kind, id, name, description: description ?? '', connectionId })
    setEditName(name)
    setEditDescription(description ?? '')
    setEditConnectionId(connectionId ?? '')
    setNotice(null)
  }

  const handleEditConfirmed = async () => {
    if (!editTarget) return
    const name = editName.trim()
    if (!name) {
      setNotice(t('notices.enterName'))
      return
    }
    setEditing(true)
    try {
      if (editTarget.kind === 'builder') {
        const current = builderQueries.find((q) => q.id === editTarget.id)
        if (!current) throw new Error(t('predefined.noLongerExists'))
        const updated = await api.updateSavedQuery(editTarget.id, name, editDescription, current.query)
        setBuilderQueries((list) => list.map((q) => (q.id === editTarget.id ? updated : q)))
      } else {
        const current = sqlQueries.find((q) => q.id === editTarget.id)
        if (!current) throw new Error(t('predefined.noLongerExists'))
        const updated = await api.updateSqlQuery(
          editTarget.id,
          name,
          editDescription,
          current.sql,
          editConnectionId || null,
        )
        setSqlQueries((list) => list.map((q) => (q.id === editTarget.id ? updated : q)))
      }
      showNotice(t('notices.updated', { name }), 'success')
      setEditTarget(null)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('notices.failedToUpdate'))
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

  // Combined list of every saved pre-defined query (Builder + custom SQL).
  type CombinedQuery =
    | { kind: 'builder'; item: SavedQuery }
    | { kind: 'sql'; item: SavedSqlQuery }

  const combinedQueries = useMemo<CombinedQuery[]>(() => {
    const builder: CombinedQuery[] = builderQueries.map((q) => ({ kind: 'builder', item: q }))
    const sql: CombinedQuery[] = sqlQueries.map((q) => ({ kind: 'sql', item: q }))
    return [...builder, ...sql]
  }, [builderQueries, sqlQueries])

  const combinedCount = combinedQueries.length

  return (
    <Box sx={{ width: '100%' }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6">{t('predefined.title')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('predefined.subtitle')}
          </Typography>
        </Box>

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

        {!loading && !loadError && combinedCount === 0 && (
          <Paper variant="outlined" sx={{ textAlign: 'center', py: 6, px: 2 }}>
            <LibraryBooksIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
            <Typography variant="h6" gutterBottom>
              {t('predefined.emptyTitle')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('predefined.emptyBody')}
            </Typography>
          </Paper>
        )}
        {combinedCount > 0 && (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label={t('predefined.tableAria')}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>{t('predefined.colConnection')}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{t('predefined.colName')}</TableCell>
                  <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {t('predefined.colType')}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}>
                    {t('predefined.colSource')}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600, display: { xs: 'none', sm: 'table-cell' } }}>
                    {t('predefined.colDescription')}
                  </TableCell>
                  <TableCell
                    sx={{
                      fontWeight: 600,
                      display: { xs: 'none', md: 'table-cell' },
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('predefined.colSaved')}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {t('predefined.colActions')}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {combinedQueries.map((query) => (
                  <TableRow key={`${query.kind}-${query.item.id}`} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Typography variant="body2" color="text.secondary">
                        {connectionLabel(
                          query.kind === 'builder'
                            ? query.item.query.connection_id
                            : query.item.connection_id,
                        )}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
                        {query.item.name}
                      </Typography>
                      {/* On phones the Source/Description/Saved columns are hidden,
                          so fold the key facts into the name cell. */}
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: { xs: 'block', md: 'none' } }}
                      >
                        {query.kind === 'builder'
                          ? t('predefined.tableSource', { table: query.item.query.table })
                          : query.item.sql || '—'}
                      </Typography>
                      {query.item.description && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: { xs: 'block', sm: 'none' } }}
                        >
                          {query.item.description}
                        </Typography>
                      )}
                      <Typography
                        variant="caption"
                        color="text.disabled"
                        sx={{ display: { xs: 'block', md: 'none' } }}
                      >
                        {query.kind === 'builder'
                          ? t('predefined.savedDate', {
                              date: new Date(query.item.created_at).toLocaleDateString(),
                            })
                          : t('predefined.updatedDate', {
                              date: new Date(query.item.updated_at).toLocaleDateString(),
                            })}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <Chip
                          size="small"
                          color={query.kind === 'builder' ? 'primary' : 'secondary'}
                          variant="outlined"
                          label={query.kind === 'builder' ? t('predefined.chipBuilder') : t('predefined.chipSql')}
                        />
                        {query.kind === 'builder' && (query.item.parameters?.length ?? 0) > 0 && (
                          <Chip
                            size="small"
                            variant="outlined"
                            color="warning"
                            label={t('predefined.prompts', { count: query.item.parameters!.length })}
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{
                          maxWidth: 360,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {query.kind === 'builder'
                          ? t('predefined.tableSource', { table: query.item.query.table })
                          : query.item.sql || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell
                      sx={{
                        display: { xs: 'none', sm: 'table-cell' },
                        color: 'text.secondary',
                        maxWidth: 320,
                      }}
                    >
                      {query.item.description || '—'}
                    </TableCell>
                    <TableCell
                      sx={{ display: { xs: 'none', md: 'table-cell' }, whiteSpace: 'nowrap' }}
                    >
                      {query.kind === 'builder'
                        ? new Date(query.item.created_at).toLocaleDateString()
                        : new Date(query.item.updated_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell align="right">
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
                      >
                        {query.kind === 'builder' && (
                          <Tooltip title={t('predefined.run')}>
                            <IconButton
                              size="small"
                              color="primary"
                              aria-label={t('predefined.runAria', { name: query.item.name })}
                              onClick={() => openBuilder(query.item, true)}
                              sx={{ width: 48, height: 48 }}
                            >
                              <PlayArrowIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip title={t('predefined.openInEditor')}>
                          <IconButton
                            size="small"
                            aria-label={t('predefined.openAria', { name: query.item.name })}
                            onClick={() =>
                              query.kind === 'builder'
                                ? openBuilder(query.item, false)
                                : openInEditor('sql', { sql: query.item.sql })
                            }
                            sx={{ width: 48, height: 48 }}
                          >
                            <FileOpenIcon />
                          </IconButton>
                        </Tooltip>
                        {query.kind === 'builder' && (
                          <Tooltip title={t('predefined.report')}>
                            <span>
                              <IconButton
                                size="small"
                                color="secondary"
                                aria-label={t('predefined.reportAria', { name: query.item.name })}
                                onClick={() => void handleExportReport(query.item)}
                                disabled={reportingId !== null}
                                sx={{ width: 48, height: 48 }}
                              >
                                {reportingId === query.item.id ? (
                                  <CircularProgress size={18} />
                                ) : (
                                  <DescriptionIcon />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip title={t('predefined.edit')}>
                          <IconButton
                            size="small"
                            aria-label={t('predefined.editAria', { name: query.item.name })}
                            onClick={() =>
                              openEdit(
                                query.kind,
                                query.item.id,
                                query.item.name,
                                query.item.description,
                                query.kind === 'sql' ? query.item.connection_id : undefined,
                              )
                            }
                            sx={{ width: 48, height: 48 }}
                          >
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={t('predefined.delete')}>
                          <IconButton
                            size="small"
                            color="error"
                            aria-label={t('predefined.deleteAria', { name: query.item.name })}
                            onClick={() =>
                              setDeleteTarget({
                                kind: query.kind,
                                id: query.item.id,
                                name: query.item.name,
                              })
                            }
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
      </Stack>

      {/* Edit name & description */}
      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {t(editTarget?.kind === 'builder' ? 'predefined.editDialog.builderTitle' : 'predefined.editDialog.sqlTitle')}
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={1.5}>
            <TextField
              label={t('predefined.editDialog.nameLabel')}
              value={editName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setEditName(event.target.value)}
              fullWidth
              required
              autoFocus
            />
            {editTarget?.kind === 'sql' && (
              <FormControl fullWidth size="small">
                <InputLabel id="edit-sql-connection-label">{t('predefined.editDialog.connectionLabel')}</InputLabel>
                <Select
                  labelId="edit-sql-connection-label"
                  label={t('predefined.editDialog.connectionLabel')}
                  value={editConnectionId}
                  onChange={(event: SelectChangeEvent) => setEditConnectionId(event.target.value)}
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
            )}
            <TextField
              label={t('predefined.editDialog.descriptionLabel')}
              value={editDescription}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setEditDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              placeholder={t('predefined.editDialog.descriptionPlaceholder')}
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
        <DialogTitle>{t('predefined.deleteDialog.title', { name: deleteTarget?.name })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t(deleteTarget?.kind === 'builder' ? 'predefined.deleteDialog.builderBody' : 'predefined.deleteDialog.sqlBody')}
          </Typography>
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

      {/* Parameter prompt dialog (builder queries with prompts) */}
      <Dialog open={promptTarget !== null} onClose={() => setPromptTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t(promptAutoRun ? 'predefined.promptDialog.runTitle' : 'predefined.promptDialog.openTitle', { name: promptTarget?.name })}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              {t('predefined.promptDialog.body')}
            </Typography>
            {(promptTarget?.parameters ?? []).map((param) => {
              const isNullOp = param.operator === 'is null' || param.operator === 'is not null'
              return (
                <TextField
                  key={param.name}
                  label={param.label}
                  value={promptValues[param.name] ?? ''}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setPromptValues((current) => ({ ...current, [param.name]: event.target.value }))
                  }
                  fullWidth
                  disabled={isNullOp}
                  placeholder={isNullOp ? (param.operator === 'is null' ? t('predefined.promptDialog.willFilterNull') : t('predefined.promptDialog.willFilterNotNull')) : param.default !== undefined ? t('predefined.promptDialog.default', { value: param.default }) : t('predefined.promptDialog.filter', { column: param.column })}
                  autoFocus={false}
                />
              )
            })}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPromptTarget(null)} sx={{ minHeight: 44 }}>
            {t('common.cancel')}
          </Button>
          <Button variant="contained" onClick={() => void handlePromptConfirmed()} sx={{ minHeight: 44 }}>
            {promptAutoRun ? t('predefined.promptDialog.run') : t('predefined.promptDialog.openInEditor')}
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
