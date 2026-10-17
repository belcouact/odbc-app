import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import AddIcon from '@mui/icons-material/Add'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import ErrorIcon from '@mui/icons-material/Error'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import RadarIcon from '@mui/icons-material/Radar'
import RefreshIcon from '@mui/icons-material/Refresh'
import StorageIcon from '@mui/icons-material/Storage'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import Grid from '@mui/material/Grid'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api, RequestCancelledError } from '../api/client'
import type { ConnectionPayload } from '../api/client'
import type { DatabaseType, DbConnection, DetectedDsn } from '../types'

interface ConnectionForm {
  name: string
  type: 'dsn' | 'string' | 'access' | 'databricks'
  dsn: string
  connection_string: string
  driver: string
  server: string
  database: string
  username: string
  password: string
  trusted_connection: boolean
  database_type: DatabaseType
  url: string
  local_path: string
  server_hostname: string
  http_path: string
  default_catalog: string
  query_tags: string
}

const DATABASE_TYPES: { value: DatabaseType; labelKey: string }[] = [
  { value: 'auto', labelKey: 'databaseType.autoDetect' },
  { value: 'sqlserver', labelKey: 'databaseType.sqlserver' },
  { value: 'oracle', labelKey: 'databaseType.oracle' },
  { value: 'mysql', labelKey: 'databaseType.mysql' },
  { value: 'postgresql', labelKey: 'databaseType.postgresql' },
  { value: 'jet', labelKey: 'databaseType.jet' },
  { value: 'other', labelKey: 'databaseType.other' },
]

const DATABASE_TYPE_LABEL_KEYS: Record<DatabaseType, string> = {
  auto: 'databaseType.auto',
  sqlserver: 'databaseType.sqlserver',
  oracle: 'databaseType.oracle',
  mysql: 'databaseType.mysql',
  postgresql: 'databaseType.postgresql',
  jet: 'databaseType.jet',
  other: 'databaseType.other',
}

/** Best server-type label for a connection card: the resolved DBMS product
 *  name (live-detected by the backend), else the configured type label. */
function serverTypeLabel(connection: DbConnection, t: TFunction): string | null {
  if (connection.resolved_dbms) return connection.resolved_dbms
  if (connection.database_type && connection.database_type !== 'auto') {
    return t(DATABASE_TYPE_LABEL_KEYS[connection.database_type])
  }
  return null
}

/** The target the connection points at, as lines for the table's detail cell. */
function connectionDetailLines(connection: DbConnection, t: TFunction): string[] {
  if (connection.type === 'access') {
    const lines: string[] = []
    const path = connection.file_path || connection.local_path
    if (path) lines.push(t('detail.file', { path }))
    if (connection.url) lines.push(t('detail.link', { url: connection.url }))
    return lines
  }
  if (connection.type === 'dsn') {
    return [t('detail.dsn', { dsn: connection.dsn || '—' })]
  }
  if (connection.type === 'databricks') {
    const lines: string[] = []
    if (connection.server_hostname) {
      lines.push(t('detail.databricksHost', { host: connection.server_hostname }))
    }
    if (connection.http_path) {
      lines.push(t('detail.databricksHttpPath', { path: connection.http_path }))
    }
    if (connection.default_catalog) {
      lines.push(t('detail.database', { database: connection.default_catalog }))
    }
    return lines.length > 0 ? lines : [t('detail.directConnection')]
  }
  const target =
    [
      connection.driver && t('detail.driver', { driver: connection.driver }),
      connection.server && t('detail.server', { server: connection.server }),
    ]
      .filter(Boolean)
      .join(' · ') || t('detail.directConnection')
  const lines = [target]
  if (connection.database) lines.push(t('detail.database', { database: connection.database }))
  if (!connection.driver && connection.connection_string) lines.push(connection.connection_string)
  return lines
}

const EMPTY_FORM: ConnectionForm = {
  name: '',
  type: 'dsn',
  dsn: '',
  connection_string: '',
  driver: '',
  server: '',
  database: '',
  username: '',
  password: '',
  trusted_connection: false,
  database_type: 'auto',
  url: '',
  local_path: '',
  server_hostname: '',
  http_path: '',
  default_catalog: '',
  query_tags: '',
}

