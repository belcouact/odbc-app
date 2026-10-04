import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColDef, GridReadyEvent } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'
import SaveIcon from '@mui/icons-material/Save'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import type { ChannelRow, ChannelSet } from '../api/client'
import { AG_GRID_LOCALE_ZH } from '../i18n/agGridZh'

const DISPLAY_FIELDS: (keyof ChannelRow)[] = [
  'operation',
  'group_name',
  'description',
  'DEVICE_NBR',
  'CHAN_NBR',
]

/**
 * Stable identity for a channel row. The full channel `description` usually
 * carries the unique identity, but DEVICE_NBR / CHAN_NBR disambiguate the rare
 * duplicate descriptions (e.g. Payoff_ScrayRoll_TensionSP). Include all fields
 * so the key is unique whether or not the numbers are present.
 */
function channelRowKey(row: ChannelRow): string {
  return [
    String(row.operation ?? '').trim(),
    String(row.group_name ?? '').trim(),
    String(row.description ?? '').trim(),
    String(row.DEVICE_NBR ?? '').trim(),
    String(row.CHAN_NBR ?? '').trim(),
  ].join('\u0001')
}

/**
 * Match the channels of a saved set against the live rows currently shown in
 * the grid, returning the grid keys to tick.
 *
 * Newly saved sets carry DEVICE_NBR / CHAN_NBR, so they match exactly. Older
 * sets lost those values (they were saved as empty strings), so fall back to
 * operation + group_name + description to still tick the right rows.
 */
function matchSavedToLiveKeys(savedRows: ChannelRow[], liveRows: ChannelRow[]): Set<string> {
  const keys = new Set<string>()
  for (const saved of savedRows) {
    const op = String(saved.operation ?? '').trim()
    const group = String(saved.group_name ?? '').trim()
    const desc = String(saved.description ?? '').trim()
    const dev = String(saved.DEVICE_NBR ?? '').trim()
    const chan = String(saved.CHAN_NBR ?? '').trim()

    let matches = liveRows.filter(
      (r) =>
        String(r.operation ?? '').trim() === op &&
        String(r.group_name ?? '').trim() === group &&
        String(r.description ?? '').trim() === desc &&
        String(r.DEVICE_NBR ?? '').trim() === dev &&
        String(r.CHAN_NBR ?? '').trim() === chan,
    )
    // Old saved sets have empty device/chan — match on the remaining fields.
    if (!(dev || chan)) {
      const relaxed = liveRows.filter(
        (r) =>
          String(r.operation ?? '').trim() === op &&
          String(r.group_name ?? '').trim() === group &&
          String(r.description ?? '').trim() === desc,
      )
      if (relaxed.length > 0) matches = relaxed
    }
    for (const m of matches) keys.add(channelRowKey(m))
  }
  return keys
}

/**
 * Normalize a channel record into the display shape. Saved sets may hold the
 * snake_case keys (device_nbr / chan_nbr) written by the backend while live
 * rows use the upper-case display keys, so read both.
 */
function normalizeChannel(channel: ChannelRow | Record<string, unknown>): ChannelRow {
  const c = channel as Record<string, unknown>
  return {
    operation: String(c.operation ?? ''),
    group_name: String(c.group_name ?? ''),
    description: String(c.description ?? ''),
    DEVICE_NBR: String(c.DEVICE_NBR ?? c.device_nbr ?? ''),
    CHAN_NBR: String(c.CHAN_NBR ?? c.chan_nbr ?? ''),
  }
}

interface ChannelSelectDialogProps {
  open: boolean
  onClose: () => void
  /** Display name of the active connection (used for the ODBC lookups). */
  connectionName: string
  /** Called after a set is saved, with the operation the set belongs to. */
  onSaved: (operation: string) => void
  /** Success message shown by the parent (e.g. inside the page Snackbar). */
  onNotice?: (message: string) => void
}

