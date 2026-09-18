import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community'
import type { ColDef, ColumnState, GridApi, GridReadyEvent, ValueFormatterParams } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-quartz.css'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CloseIcon from '@mui/icons-material/Close'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import FunctionsIcon from '@mui/icons-material/Functions'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import TuneIcon from '@mui/icons-material/Tune'
import UndoIcon from '@mui/icons-material/Undo'
import Typography from '@mui/material/Typography'
import type { GridDrillFilter, QueryResult } from '../types'
import { formatCellValue } from '../utils/format'
import { detectColumnKind, groupingKey, type ColumnKind } from '../utils/columns'
import type { ComputedColumn } from '../utils/formula'
import AddColumnDialog from './AddColumnDialog'
import ColumnTypesDialog from './ColumnTypesDialog'

// Register the full community feature set once (filters, pagination, clipboard, ...).
ModuleRegistry.registerModules([AllCommunityModule])

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

interface EditableHeaderProps {
  /** Label AG Grid derived for the column (its ``headerName``). */
  displayName?: string
  /** Original data column name — the key the label override is stored under. */
  renameHeaderKey?: string
  /** Saves a new label for the column; an empty value clears the override. */
  onRenameHeader?: (key: string, label: string) => void
  /** Supplied by AG Grid; used to undo the sort a double-click triggers. */
  api?: GridApi
}

/** Header inner component: shows the column label and, on double-click, swaps
 *  it for an input so the column can be renamed. Only the label changes — the
 *  column keeps its original ``field``, so sorting, filters, drill-through,
 *  computed columns and copy/export all keep working on the real column name. */