interface Notice {
  severity: 'success' | 'error' | 'info'
  message: string
  details?: string
}

function connectionToForm(connection: DbConnection): ConnectionForm {
  return {
    name: connection.name ?? '',
    type: connection.type,
    dsn: connection.dsn ?? '',
    connection_string: connection.connection_string ?? '',
    driver: connection.driver ?? '',
    server: connection.server ?? '',
    database: connection.database ?? '',
    username: connection.username ?? '',
    password: connection.password ?? '',
    trusted_connection: connection.trusted_connection ?? false,
    database_type: connection.database_type ?? 'auto',
    url: connection.url ?? '',
    local_path: connection.local_path ?? '',
    server_hostname: connection.server_hostname ?? '',
    http_path: connection.http_path ?? '',
    default_catalog: connection.default_catalog ?? '',
    query_tags: connection.query_tags ?? '',
  }
}

/** Build the API payload from the form, omitting empty optional fields. */
function formToPayload(form: ConnectionForm): ConnectionPayload {
  const base: ConnectionPayload = { name: form.name.trim(), type: form.type }
  if (form.database_type && form.database_type !== 'auto') {
    base.database_type = form.database_type
  }
  if (form.type === 'access') {
    if (form.url.trim()) base.url = form.url.trim()
    if (form.local_path.trim()) base.local_path = form.local_path.trim()
    return base
  }
  if (form.type === 'dsn') {
    if (form.dsn.trim()) base.dsn = form.dsn.trim()
    if (form.trusted_connection) base.trusted_connection = true
    if (!form.trusted_connection) {
      if (form.username.trim()) base.username = form.username.trim()
      if (form.password) base.password = form.password
    }
    return base
  }
  if (form.type === 'databricks') {
    if (form.server_hostname.trim()) base.server_hostname = form.server_hostname.trim()
    if (form.http_path.trim()) base.http_path = form.http_path.trim()
    if (form.default_catalog.trim()) base.default_catalog = form.default_catalog.trim()
    if (form.database.trim()) base.database = form.database.trim()
    if (form.query_tags.trim()) base.query_tags = form.query_tags.trim()
    // Personal access token, stored in the OS keyring via the password field.
    if (form.password) base.password = form.password
    return base
  }
  if (form.connection_string.trim()) base.connection_string = form.connection_string.trim()
  if (form.driver.trim()) base.driver = form.driver.trim()
  if (form.server.trim()) base.server = form.server.trim()
  if (form.database.trim()) base.database = form.database.trim()
  if (form.username.trim()) base.username = form.username.trim()
  if (form.password) base.password = form.password
  if (form.trusted_connection) base.trusted_connection = true
  return base
}

function validateForm(form: ConnectionForm, t: TFunction): string | null {
  if (!form.name.trim()) return t('validation.nameRequired')
  if (form.type === 'access') {
    if (!form.url.trim() && !form.local_path.trim()) {
      return t('validation.accessRequired')
    }
    return null
  }
  if (form.type === 'dsn' && !form.dsn.trim()) return t('validation.dsnRequired')
  if (form.type === 'databricks') {
    if (!form.server_hostname.trim() || !form.http_path.trim()) {
      return t('validation.databricksRequired')
    }
    return null
  }
  if (form.type === 'string' && !form.connection_string.trim() && !form.driver.trim()) {
    return t('validation.stringRequired')
  }
  return null
}

