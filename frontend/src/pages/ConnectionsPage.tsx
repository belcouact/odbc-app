import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import AddIcon from '@mui/icons-material/Add'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import ErrorIcon from '@mui/icons-material/Error'
import RadarIcon from '@mui/icons-material/Radar'
import RefreshIcon from '@mui/icons-material/Refresh'
import StorageIcon from '@mui/icons-material/Storage'
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
import { api } from '../api/client'
import type { ConnectionPayload } from '../api/client'
import type { DatabaseType, DbConnection, DetectedDsn } from '../types'

interface ConnectionForm {
  name: string
  type: 'dsn' | 'string' | 'access'
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
}

const DATABASE_TYPES: { value: DatabaseType; label: string }[] = [
  { value: 'auto', label: 'Auto (detect)' },
  { value: 'sqlserver', label: 'SQL Server' },
  { value: 'oracle', label: 'Oracle' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'jet', label: 'Access / Excel (Jet)' },
  { value: 'other', label: 'Other' },
]

const DATABASE_TYPE_LABELS: Record<DatabaseType, string> = {
  auto: 'Auto',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  jet: 'Access / Excel (Jet)',
  other: 'Other',
}

/** Best server-type label for a connection card: the resolved DBMS product
 *  name (live-detected by the backend), else the configured type label. */
function serverTypeLabel(connection: DbConnection): string | null {
  if (connection.resolved_dbms) return connection.resolved_dbms
  if (connection.database_type && connection.database_type !== 'auto') {
    return DATABASE_TYPE_LABELS[connection.database_type]
  }
  return null
}

/** The target the connection points at, as lines for the table's detail cell. */
function connectionDetailLines(connection: DbConnection): string[] {
  if (connection.type === 'access') {
    const lines: string[] = []
    const path = connection.file_path || connection.local_path
    if (path) lines.push(`File: ${path}`)
    if (connection.url) lines.push(`Link: ${connection.url}`)
    return lines
  }
  if (connection.type === 'dsn') {
    return [`DSN: ${connection.dsn || '—'}`]
  }
  const target =
    [
      connection.driver && `Driver: ${connection.driver}`,
      connection.server && `Server: ${connection.server}`,
    ]
      .filter(Boolean)
      .join(' · ') || 'Direct connection'
  const lines = [target]
  if (connection.database) lines.push(`Database: ${connection.database}`)
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
}

interface Notice {
  severity: 'success' | 'error'
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
  if (form.connection_string.trim()) base.connection_string = form.connection_string.trim()
  if (form.driver.trim()) base.driver = form.driver.trim()
  if (form.server.trim()) base.server = form.server.trim()
  if (form.database.trim()) base.database = form.database.trim()
  if (form.username.trim()) base.username = form.username.trim()
  if (form.password) base.password = form.password
  if (form.trusted_connection) base.trusted_connection = true
  return base
}

function validateForm(form: ConnectionForm): string | null {
  if (!form.name.trim()) return 'Please enter a connection name.'
  if (form.type === 'access') {
    if (!form.url.trim() && !form.local_path.trim()) {
      return 'Provide a SharePoint link or a local file path.'
    }
    return null
  }
  if (form.type === 'dsn' && !form.dsn.trim()) return 'Please enter the ODBC DSN name.'
  if (form.type === 'string' && !form.connection_string.trim() && !form.driver.trim()) {
    return 'Provide a connection string, or at least a driver and server.'
  }
  return null
}