/**
 * "Select Channels" picker for the SZMFGACTIVE / Process_Data template.
 *
 * Lets the user pick an operation from DL_ChannelMaster, inspect the channel
 * rows in a sortable/filterable grid, tick the ones to include, name the set
 * and save it. Below the grid a dropdown lists the existing pre-defined sets
 * for the operation, which can be re-loaded, updated or deleted.
 */
export default function ChannelSelectDialog({
  open,
  onClose,
  connectionName,
  onSaved,
  onNotice,
}: ChannelSelectDialogProps) {
  const gridRef = useRef<AgGridReact<ChannelRow>>(null)
  // Subscribes to language changes so the grid rebuilds with the matching
  // AG Grid localeText (localeText is read once, at grid creation).
  const { i18n } = useTranslation()

  const [operations, setOperations] = useState<string[]>([])
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [operationsError, setOperationsError] = useState<string | null>(null)

  const [selectedOperation, setSelectedOperation] = useState('')
  const [rows, setRows] = useState<ChannelRow[]>([])
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)

  const [selectedCount, setSelectedCount] = useState(0)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [existingSets, setExistingSets] = useState<ChannelSet[]>([])
  const [existingSetsLoading, setExistingSetsLoading] = useState(false)
  const [selectedSetName, setSelectedSetName] = useState('')
  /**
   * Channels loaded from an existing set, re-matched against the live rows once
   * the grid has materialized (so a set picked before rows finish loading still
   * ticks the right rows).
   */
  const [pendingSaved, setPendingSaved] = useState<ChannelRow[] | null>(null)

  // Reset + lazy-load the operations whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setName('')
    setSaveError(null)
    setSelectedCount(0)
    setRows([])
    setRowsError(null)
    setSelectedOperation('')
    setSelectedSetName('')
    setExistingSets([])
    setPendingSaved(null)
    if (operations.length === 0 && !operationsLoading) {
      setOperationsLoading(true)
      setOperationsError(null)
      api
        .getChannelOperations(connectionName)
        .then((response) => setOperations(response.operations))
        .catch((err) =>
          setOperationsError(err instanceof Error ? err.message : 'Failed to load operations'),
        )
        .finally(() => setOperationsLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionName])

  // Load channel rows + existing sets whenever an operation is picked.
  useEffect(() => {
    if (!open || !selectedOperation) {
      setRows([])
      setExistingSets([])
      setSelectedSetName('')
      return
    }
    let cancelled = false
    setRowsLoading(true)
    setRowsError(null)
    setSelectedCount(0)
    setExistingSetsLoading(true)
    api
      .getChannelsForOperation(connectionName, selectedOperation)
      .then((response) => {
        if (cancelled) return
        setRows(response.rows)
      })
      .catch((err) => {
        if (cancelled) return
        setRowsError(err instanceof Error ? err.message : 'Failed to load channels')
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false)
      })
    api
      .getChannelSets(selectedOperation)
      .then((response) => {
        if (cancelled) return
        setExistingSets(response.sets)
      })
      .catch(() => {
        if (!cancelled) setExistingSets([])
      })
      .finally(() => {
        if (!cancelled) setExistingSetsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, connectionName, selectedOperation])

  // Apply the pending selection (loaded from an existing set) once the grid
  // has materialized its rows for the currently selected operation.
  useEffect(() => {
    if (!pendingSaved) return
    let cancelled = false
    const apply = () => {
      if (cancelled) return
      const grid = gridRef.current?.api
      const nodeCount = grid?.getDisplayedRowCount?.() ?? 0
      if (!grid || nodeCount === 0) {
        requestAnimationFrame(apply)
        return
      }
      const keys = matchSavedToLiveKeys(pendingSaved, rows)
      grid.forEachNode((node) => {
        node.setSelected(node.data ? keys.has(channelRowKey(node.data)) : false)
      })
      setPendingSaved(null)
    }
    requestAnimationFrame(apply)
    return () => {
      cancelled = true
    }
  }, [pendingSaved, rows])

  const refreshExistingSets = useCallback((operation: string) => {
    if (!operation) {
      setExistingSets([])
      return
    }
    setExistingSetsLoading(true)
    api
      .getChannelSets(operation)
      .then((response) => {
        setExistingSets(response.sets)
        // Drop the selection if the set no longer exists after the fetch.
        setSelectedSetName((current) =>
          response.sets.some((set) => set.name === current) ? current : '',
        )
      })
      .catch(() => {
        // Leave the current list untouched on a transient failure.
      })
      .finally(() => setExistingSetsLoading(false))
  }, [])

  const columnDefs = useMemo<ColDef<ChannelRow>[]>(() => {
    const checkbox: ColDef<ChannelRow> = {
      headerCheckboxSelection: true,
      checkboxSelection: true,
      pinned: 'left',
      width: 48,
      sortable: false,
      filter: false,
      resizable: false,
      enableRowGroup: false,
    }
    const dataCols: ColDef<ChannelRow>[] = DISPLAY_FIELDS.map((field) => ({
      field,
      headerName: field,
      sortable: true,
      filter: true,
      resizable: true,
      minWidth: 140,
    }))
    return [checkbox, ...dataCols]
  }, [])

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
      // Keep the filter inside the header (no extra floating-filter row).
      floatingFilter: false,
    }),
    [],
  )

  const handleGridReady = useCallback((params: GridReadyEvent<ChannelRow>) => {
    params.api.sizeColumnsToFit()
  }, [])

  const handleSelectionChanged = useCallback(() => {
    setSelectedCount(gridRef.current?.api.getSelectedRows().length ?? 0)
  }, [])

  /** Load an existing set into the grid: name it and tick its channel rows. */
  const handleExistingChange = (existingName: string) => {
    setSelectedSetName(existingName)
    const foundSet = existingSets.find((s) => s.name === existingName)
    if (foundSet) {
      const normalized = (foundSet.channels ?? []).map(normalizeChannel)
      setName(foundSet.name)
      setPendingSaved(normalized)
    } else {
      setPendingSaved(null)
    }
  }

  const canSave = selectedOperation.trim() !== '' && name.trim() !== '' && selectedCount > 0 && !busy
  const canUpdate = selectedSetName.trim() !== '' && selectedCount > 0 && !busy
  const canDelete = selectedSetName.trim() !== '' && !busy

  const handleSave = async () => {
    if (!canSave) return
    const selectedRows = gridRef.current?.api.getSelectedRows() ?? []
    if (selectedRows.length === 0) {
      setSaveError('Select at least one channel to save.')
      return
    }
    setBusy(true)
    setSaveError(null)
    try {
      await api.saveChannelSet({ name: name.trim(), operation: selectedOperation, channels: selectedRows })
      onSaved(selectedOperation)
      onNotice?.(`Channel set '${name.trim()}' saved.`)
      refreshExistingSets(selectedOperation)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save the channel set')
    } finally {
      setBusy(false)
    }
  }

  const handleUpdate = async () => {
    if (!canUpdate) return
    const selectedRows = gridRef.current?.api.getSelectedRows() ?? []
    if (selectedRows.length === 0) {
      setSaveError('Select at least one channel to update.')
      return
    }
    setBusy(true)
    setSaveError(null)
    try {
      await api.saveChannelSet({
        name: selectedSetName,
        operation: selectedOperation,
        channels: selectedRows,
      })
      onSaved(selectedOperation)
      onNotice?.(`Channel set '${selectedSetName}' updated.`)
      refreshExistingSets(selectedOperation)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to update the channel set')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!canDelete) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.deleteChannelSet(selectedSetName, selectedOperation)
      onSaved(selectedOperation)
      onNotice?.(`Channel set '${selectedSetName}' deleted.`)
      setSelectedSetName('')
      setName('')
      setPendingSaved(null)
      refreshExistingSets(selectedOperation)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete the channel set')
    } finally {
      setBusy(false)
    }
  }

  const showGrid = selectedOperation !== ''
  const emptyRows = !rowsLoading && !rowsError && rows.length === 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      slotProps={{ paper: { sx: { borderRadius: 0 } } }}
    >
      <DialogTitle>
        Select Channels
        <IconButton
          aria-label="close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {!connectionName ? (
            <Alert severity="warning">Select a connection before choosing channels.</Alert>
          ) : operationsError ? (
            <Alert severity="error">{operationsError}</Alert>
          ) : (
            <FormControl size="small" sx={{ maxWidth: { xs: '100%', sm: 360 } }}>
              <InputLabel id="channel-operation-label">Operation</InputLabel>
              <Select
                labelId="channel-operation-label"
                label="Operation"
                value={selectedOperation}
                onChange={(event: SelectChangeEvent) => setSelectedOperation(event.target.value)}
                disabled={operationsLoading}
              >
                <MenuItem value="">— none —</MenuItem>
                {operations.map((op) => (
                  <MenuItem key={op} value={op}>
                    {op}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          {showGrid && (
            <>
              {rowsError ? (
                <Alert severity="error">{rowsError}</Alert>
              ) : rowsLoading ? (
                <Stack sx={{ alignItems: 'center', py: 4 }}>
                  <CircularProgress size={28} />
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    Loading channels…
                  </Typography>
                </Stack>
              ) : (
                <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
                  <Box
                    className="ag-theme-quartz"
                    sx={{
                      height: { xs: 300, md: 'calc(100vh - 340px)' },
                      minHeight: { md: 260 },
                      width: '100%',
                    }}
                  >
                    <AgGridReact<ChannelRow>
                      // Rebuilding on a language change re-reads localeText,
                      // which is otherwise captured once at grid creation.
                      key={i18n.language}
                      localeText={i18n.language.startsWith('zh') ? AG_GRID_LOCALE_ZH : undefined}
                      ref={gridRef}
                      rowData={rows}
                      columnDefs={columnDefs}
                      defaultColDef={defaultColDef}
                      getRowId={(params) => channelRowKey(params.data)}
                      rowSelection={{ mode: 'multiRow' }}
                      onGridReady={handleGridReady}
                      onSelectionChanged={handleSelectionChanged}
                    />
                  </Box>
                  {emptyRows && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      No channels found for this operation.
                    </Typography>
                  )}
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {selectedCount} channel{selectedCount === 1 ? '' : 's'} selected.
                  </Typography>
                </Box>
              )}

              {/* Existing pre-defined sets + save / update / delete actions */}
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                useFlexGap
                sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
              >
                <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 260 }, flexGrow: 1 }}>
                  <InputLabel id="existing-set-label">Existing set</InputLabel>
                  <Select
                    labelId="existing-set-label"
                    label="Existing set"
                    value={selectedSetName}
                    onChange={(event: SelectChangeEvent) => handleExistingChange(event.target.value)}
                    disabled={existingSetsLoading || existingSets.length === 0}
                  >
                    <MenuItem value="">— load a saved set —</MenuItem>
                    {existingSets.map((set) => (
                      <MenuItem key={`${set.operation}|${set.name}`} value={set.name}>
                        {set.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  size="small"
                  fullWidth
                  label="Set name"
                  placeholder="Name this channel set"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={!showGrid}
                  sx={{ flexGrow: 1 }}
                />
                <Stack direction="row" spacing={1} useFlexGap>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={() => void handleDelete()}
                    disabled={!canDelete}
                    sx={{ minHeight: 40 }}
                  >
                    Delete
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => void handleUpdate()}
                    disabled={!canUpdate}
                    sx={{ minHeight: 40 }}
                  >
                    Update
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={() => void handleSave()}
                    disabled={!canSave}
                    sx={{ minHeight: 40 }}
                  >
                    Save
                  </Button>
                </Stack>
              </Stack>

              {saveError && <Alert severity="error">{saveError}</Alert>}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" variant="outlined" onClick={onClose} sx={{ minHeight: 40 }} disabled={busy}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}