export default function ConnectionsPage() {
  const { t } = useTranslation('connections')
  const [connections, setConnections] = useState<DbConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DbConnection | null>(null)
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [dialogNotice, setDialogNotice] = useState<Notice | null>(null)

  const [testingId, setTestingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DbConnection | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  // Abort controllers for in-flight connection tests, so a test can be
  // cancelled at any time (dialog test and per-row test are independent).
  const dialogTestAbortRef = useRef<AbortController | null>(null)
  const rowTestAbortRef = useRef<AbortController | null>(null)

  // ---- Detect ODBC DSNs ----
  const [detectOpen, setDetectOpen] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detectedDsns, setDetectedDsns] = useState<DetectedDsn[]>([])
  const [selectedDsnIndexes, setSelectedDsnIndexes] = useState<Set<number>>(new Set())
  const [addingDsns, setAddingDsns] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const list = await api.getConnections()
      setConnections(list)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('messages.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setDialogNotice(null)
    setDialogOpen(true)
  }

  const openEdit = (connection: DbConnection) => {
    setEditing(connection)
    setForm(connectionToForm(connection))
    setFormError(null)
    setDialogNotice(null)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    if (saving || testing) return
    setDialogOpen(false)
  }

  const updateField = (field: keyof ConnectionForm) => (event: ChangeEvent<HTMLInputElement>) => {
    const value =
      field === 'trusted_connection' ? event.target.checked : event.target.value
    setForm((current) => ({ ...current, [field]: value }))
    setFormError(null)
  }

  const handleSave = async () => {
    const validation = validateForm(form, t)
    if (validation) {
      setFormError(validation)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const payload = formToPayload(form)
      if (editing) {
        await api.updateConnection(editing.id, payload)
        setNotice({ severity: 'success', message: t('messages.updated', { name: payload.name }) })
      } else {
        await api.saveConnection(payload)
        setNotice({ severity: 'success', message: t('messages.saved', { name: payload.name }) })
      }
      setDialogOpen(false)
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('messages.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const testPayloadFromForm = async () => {
    const controller = new AbortController()
    dialogTestAbortRef.current = controller
    setTesting(true)
    setDialogNotice(null)
    try {
      const payload = formToPayload(form)
      // When editing a saved connection, let the backend fall back to the
      // stored keyring password if the form leaves the password field empty.
      if (editing) payload.id = editing.id
      const result = await api.testConnection(payload, controller.signal)
      setDialogNotice({
        severity: result.ok ? 'success' : 'error',
        message:
          result.message ||
          (result.ok ? t('messages.connectionSuccessful') : t('messages.connectionFailed')),
        details: result.details,
      })
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        setDialogNotice({ severity: 'info', message: t('messages.testCancelled') })
      } else {
        setDialogNotice({
          severity: 'error',
          message: err instanceof Error ? err.message : t('messages.testFailed'),
        })
      }
    } finally {
      if (dialogTestAbortRef.current === controller) dialogTestAbortRef.current = null
      setTesting(false)
    }
  }

  /** Abort an in-flight dialog connection test. */
  const cancelTest = () => {
    dialogTestAbortRef.current?.abort()
  }

  const testExisting = async (connection: DbConnection) => {
    const controller = new AbortController()
    rowTestAbortRef.current = controller
    setTestingId(connection.id)
    try {
      const payload: ConnectionPayload = connectionToForm(connection)
      // The public connection object never carries the password; pass the id
      // so the backend tests with the stored keyring password.
      payload.id = connection.id
      const result = await api.testConnection(payload, controller.signal)
      setNotice({
        severity: result.ok ? 'success' : 'error',
        message: `${connection.name}: ${
          result.message ||
          (result.ok ? t('messages.connectionSuccessful') : t('messages.connectionFailed'))
        }`,
        details: result.details,
      })
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        setNotice({ severity: 'info', message: `${connection.name}: ${t('messages.testCancelled')}` })
      } else {
        setNotice({
          severity: 'error',
          message: `${connection.name}: ${
            err instanceof Error ? err.message : t('messages.testFailedShort')
          }`,
        })
      }
    } finally {
      if (rowTestAbortRef.current === controller) rowTestAbortRef.current = null
      setTestingId(null)
    }
  }

  /** Abort an in-flight per-row connection test. */
  const cancelRowTest = () => {
    rowTestAbortRef.current?.abort()
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.deleteConnection(deleteTarget.id)
      setNotice({
        severity: 'success',
        message: t('messages.deleted', { name: deleteTarget.name }),
      })
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      setNotice({
        severity: 'error',
        message: err instanceof Error ? err.message : t('messages.deleteFailed'),
      })
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  // ---- Detect ODBC DSNs ----
  const openDetect = async () => {
    setDetectOpen(true)
    setDetecting(true)
    setDetectError(null)
    setDetectedDsns([])
    setSelectedDsnIndexes(new Set())
    try {
      const list = await api.detectDsn()
      setDetectedDsns(list)
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : t('messages.detectFailed'))
    } finally {
      setDetecting(false)
    }
  }

  const toggleDsn = (index: number) => {
    setSelectedDsnIndexes((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const toggleAllDsns = () => {
    setSelectedDsnIndexes((current) => {
      const selectableIndexes = detectedDsns
        .map((dsn, index) => (dsn.already_saved ? -1 : index))
        .filter((index) => index >= 0)
      const next = new Set(current)
      if (selectableIndexes.every((index) => next.has(index))) {
        selectableIndexes.forEach((index) => next.delete(index))
      } else {
        selectableIndexes.forEach((index) => next.add(index))
      }
      return next
    })
  }

  const handleAddDetected = async () => {
    const targets = detectedDsns.filter((_dsn, index) => selectedDsnIndexes.has(index))
    if (targets.length === 0) return
    setAddingDsns(true)
    try {
      for (const detected of targets) {
        await api.saveConnection({ name: detected.dsn, type: 'dsn', dsn: detected.dsn })
      }
      setDetectOpen(false)
      setNotice({
        severity: 'success',
        message: t('messages.addedConnections', { count: targets.length }),
      })
      await refresh()
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : t('messages.addFailed'))
    } finally {
      setAddingDsns(false)
    }
  }

  // Rows that can be added — already-saved DSNs are excluded from selection.
  const selectableIndexes = detectedDsns
    .map((dsn, index) => (dsn.already_saved ? -1 : index))
    .filter((index) => index >= 0)

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        useFlexGap
        sx={{ mb: 2, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
      >
        <Box>
          <Typography variant="h5">{t('page.title')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('page.subtitle')}
          </Typography>
        </Box>
        <Stack
          data-tour="connections-actions"
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          useFlexGap
          sx={{ alignSelf: { xs: 'stretch', sm: 'auto' } }}
        >
          <Button
            variant="outlined"
            startIcon={<RadarIcon />}
            onClick={() => void openDetect()}
            sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
          >
            {t('actions.detectDsns')}
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={openCreate}
            sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
          >
            {t('actions.addConnection')}
          </Button>
        </Stack>
      </Stack>

      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {loadError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={() => void refresh()}>
              {t('actions.retry')}
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}

      {!loading && !loadError && connections.length === 0 && (
        <Paper variant="outlined" sx={{ textAlign: 'center', py: { xs: 6, md: 10 }, px: 2 }}>
          <StorageIcon sx={{ fontSize: 56, color: 'text.disabled', mb: 1 }} />
          <Typography variant="h6" gutterBottom>
            {t('empty.title')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 420, mx: 'auto' }}>
            {t('empty.body')}
          </Typography>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} sx={{ minHeight: 48 }}>
            {t('empty.action')}
          </Button>
        </Paper>
      )}

      {connections.length > 0 && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label={t('list.aria')}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>{t('list.name')}</TableCell>
                <TableCell sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}>
                  {t('list.details')}
                </TableCell>
                <TableCell
                  sx={{
                    fontWeight: 600,
                    display: { xs: 'none', md: 'table-cell' },
                    whiteSpace: 'nowrap',
                    minWidth: 96,
                  }}
                >
                  {t('list.username')}
                </TableCell>
                <TableCell
                  sx={{
                    fontWeight: 600,
                    display: { xs: 'none', md: 'table-cell' },
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('list.serverType')}
                </TableCell>
                <TableCell
                  sx={{
                    fontWeight: 600,
                    display: { xs: 'none', md: 'table-cell' },
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('list.added')}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>
                  {t('list.actions')}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connections.map((connection) => {
                const detailLines = connectionDetailLines(connection, t)
                const serverType = serverTypeLabel(connection, t)
                const added = connection.created_at
                  ? new Date(connection.created_at).toLocaleDateString()
                  : '—'
                return (
                  <TableRow key={connection.id} hover>
                    <TableCell>
                      <Typography
                        variant="body2"
                        sx={{
                          fontWeight: 600,
                          whiteSpace: { xs: 'normal', md: 'nowrap' },
                          overflowWrap: { xs: 'anywhere', md: 'normal' },
                        }}
                      >
                        {connection.name}
                      </Typography>
                      <Stack
                        spacing={0.5}
                        sx={{ display: { xs: 'flex', md: 'none' }, mt: 0.5, alignItems: 'flex-start' }}
                      >
                        {detailLines.map((line, index) => (
                          <Typography
                            key={`${connection.id}-detail-${index}`}
                            variant="caption"
                            color="text.secondary"
                            sx={{ wordBreak: 'break-all' }}
                          >
                            {line}
                          </Typography>
                        ))}
                        {connection.username && (
                          <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                            {t('list.usernameInline', { value: connection.username })}
                          </Typography>
                        )}
                        {serverType && (
                          <Typography variant="caption" color="text.secondary">
                            {t('list.typeInline', { value: serverType })}
                          </Typography>
                        )}
                        <Typography variant="caption" color="text.disabled">
                          {t('list.addedInline', { date: added })}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                      <Stack spacing={0.25}>
                        {detailLines.map((line, index) => (
                          <Typography
                            key={`${connection.id}-cell-${index}`}
                            variant="body2"
                            color="text.secondary"
                            sx={{ wordBreak: 'break-all' }}
                          >
                            {line}
                          </Typography>
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell
                      sx={{ display: { xs: 'none', md: 'table-cell' }, whiteSpace: 'nowrap' }}
                    >
                      {connection.username || '—'}
                    </TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                      {serverType || '—'}
                    </TableCell>
                    <TableCell
                      sx={{ display: { xs: 'none', md: 'table-cell' }, whiteSpace: 'nowrap' }}
                    >
                      {added}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <Stack
                        direction="row"
                        spacing={0.25}
                        sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
                      >
                        {testingId === connection.id ? (
                          <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            startIcon={<CircularProgress size={16} />}
                            onClick={cancelRowTest}
                            sx={{
                              minHeight: { xs: 48, md: 32 },
                              px: { md: 1 },
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('actions.cancelTest')}
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<CheckCircleIcon />}
                            onClick={() => void testExisting(connection)}
                            disabled={testingId !== null}
                            sx={{
                              minHeight: { xs: 48, md: 32 },
                              px: { md: 1 },
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('actions.test')}
                          </Button>
                        )}
                        <Tooltip title={t('actions.edit')}>
                          <IconButton
                            size="small"
                            onClick={() => openEdit(connection)}
                            aria-label={t('list.editAria', { name: connection.name })}
                            sx={{ width: { xs: 48, md: 32 }, height: { xs: 48, md: 32 } }}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={t('actions.delete')}>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => setDeleteTarget(connection)}
                            aria-label={t('list.deleteAria', { name: connection.name })}
                            sx={{ width: { xs: 48, md: 32 }, height: { xs: 48, md: 32 } }}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onClose={closeDialog}>
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            pr: 1,
          }}
        >
          {editing ? t('dialog.editTitle') : t('dialog.addTitle')}
          <IconButton
            onClick={closeDialog}
            aria-label={t('dialog.close')}
            size="small"
            disabled={saving || testing}
            sx={{ mr: -0.5 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ pt: 2 }}>
          <Stack spacing={2}>
            <TextField
              label={t('dialog.nameLabel')}
              value={form.name}
              onChange={updateField('name')}
              fullWidth
              required
              placeholder={t('dialog.namePlaceholder')}
              helperText={editing !== null ? t('dialog.nameHelperEdit') : undefined}
            />

            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
                {t('dialog.typeCaption')}
              </Typography>
              <ToggleButtonGroup
                exclusive
                value={form.type}
                disabled={editing !== null}
                onChange={(_event: ReactMouseEvent<HTMLElement>, value: 'dsn' | 'string' | 'access' | 'databricks' | null) => {
                  if (value) setForm((current) => ({ ...current, type: value }))
                }}
                sx={{
                  display: 'flex',
                  width: '100%',
                  // Lay the four types out side by side in a single row. MUI's
                  // `fullWidth` prop would instead stretch *each* button to
                  // 100% (stacking them vertically), so share the row evenly
                  // via flex and let longer labels wrap inside their button.
                  '& .MuiToggleButtonGroup-grouped': {
                    flex: 1,
                    minWidth: 0,
                    px: 0.5,
                    fontSize: { xs: '0.7rem', sm: '0.8125rem' },
                    lineHeight: 1.2,
                    whiteSpace: 'normal',
                    textTransform: 'none',
                  },
                }}
              >
                <ToggleButton value="dsn" sx={{ minHeight: 48 }}>
                  {t('dialog.typeDsn')}
                </ToggleButton>
                <ToggleButton value="string" sx={{ minHeight: 48 }}>
                  {t('dialog.typeString')}
                </ToggleButton>
                <ToggleButton value="access" sx={{ minHeight: 48 }}>
                  {t('dialog.typeAccess')}
                </ToggleButton>
                <ToggleButton value="databricks" sx={{ minHeight: 48 }}>
                  {t('dialog.typeDatabricks')}
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {form.type === 'access' ? (
              <>
                <TextField
                  label={t('dialog.sharepointLabel')}
                  value={form.url}
                  onChange={updateField('url')}
                  fullWidth
                  multiline
                  minRows={2}
                  placeholder="https://…sharepoint.com/:u:/r/sites/…/ColorDB.mdb?d=…"
                  helperText={t('dialog.sharepointHelper')}
                />
                <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                  {t('dialog.orDivider')}
                </Typography>
                <TextField
                  label={t('dialog.localPathLabel')}
                  value={form.local_path}
                  onChange={updateField('local_path')}
                  fullWidth
                  placeholder="C:\\Users\\you\\ColorDB.mdb"
                  helperText={t('dialog.localPathHelper')}
                />
              </>
            ) : form.type === 'databricks' ? null : (
              <FormControl fullWidth>
                <InputLabel id="database-type-label">{t('dialog.databaseTypeLabel')}</InputLabel>
                <Select
                  labelId="database-type-label"
                  label={t('dialog.databaseTypeLabel')}
                  value={form.database_type}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      database_type: event.target.value as DatabaseType,
                    }))
                  }
                >
                  {DATABASE_TYPES.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {form.type === 'dsn' ? (
              <>
                <TextField
                  label={t('dialog.dsnLabel')}
                  value={form.dsn}
                  onChange={updateField('dsn')}
                  fullWidth
                  placeholder={t('dialog.dsnPlaceholder')}
                  disabled={editing !== null}
                  helperText={editing !== null ? t('dialog.dsnHelperEdit') : undefined}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={form.trusted_connection}
                      onChange={updateField('trusted_connection')}
                    />
                  }
                  label={t('dialog.trustedAuth')}
                />
                {!form.trusted_connection && (
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label={t('dialog.usernameLabel')}
                        value={form.username}
                        onChange={updateField('username')}
                        fullWidth
                        autoComplete="off"
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label={t('dialog.passwordLabel')}
                        type="password"
                        value={form.password}
                        onChange={updateField('password')}
                        fullWidth
                        autoComplete="new-password"
                      />
                    </Grid>
                  </Grid>
                )}
              </>
            ) : form.type === 'databricks' ? (
              <>
                <TextField
                  label={t('dialog.databricksHostnameLabel')}
                  value={form.server_hostname}
                  onChange={updateField('server_hostname')}
                  fullWidth
                  required
                  placeholder={t('dialog.databricksHostnamePlaceholder')}
                />
                <TextField
                  label={t('dialog.databricksHttpPathLabel')}
                  value={form.http_path}
                  onChange={updateField('http_path')}
                  fullWidth
                  required
                  placeholder={t('dialog.databricksHttpPathPlaceholder')}
                />
                <TextField
                  label={t('dialog.databricksTokenLabel')}
                  type="password"
                  value={form.password}
                  onChange={updateField('password')}
                  fullWidth
                  autoComplete="new-password"
                  helperText={t('dialog.databricksTokenHelper')}
                />
                <TextField
                  label={t('dialog.databricksDatabaseLabel')}
                  value={form.database}
                  onChange={updateField('database')}
                  fullWidth
                  placeholder={t('dialog.databricksDatabasePlaceholder')}
                />
                <Accordion
                  disableGutters
                  elevation={0}
                  sx={{ border: 1, borderColor: 'divider', borderRadius: 1, '&:before': { display: 'none' } }}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 48 }}>
                    <Typography variant="body2">{t('dialog.databricksAdvanced')}</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Grid container spacing={2}>
                      <Grid size={{ xs: 12 }}>
                        <TextField
                          label={t('dialog.databricksCatalogLabel')}
                          value={form.default_catalog}
                          onChange={updateField('default_catalog')}
                          fullWidth
                          placeholder={t('dialog.databricksCatalogPlaceholder')}
                        />
                      </Grid>
                      <Grid size={{ xs: 12 }}>
                        <TextField
                          label={t('dialog.databricksQueryTagsLabel')}
                          value={form.query_tags}
                          onChange={updateField('query_tags')}
                          fullWidth
                          placeholder={t('dialog.databricksQueryTagsPlaceholder')}
                        />
                      </Grid>
                    </Grid>
                  </AccordionDetails>
                </Accordion>
              </>
            ) : (
              <>
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label={t('dialog.driverLabel')} value={form.driver} onChange={updateField('driver')} fullWidth placeholder="e.g. ODBC Driver 17 for SQL Server" />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label={t('dialog.serverLabel')} value={form.server} onChange={updateField('server')} fullWidth placeholder="e.g. localhost\\SQLEXPRESS" />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label={t('dialog.databaseLabel')} value={form.database} onChange={updateField('database')} fullWidth />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label={t('dialog.usernameLabel')} value={form.username} onChange={updateField('username')} fullWidth autoComplete="off" />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label={t('dialog.passwordLabel')}
                      type="password"
                      value={form.password}
                      onChange={updateField('password')}
                      fullWidth
                      autoComplete="new-password"
                    />
                  </Grid>
                  <Grid size={{ xs: 12 }}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={form.trusted_connection}
                          onChange={updateField('trusted_connection')}
                        />
                      }
                      label={t('dialog.trustedAuth')}
                    />
                  </Grid>
                </Grid>
                <Divider sx={{ my: 1 }}>{t('dialog.stringDivider')}</Divider>
                <TextField
                  label={t('dialog.connectionStringLabel')}
                  value={form.connection_string}
                  onChange={updateField('connection_string')}
                  fullWidth
                  multiline
                  minRows={3}
                  placeholder="DRIVER={ODBC Driver 17 for SQL Server};SERVER=…;DATABASE=…;Trusted_Connection=Yes;"
                />
              </>
            )}

            {formError && <Alert severity="error">{formError}</Alert>}
          </Stack>
        </DialogContent>
        {/* Pin the test result below the scrollable form and above the action
            buttons, so it is always in view instead of scrolled out of sight. */}
        {dialogNotice && (
          <Box sx={{ px: 3, pt: 2 }}>
            <Alert
              severity={dialogNotice.severity}
              icon={
                dialogNotice.severity === 'success' ? (
                  <CheckCircleIcon />
                ) : dialogNotice.severity === 'error' ? (
                  <ErrorIcon />
                ) : undefined
              }
            >
              {dialogNotice.message}
              {dialogNotice.details && (
                <Box component="div" sx={{ mt: 0.5, wordBreak: 'break-word', fontSize: '0.85em' }}>
                  {dialogNotice.details}
                </Box>
              )}
            </Alert>
          </Box>
        )}
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          {testing ? (
            <Button
              onClick={cancelTest}
              startIcon={<CircularProgress size={16} />}
              variant="outlined"
              color="error"
              sx={{ minHeight: 44 }}
            >
              {t('actions.cancelTest')}
            </Button>
          ) : (
            <Button
              onClick={() => void testPayloadFromForm()}
              startIcon={<CheckCircleIcon />}
              disabled={saving}
              variant="outlined"
              sx={{ minHeight: 44 }}
            >
              {t('actions.test')}
            </Button>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button onClick={closeDialog} disabled={saving || testing} sx={{ minHeight: 44 }}>
            {t('actions.cancel')}
          </Button>
          <Button
            onClick={() => void handleSave()}
            variant="contained"
            disabled={saving || testing}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{ minHeight: 44 }}
          >
            {editing ? t('actions.saveChanges') : t('actions.addConnection')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs">
        <DialogTitle>{t('deleteDialog.title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t('deleteDialog.body', { name: deleteTarget?.name })}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting} sx={{ minHeight: 44 }}>
            {t('actions.cancel')}
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDelete()}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
            sx={{ minHeight: 44 }}
          >
            {t('actions.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Detect ODBC DSNs */}
      <Dialog open={detectOpen} onClose={() => setDetectOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            pr: 1,
          }}
        >
          {t('detect.title')}
          <IconButton
            onClick={() => setDetectOpen(false)}
            aria-label={t('detect.close')}
            size="small"
            sx={{ mr: -0.5 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ pt: 2 }}>
          {detecting ? (
            <Box sx={{ py: 3 }}>
              <LinearProgress />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, textAlign: 'center' }}>
                {t('detect.scanning')}
              </Typography>
            </Box>
          ) : detectError ? (
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={() => void openDetect()}
                  sx={{ minHeight: 40 }}
                >
                  {t('actions.retry')}
                </Button>
              }
            >
              {detectError}
            </Alert>
          ) : detectedDsns.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
              {t('detect.none')}
            </Typography>
          ) : (
            <>
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', mb: 0.5 }}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={
                        selectableIndexes.length > 0 &&
                        selectedDsnIndexes.size === selectableIndexes.length
                      }
                      indeterminate={
                        selectedDsnIndexes.size > 0 &&
                        selectedDsnIndexes.size < selectableIndexes.length
                      }
                      onChange={toggleAllDsns}
                    />
                  }
                  label={t('detect.selectAll')}
                  sx={{ minHeight: 48, mx: 0 }}
                />
                <Typography variant="caption" color="text.secondary">
                  ({t('detect.selectedOf', { selected: selectedDsnIndexes.size, total: selectableIndexes.length })})
                </Typography>
              </Stack>
              <Divider sx={{ mb: 1 }} />
              <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
                <Stack spacing={0.5}>
                  {detectedDsns.map((dsn, index) => {
                    const checked = selectedDsnIndexes.has(index)
                    return (
                      <Stack
                        key={`${dsn.dsn}-${dsn.scope}-${dsn.bits}`}
                        direction="row"
                        spacing={1}
                        useFlexGap
                        sx={{
                          alignItems: 'center',
                          minHeight: 48,
                          px: 1,
                          py: 0.5,
                          borderRadius: 1,
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={dsn.already_saved}
                          onChange={() => toggleDsn(index)}
                          slotProps={{ input: { 'aria-label': t('detect.selectDsn', { dsn: dsn.dsn }) } }}
                        />
                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                            {dsn.dsn}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                            {dsn.driver || t('detect.unknownDriver')}
                          </Typography>
                        </Box>
                        {dsn.already_saved ? (
                          <Chip size="small" color="success" variant="outlined" label={t('detect.saved')} />
                        ) : (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={t('detect.scopeBits', { scope: dsn.scope === 'system' ? t('detect.scopeSystem') : t('detect.scopeUser'), bits: dsn.bits })}
                          />
                        )}
                      </Stack>
                    )
                  })}
                </Stack>
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Button onClick={() => setDetectOpen(false)} disabled={addingDsns} sx={{ minHeight: 44 }}>
            {t('actions.cancel')}
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            variant="contained"
            startIcon={addingDsns ? <CircularProgress size={16} color="inherit" /> : <AddIcon />}
            onClick={() => void handleAddDetected()}
            disabled={addingDsns || selectedDsnIndexes.size === 0}
            sx={{ minHeight: 44 }}
          >
            {t('detect.addSelected', { count: selectedDsnIndexes.size })}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={notice?.severity ?? 'info'}
          variant="filled"
          onClose={() => setNotice(null)}
          sx={{ alignItems: 'center' }}
        >
          {notice?.message}
          {notice?.details && (
            <Box component="div" sx={{ mt: 0.5, wordBreak: 'break-word', fontSize: '0.85em' }}>
              {notice.details}
            </Box>
          )}
        </Alert>
      </Snackbar>
    </Box>
  )
}