export default function ConnectionsPage() {
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
      setLoadError(err instanceof Error ? err.message : 'Failed to load connections')
    } finally {
      setLoading(false)
    }
  }, [])

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
    const validation = validateForm(form)
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
        setNotice({ severity: 'success', message: `Connection "${payload.name}" updated.` })
      } else {
        await api.saveConnection(payload)
        setNotice({ severity: 'success', message: `Connection "${payload.name}" saved.` })
      }
      setDialogOpen(false)
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save connection')
    } finally {
      setSaving(false)
    }
  }

  const testPayloadFromForm = async () => {
    setTesting(true)
    setDialogNotice(null)
    try {
      const payload = formToPayload(form)
      const result = await api.testConnection(payload)
      setDialogNotice({
        severity: result.ok ? 'success' : 'error',
        message: result.message || (result.ok ? 'Connection successful.' : 'Connection failed.'),
        details: result.details,
      })
    } catch (err) {
      setDialogNotice({
        severity: 'error',
        message: err instanceof Error ? err.message : 'Connection test failed.',
      })
    } finally {
      setTesting(false)
    }
  }

  const testExisting = async (connection: DbConnection) => {
    setTestingId(connection.id)
    try {
      const payload: ConnectionPayload = connectionToForm(connection)
      const result = await api.testConnection(payload)
      setNotice({
        severity: result.ok ? 'success' : 'error',
        message: `${connection.name}: ${result.message || (result.ok ? 'Connection successful.' : 'Connection failed.')}`,
        details: result.details,
      })
    } catch (err) {
      setNotice({
        severity: 'error',
        message: `${connection.name}: ${err instanceof Error ? err.message : 'Test failed.'}`,
      })
    } finally {
      setTestingId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.deleteConnection(deleteTarget.id)
      setNotice({ severity: 'success', message: `Connection "${deleteTarget.name}" deleted.` })
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      setNotice({
        severity: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete connection',
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
      setDetectError(err instanceof Error ? err.message : 'Failed to detect ODBC DSNs')
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
        message: `Added ${targets.length} connection${targets.length === 1 ? '' : 's'}`,
      })
      await refresh()
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Failed to add connections')
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
          <Typography variant="h5">Connections</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage ODBC data sources used by the query builder.
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
            Detect ODBC DSNs
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={openCreate}
            sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
          >
            Add connection
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
              Retry
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
            No connections yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 420, mx: 'auto' }}>
            Add an ODBC DSN or a direct connection string to start querying your databases.
          </Typography>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} sx={{ minHeight: 48 }}>
            Add your first connection
          </Button>
        </Paper>
      )}

      {connections.length > 0 && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label="Saved connections">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}>
                  Details
                </TableCell>
                <TableCell sx={{ fontWeight: 600, display: { xs: 'none', md: 'table-cell' } }}>
                  Username
                </TableCell>
                <TableCell
                  sx={{
                    fontWeight: 600,
                    display: { xs: 'none', md: 'table-cell' },
                    whiteSpace: 'nowrap',
                  }}
                >
                  Server type
                </TableCell>
                <TableCell
                  sx={{
                    fontWeight: 600,
                    display: { xs: 'none', md: 'table-cell' },
                    whiteSpace: 'nowrap',
                  }}
                >
                  Added
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connections.map((connection) => {
                const detailLines = connectionDetailLines(connection)
                const serverType = serverTypeLabel(connection)
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
                            Username: {connection.username}
                          </Typography>
                        )}
                        {serverType && (
                          <Typography variant="caption" color="text.secondary">
                            Type: {serverType}
                          </Typography>
                        )}
                        <Typography variant="caption" color="text.disabled">
                          Added {added}
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
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
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
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={
                            testingId === connection.id ? (
                              <CircularProgress size={16} />
                            ) : (
                              <CheckCircleIcon />
                            )
                          }
                          onClick={() => void testExisting(connection)}
                          disabled={testingId !== null}
                          sx={{
                            minHeight: { xs: 48, md: 32 },
                            px: { md: 1 },
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Test
                        </Button>
                        <Tooltip title="Edit">
                          <IconButton
                            size="small"
                            onClick={() => openEdit(connection)}
                            aria-label={`Edit ${connection.name}`}
                            sx={{ width: { xs: 48, md: 32 }, height: { xs: 48, md: 32 } }}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => setDeleteTarget(connection)}
                            aria-label={`Delete ${connection.name}`}
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
        <DialogTitle>{editing ? 'Edit connection' : 'Add connection'}</DialogTitle>
        <DialogContent dividers sx={{ pt: 2 }}>
          <Stack spacing={2}>
            <TextField
              label="Connection name"
              value={form.name}
              onChange={updateField('name')}
              fullWidth
              required
              placeholder="e.g. Production SQL Server"
              helperText={
                editing !== null
                  ? "The name is only a label — you can rename it at any time. It won't affect templates, scripts or channel operations."
                  : undefined
              }
            />

            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
                Connection type
              </Typography>
              <ToggleButtonGroup
                exclusive
                fullWidth
                value={form.type}
                disabled={editing !== null}
                onChange={(_event: ReactMouseEvent<HTMLElement>, value: 'dsn' | 'string' | 'access' | null) => {
                  if (value) setForm((current) => ({ ...current, type: value }))
                }}
              >
                <ToggleButton value="dsn" sx={{ minHeight: 48 }}>
                  ODBC DSN
                </ToggleButton>
                <ToggleButton value="string" sx={{ minHeight: 48 }}>
                  Connection String
                </ToggleButton>
                <ToggleButton value="access" sx={{ minHeight: 48 }}>
                  Access File
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {form.type === 'access' ? (
              <>
                <TextField
                  label="SharePoint link"
                  value={form.url}
                  onChange={updateField('url')}
                  fullWidth
                  multiline
                  minRows={2}
                  placeholder="https://…sharepoint.com/:u:/r/sites/…/ColorDB.mdb?d=…"
                  helperText="Paste the shared link to download the .mdb/.accdb file automatically. Internal sites often require a sign-in."
                />
                <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                  — or —
                </Typography>
                <TextField
                  label="Local file path"
                  value={form.local_path}
                  onChange={updateField('local_path')}
                  fullWidth
                  placeholder="C:\\Users\\you\\ColorDB.mdb"
                  helperText="Use a OneDrive-synced folder or a browser download. The local path is preferred when both are given."
                />
              </>
            ) : (
              <FormControl fullWidth>
                <InputLabel id="database-type-label">Database type</InputLabel>
                <Select
                  labelId="database-type-label"
                  label="Database type"
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
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {form.type === 'dsn' ? (
              <>
                <TextField
                  label="DSN name"
                  value={form.dsn}
                  onChange={updateField('dsn')}
                  fullWidth
                  placeholder="e.g. SQLServerNative"
                  disabled={editing !== null}
                  helperText={
                    editing !== null
                      ? "The DSN links templates, scripts & channel operations, so it can't be changed after creation."
                      : undefined
                  }
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={form.trusted_connection}
                      onChange={updateField('trusted_connection')}
                    />
                  }
                  label="Use trusted (Windows) authentication"
                />
                {!form.trusted_connection && (
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label="Username"
                        value={form.username}
                        onChange={updateField('username')}
                        fullWidth
                        autoComplete="off"
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label="Password"
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
            ) : (
              <>
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label="Driver" value={form.driver} onChange={updateField('driver')} fullWidth placeholder="e.g. ODBC Driver 17 for SQL Server" />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label="Server" value={form.server} onChange={updateField('server')} fullWidth placeholder="e.g. localhost\\SQLEXPRESS" />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label="Database" value={form.database} onChange={updateField('database')} fullWidth />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField label="Username" value={form.username} onChange={updateField('username')} fullWidth autoComplete="off" />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Password"
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
                      label="Use trusted (Windows) authentication"
                    />
                  </Grid>
                </Grid>
                <Divider sx={{ my: 1 }}>or provide a full connection string</Divider>
                <TextField
                  label="Connection string"
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
            {dialogNotice && (
              <Alert
                severity={dialogNotice.severity}
                icon={dialogNotice.severity === 'success' ? <CheckCircleIcon /> : <ErrorIcon />}
              >
                {dialogNotice.message}
                {dialogNotice.details && (
                  <Box component="div" sx={{ mt: 0.5, wordBreak: 'break-word', fontSize: '0.85em' }}>
                    {dialogNotice.details}
                  </Box>
                )}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Button
            onClick={() => void testPayloadFromForm()}
            startIcon={testing ? <CircularProgress size={16} /> : <CheckCircleIcon />}
            disabled={testing || saving}
            variant="outlined"
            sx={{ minHeight: 44 }}
          >
            Test
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button onClick={closeDialog} disabled={saving || testing} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            variant="contained"
            disabled={saving || testing}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{ minHeight: 44 }}
          >
            {editing ? 'Save changes' : 'Add connection'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs">
        <DialogTitle>Delete connection?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            “{deleteTarget?.name}” will be removed from this app. Saved queries that use it may no
            longer run.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDelete()}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
            sx={{ minHeight: 44 }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Detect ODBC DSNs */}
      <Dialog open={detectOpen} onClose={() => setDetectOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Detect ODBC DSNs</DialogTitle>
        <DialogContent dividers sx={{ pt: 2 }}>
          {detecting ? (
            <Box sx={{ py: 3 }}>
              <LinearProgress />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, textAlign: 'center' }}>
                Scanning the Windows ODBC registry…
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
                  Retry
                </Button>
              }
            >
              {detectError}
            </Alert>
          ) : detectedDsns.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
              No ODBC DSNs found on this PC
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
                  label="Select all"
                  sx={{ minHeight: 48, mx: 0 }}
                />
                <Typography variant="caption" color="text.secondary">
                  ({selectedDsnIndexes.size} of {selectableIndexes.length} selectable)
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
                          slotProps={{ input: { 'aria-label': `Select ${dsn.dsn}` } }}
                        />
                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                            {dsn.dsn}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                            {dsn.driver || 'Unknown driver'}
                          </Typography>
                        </Box>
                        {dsn.already_saved ? (
                          <Chip size="small" color="success" variant="outlined" label="Saved" />
                        ) : (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`${dsn.scope === 'system' ? 'System' : 'User'} ${dsn.bits}-bit`}
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
            Cancel
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            variant="contained"
            startIcon={addingDsns ? <CircularProgress size={16} color="inherit" /> : <AddIcon />}
            onClick={() => void handleAddDetected()}
            disabled={addingDsns || selectedDsnIndexes.size === 0}
            sx={{ minHeight: 44 }}
          >
            Add selected ({selectedDsnIndexes.size})
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