function EditableHeader({
  displayName = '',
  renameHeaderKey,
  onRenameHeader,
  api,
}: EditableHeaderProps) {
  const containerRef = useRef<HTMLSpanElement | null>(null)
  /** Set while cancelling, so the blur that follows does not commit the draft. */
  const skipCommitRef = useRef(false)
  /** Sort state from before the click, so a rename can put it back. */
  const sortStateRef = useRef<ColumnState[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const startEditing = useCallback(() => {
    skipCommitRef.current = false
    setDraft(displayName)
    setEditing(true)
  }, [displayName])

  const commit = useCallback(() => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false
      return
    }
    setEditing(false)
    if (!renameHeaderKey || !onRenameHeader) return
    onRenameHeader(renameHeaderKey, draft)
  }, [draft, onRenameHeader, renameHeaderKey])

  const cancel = useCallback(() => {
    skipCommitRef.current = true
    setEditing(false)
  }, [])

  // AG Grid toggles sorting from a `click` listener on the parent header label,
  // and React handlers are delegated to the app root — too late to stop it. Our
  // listeners sit on this span (a child of that label), so they run first and
  // can swallow the second click of a double-click plus any click that lands
  // inside the open editor.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const handleMouseDown = (event: MouseEvent) => {
      if (editing) {
        event.stopPropagation()
        return
      }
      // The first click of a double-click still reaches AG Grid and sorts the
      // column, so remember the sort as it was before that happens.
      if (event.detail < 2 && api) {
        sortStateRef.current = api
          .getColumnState()
          .map(({ colId, sort, sortIndex }) => ({ colId, sort, sortIndex }))
      }
    }
    /** Opens the rename editor, undoing the sort the double-click's clicks applied. */
    const beginRename = (event: MouseEvent) => {
      if (editing || !renameHeaderKey) return
      event.stopPropagation()
      if (api && sortStateRef.current) {
        api.applyColumnState({ state: sortStateRef.current })
        sortStateRef.current = null
      }
      startEditing()
    }
    const handleClick = (event: MouseEvent) => {
      if (editing) {
        event.stopPropagation()
        return
      }
      if (event.detail < 2) return
      beginRename(event)
    }
    // Touch devices report every tap as `detail: 1`, so a double-tap arrives as
    // a `dblclick` instead of a second click.
    const handleDoubleClick = (event: MouseEvent) => {
      if (editing) return
      beginRename(event)
    }
    element.addEventListener('mousedown', handleMouseDown)
    element.addEventListener('click', handleClick)
    element.addEventListener('dblclick', handleDoubleClick)
    return () => {
      element.removeEventListener('mousedown', handleMouseDown)
      element.removeEventListener('click', handleClick)
      element.removeEventListener('dblclick', handleDoubleClick)
    }
  }, [api, editing, renameHeaderKey, startEditing])

  return (
    <span
      ref={containerRef}
      title={renameHeaderKey ? `${displayName} — double-click to rename` : displayName}
      style={{
        display: 'block',
        width: '100%',
        overflow: editing ? 'visible' : 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        // Keep the browser's double-tap zoom from swallowing the rename gesture.
        touchAction: 'manipulation',
      }}
    >
      {editing ? (
        <input
          autoFocus
          aria-label={`Rename column ${displayName}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
            event.stopPropagation()
          }}
          style={{
            width: '100%',
            height: 40,
            boxSizing: 'border-box',
            padding: '0 6px',
            font: 'inherit',
            color: 'inherit',
            background: 'transparent',
            border: '1px solid currentColor',
            borderRadius: 4,
            outline: 'none',
          }}
        />
      ) : (
        displayName
      )}
    </span>
  )
}

interface ResultsGridProps {
  result: QueryResult | null
  /** Called when the user adds a calculated column via the formula helper. */
  onAddComputedColumn: (col: ComputedColumn) => void
  /** Opens the AI grid-edit dialog (undefined hides the button). */
  onOpenAiTransform?: () => void
  /** Restores the previous grid state; undefined hides the Revert button. */
  onRevertGrid?: () => void
  /** Drill-through conditions pushed from the Summary tab (empty = no filter). */
  drillFilters?: GridDrillFilter[]
  /** Clears the drill-through filter; undefined hides the banner's Clear button. */
  onClearDrill?: () => void
}

export default function ResultsGrid({
  result,
  onAddComputedColumn,
  onOpenAiTransform,
  onRevertGrid,
  drillFilters = [],
  onClearDrill,
}: ResultsGridProps) {
  const gridRef = useRef<AgGridReact>(null)
  const [copied, setCopied] = useState(false)
  /** User-chosen data kinds, keyed by column name. Overrides auto-detection. */
  const [columnKinds, setColumnKinds] = useState<Record<string, ColumnKind>>({})
  /** Renamed header labels, keyed by the original column name. Display only. */
  const [columnLabels, setColumnLabels] = useState<Record<string, string>>({})
  const [addColumnOpen, setAddColumnOpen] = useState(false)
  const [typesOpen, setTypesOpen] = useState(false)

  /** Does one row satisfy every drill-through condition? Uses the same
   *  ``groupingKey`` the Summary tab grouped by, so the match is exact. */
  const passesDrill = useCallback(
    (row: Record<string, unknown>) =>
      drillFilters.every((filter) =>
        filter.values.includes(groupingKey(row[filter.column], filter.grain)),
      ),
    [drillFilters],
  )

  /** Rows kept by the drill filter (used for the toolbar count + banner). */
  const drilledCount = useMemo(() => {
    if (!result) return 0
    if (drillFilters.length === 0) return result.rows.length
    return result.rows.filter(passesDrill).length
  }, [result, drillFilters, passesDrill])


  const handleKindChange = useCallback((name: string, kind: ColumnKind) => {
    setColumnKinds((prev) => (prev[name] === kind ? prev : { ...prev, [name]: kind }))
  }, [])

  const handleHeaderRename = useCallback((name: string, label: string) => {
    setColumnLabels((prev) => {
      const next = label.trim()
      // A blank label (or the original name) drops the override.
      if (!next || next === name) {
        if (!(name in prev)) return prev
        const cleared = { ...prev }
        delete cleared[name]
        return cleared
      }
      return prev[name] === next ? prev : { ...prev, [name]: next }
    })
  }, [])

  const columnDefs = useMemo<ColDef[]>(() => {
    if (!result) return []
    return result.columns.map((column) => {
      const kind =
        columnKinds[column.name] ?? detectColumnKind(column.name, column.type, result.rows)
      return {
        field: column.name,
        // Renaming only affects the visible label; `field` stays the data key.
        headerName: columnLabels[column.name] ?? column.name,
        sortable: true,
        resizable: true,
        filter: kind === 'number' ? 'agNumberColumnFilter' : 'agTextColumnFilter',
        type: kind === 'number' ? 'numericColumn' : undefined,
        valueFormatter: (params: ValueFormatterParams) => formatCellValue(params.value),
        minWidth: 130,
        headerComponentParams: {
          innerHeaderComponent: EditableHeader,
          innerHeaderComponentParams: {
            renameHeaderKey: column.name,
            onRenameHeader: handleHeaderRename,
          },
        },
      }
    })
  }, [result, columnKinds, columnLabels, handleHeaderRename])

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
      floatingFilter: false,
    }),
    [],
  )

  const handleGridReady = useCallback((params: GridReadyEvent) => {
    params.api.sizeColumnsToFit()
  }, [])

  const handleFirstDataRendered = useCallback(() => {
    const api = gridRef.current?.api
    // Only auto-fit on wider screens; on mobile the grid scrolls horizontally instead.
    if (api && window.innerWidth >= 768) api.sizeColumnsToFit()
  }, [])

  // Push drill-through changes into the grid so the visible rows refresh.
  useEffect(() => {
    gridRef.current?.api?.onFilterChanged()
  }, [drillFilters])

  const handleCopy = useCallback(async () => {
    if (!result || result.rows.length === 0) return
    // Build a TSV snapshot of the full result set and write it to the clipboard
    // directly — the grid clipboard API can silently fail depending on
    // selection state / focus, so copy from the raw data instead.
    const headers = result.columns.map((column) => column.name)
    const lines = [
      headers.join('\t'),
      ...result.rows.map((row) =>
        headers
          .map((header) => {
            const value = (row as Record<string, unknown>)[header]
            return value === null || value === undefined ? '' : String(value)
          })
          .join('\t'),
      ),
    ]
    const text = lines.join('\n')
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
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [result])

  if (!result) {
    return (
      <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
        <Typography color="text.secondary">Run a query to see results here.</Typography>
      </Box>
    )
  }

  const empty = result.rows.length === 0

  return (
    <Stack spacing={1.5} sx={{ width: '100%' }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Typography variant="body2" color="text.secondary">
          {drillFilters.length > 0
            ? `${drilledCount.toLocaleString()} of ${result.row_count.toLocaleString()} rows`
            : `${result.row_count.toLocaleString()} row${result.row_count === 1 ? '' : 's'}`}{' '}
          · {result.elapsed_ms.toLocaleString()} ms
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {onOpenAiTransform && (
            <Tooltip title="Describe a change and let AI write a Python script to update the grid">
              <Button
                size="small"
                variant="outlined"
                color="primary"
                startIcon={<AutoAwesomeIcon />}
                onClick={onOpenAiTransform}
                disabled={empty}
                sx={{ minHeight: 40 }}
              >
                AI edit
              </Button>
            </Tooltip>
          )}
          {onRevertGrid && (
            <Tooltip title="Restore the grid to the state before the last AI edit">
              <Button
                size="small"
                variant="outlined"
                color="warning"
                startIcon={<UndoIcon />}
                onClick={onRevertGrid}
                sx={{ minHeight: 40 }}
              >
                Revert
              </Button>
            </Tooltip>
          )}
          <Button
            size="small"
            variant="outlined"
            startIcon={<TuneIcon />}
            onClick={() => setTypesOpen(true)}
            disabled={empty}
            sx={{ minHeight: 40 }}
          >
            Data types
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FunctionsIcon />}
            onClick={() => setAddColumnOpen(true)}
            disabled={empty}
            sx={{ minHeight: 40 }}
          >
            Add column
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            onClick={handleCopy}
            disabled={empty}
            sx={{ minHeight: 40 }}
          >
            {copied ? 'Copied!' : 'Copy all'}
          </Button>
        </Stack>
      </Stack>

      {drillFilters.length > 0 && (
        <Alert
          severity="info"
          icon={<FilterAltIcon />}
          action={
            onClearDrill && (
              <Button
                size="small"
                color="inherit"
                startIcon={<CloseIcon />}
                onClick={onClearDrill}
                sx={{ minHeight: 40 }}
              >
                Clear
              </Button>
            )
          }
        >
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2">Drill-through:</Typography>
            {drillFilters.map((filter) => (
              <Chip
                key={filter.column}
                size="small"
                label={`${filter.column} = ${filter.values.map((v) => (v === '' ? '(blank)' : v)).join(', ')}`}
              />
            ))}
          </Stack>
        </Alert>
      )}

      {empty ? (
        <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
          <Typography color="text.secondary">The query returned no rows.</Typography>
        </Box>
      ) : (
        <Box className="ag-theme-quartz" sx={{ height: { xs: 420, md: 560 }, width: '100%' }}>
          <AgGridReact
            ref={gridRef}
            rowData={result.rows}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            headerHeight={52}
            rowSelection={{ mode: 'multiRow' }}
            cellSelection
            pagination
            paginationPageSize={25}
            paginationPageSizeSelector={PAGE_SIZE_OPTIONS}
            onGridReady={handleGridReady}
            onFirstDataRendered={handleFirstDataRendered}
            isExternalFilterPresent={() => drillFilters.length > 0}
            doesExternalFilterPass={(node) =>
              passesDrill((node.data ?? {}) as Record<string, unknown>)
            }
          />
        </Box>
      )}

      <AddColumnDialog
        open={addColumnOpen}
        columns={result.columns}
        rows={result.rows}
        existingNames={result.columns.map((c) => c.name)}
        onClose={() => setAddColumnOpen(false)}
        onAdd={onAddComputedColumn}
      />

      <ColumnTypesDialog
        open={typesOpen}
        columns={result.columns}
        rows={result.rows}
        kinds={columnKinds}
        onClose={() => setTypesOpen(false)}
        onKindChange={handleKindChange}
      />
    </Stack>
  )
}
