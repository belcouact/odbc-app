import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community'
import type {
  CellContextMenuEvent,
  ColDef,
  ColumnHeaderContextMenuEvent,
  ColumnState,
  GridApi,
  GridReadyEvent,
  ValueFormatterParams,
} from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-quartz.css'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BlockIcon from '@mui/icons-material/Block'
import ClearAllIcon from '@mui/icons-material/ClearAll'
import CloseIcon from '@mui/icons-material/Close'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff'
import FunctionsIcon from '@mui/icons-material/Functions'
import HelpOutlinedIcon from '@mui/icons-material/HelpOutlined'
import LowPriorityIcon from '@mui/icons-material/LowPriority'
import PushPinIcon from '@mui/icons-material/PushPin'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import StraightenIcon from '@mui/icons-material/Straighten'
import SwapVertIcon from '@mui/icons-material/SwapVert'
import TuneIcon from '@mui/icons-material/Tune'
import UndoIcon from '@mui/icons-material/Undo'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import type { GridDrillFilter, QueryResult } from '../types'
import { formatCellValue } from '../utils/format'
import { detectColumnKind, groupingKey, type ColumnKind } from '../utils/columns'
import type { ComputedColumn } from '../utils/formula'
import AddColumnDialog from './AddColumnDialog'
import ColumnTypesDialog from './ColumnTypesDialog'

// Register the full community feature set once (filters, pagination, clipboard, ...).
ModuleRegistry.registerModules([AllCommunityModule])

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

/** Which part of the grid the custom context menu was opened on. */
type MenuScope = 'cell' | 'header'

/** Everything the custom context menu can do. */
type MenuAction =
  | 'copyCell'
  | 'copyRow'
  | 'copySelected'
  | 'filterBy'
  | 'filterOut'
  | 'openFilter'
  | 'clearFilter'
  | 'clearAllFilters'
  | 'sortAsc'
  | 'sortDesc'
  | 'clearSort'
  | 'pinLeft'
  | 'pinRight'
  | 'unpin'
  | 'autosizeThis'
  | 'autosizeAll'
  | 'resetColumns'
  | 'hideColumn'
  | 'showAllColumns'

/** Live grid facts captured when the menu opens, to enable/disable its items. */
interface MenuFacts {
  sorted: boolean
  pinned: 'left' | 'right' | null
  filtered: boolean
  anyFilter: boolean
  canHide: boolean
  canShowAll: boolean
  selectedCount: number
}

/** State behind the custom context menu: where it opens and what it targets. */
interface ContextMenuState {
  /** Pointer position in client coordinates — the menu is anchored here. */
  mouseX: number
  mouseY: number
  /** Column the actions apply to. */
  colId: string
  scope: MenuScope
  /** Filter flavour of the column, so "filter by value" builds a valid model. */
  filterType: 'number' | 'text'
  /** Column/selection state as of the moment the menu opened. */
  facts: MenuFacts
  /** Cell value (cell scope only); drives the filter-by-value actions. */
  value?: unknown
  /** Row data (cell scope only); drives "Copy row". */
  row?: Record<string, unknown>
}

/** Writes text to the clipboard, with a fallback for restricted builds. */
async function writeToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}

/** One tab-separated line for a row, in the result's own column order. */
function rowToTsv(headers: string[], row: Record<string, unknown>) {
  return headers
    .map((header) => {
      const value = row[header]
      return value === null || value === undefined ? '' : String(value)
    })
    .join('\t')
}

/** A clipboard-ready TSV block: header row plus one line per row. Rows are
 *  separated with CRLF — Excel only starts a new row on "\r\n" and treats a
 *  lone "\n" as an in-cell line break (which collapses everything on paste). */
function toTsv(headers: string[], rows: Record<string, unknown>[]) {
  return [headers.join('\t'), ...rows.map((row) => rowToTsv(headers, row))].join('\r\n')
}

/** One feature line inside the toolbar's "what can I do" popover. */
function HelpRow({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
      <Box sx={{ display: 'flex', color: 'text.secondary', pt: 0.25 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {detail && (
          <Typography variant="caption" color="text.secondary">
            {detail}
          </Typography>
        )}
      </Box>
    </Stack>
  )
}

/** A separator between groups of items in the grid context menu. */
function MenuDivider() {
  // Menu renders a <ul>, so the divider needs to be a list item to stay valid.
  return <Divider component="li" sx={{ my: 0.5 }} />
}

/** One clickable row in the grid context menu. */
function ActionItem({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <MenuItem disabled={disabled} onClick={onClick} sx={{ minHeight: 40, gap: 1 }}>
      <ListItemIcon sx={{ minWidth: 0 }}>{icon}</ListItemIcon>
      <ListItemText>{label}</ListItemText>
    </MenuItem>
  )
}

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
  /** Wrapper around the grid; used to capture the right-click position early. */
  const gridWrapRef = useRef<HTMLDivElement | null>(null)
  const [copied, setCopied] = useState(false)
  /** User-chosen data kinds, keyed by column name. Overrides auto-detection. */
  const [columnKinds, setColumnKinds] = useState<Record<string, ColumnKind>>({})
  /** Renamed header labels, keyed by the original column name. Display only. */
  const [columnLabels, setColumnLabels] = useState<Record<string, string>>({})
  const [addColumnOpen, setAddColumnOpen] = useState(false)
  const [typesOpen, setTypesOpen] = useState(false)
  /** The custom right-click menu; null while it is closed. */
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  /** Anchor element for the toolbar's feature-help popover. */
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null)
  /** Latest pointer position. Captured in the capture phase, because AG Grid's
   *  own `cellContextMenu` callback fires before our bubble-phase handler. */
  const pointerRef = useRef({ x: 0, y: 0 })

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
    const headers = result.columns.map((column) => column.name)
    // A row selection narrows the copy to those rows; with nothing selected the
    // whole result is copied. Build the TSV snapshot from the raw data and write
    // it to the clipboard directly — the grid clipboard API can silently fail
    // depending on selection state / focus.
    const selected = gridRef.current?.api?.getSelectedNodes() ?? []
    const rows =
      selected.length > 0
        ? selected.map((node) => (node.data ?? {}) as Record<string, unknown>)
        : result.rows
    await writeToClipboard(toTsv(headers, rows))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [result])

  // AG Grid dispatches its own `cellContextMenu` handler before React's
  // bubble-phase listeners run, so the right-click position has to be recorded
  // while the event is still travelling down (capture phase).
  useEffect(() => {
    const element = gridWrapRef.current
    if (!element) return
    const track = (event: MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
    }
    element.addEventListener('contextmenu', track, true)
    return () => element.removeEventListener('contextmenu', track, true)
  }, [result])

  /** Live grid facts captured when the menu opens, to enable/disable its items. */
  const readMenuFacts = useCallback((colId: string): MenuFacts => {
    const api = gridRef.current?.api
    const columns = api?.getColumns() ?? []
    const visible = columns.filter((column) => column.isVisible())
    const state = api?.getColumnState().find((column) => column.colId === colId)
    return {
      sorted: Boolean(state?.sort),
      pinned: state?.pinned === 'left' || state?.pinned === 'right' ? state.pinned : null,
      filtered: api?.getColumnFilterModel(colId) != null,
      anyFilter: Object.keys(api?.getFilterModel() ?? {}).length > 0,
      canHide: visible.length > 1,
      canShowAll: visible.length < columns.length,
      selectedCount: api?.getSelectedNodes().length ?? 0,
    }
  }, [])

  /** Opens the context menu for a right-clicked body cell. */
  const handleCellContextMenu = useCallback(
    (event: CellContextMenuEvent) => {
      const { column, value, data } = event
      if (!column) return
      const filter = column.getColDef().filter
      const colId = column.getColId()
      setMenu({
        mouseX: pointerRef.current.x,
        mouseY: pointerRef.current.y,
        colId,
        scope: 'cell',
        filterType: typeof filter === 'string' && filter.includes('Number') ? 'number' : 'text',
        facts: readMenuFacts(colId),
        value,
        row: (data ?? {}) as Record<string, unknown>,
      })
    },
    [readMenuFacts],
  )

  /** Opens the context menu for a right-clicked column header. */
  const handleHeaderContextMenu = useCallback(
    (event: ColumnHeaderContextMenuEvent) => {
      const column = event.column
      // Column groups are unused in this grid, but the event type allows them.
      if (!('getColId' in column)) return
      const filter = column.getColDef().filter
      const colId = column.getColId()
      setMenu({
        mouseX: pointerRef.current.x,
        mouseY: pointerRef.current.y,
        colId,
        scope: 'header',
        filterType: typeof filter === 'string' && filter.includes('Number') ? 'number' : 'text',
        facts: readMenuFacts(colId),
      })
    },
    [readMenuFacts],
  )

  /** Runs one context-menu action against the live grid API. */
  const runMenuAction = useCallback(
    async (action: MenuAction) => {
      const api = gridRef.current?.api
      const target = menu
      // Close first: filter popups and dialogs expect a clean UI state.
      setMenu(null)
      if (!api || !target || !result) return
      const { colId } = target
      const headers = result.columns.map((column) => column.name)

      switch (action) {
        case 'copyCell':
          await writeToClipboard(formatCellValue(target.value))
          break
        case 'copyRow':
          if (target.row) await writeToClipboard(rowToTsv(headers, target.row))
          break
        case 'copySelected': {
          const selected = api
            .getSelectedNodes()
            .map((node) => (node.data ?? {}) as Record<string, unknown>)
          const rows = selected.length > 0 ? selected : target.row ? [target.row] : []
          await writeToClipboard(toTsv(headers, rows))
          break
        }
        case 'filterBy':
        case 'filterOut':
          await api.setColumnFilterModel(colId, {
            filterType: target.filterType,
            type: action === 'filterBy' ? 'equals' : 'notEqual',
            filter:
              target.filterType === 'number'
                ? target.value
                : formatCellValue(target.value),
          })
          api.onFilterChanged()
          break
        case 'openFilter':
          api.showColumnFilter(colId)
          break
        case 'clearFilter':
          await api.setColumnFilterModel(colId, null)
          api.onFilterChanged()
          break
        case 'clearAllFilters':
          api.setFilterModel(null)
          api.onFilterChanged()
          break
        case 'sortAsc':
        case 'sortDesc':
          // Sorts this column and drops any other column's sort, matching the
          // behaviour of the built-in column menu.
          api.applyColumnState({
            state: [{ colId, sort: action === 'sortAsc' ? 'asc' : 'desc' }],
            defaultState: { sort: null },
          })
          break
        case 'clearSort':
          api.applyColumnState({ state: [{ colId, sort: null }] })
          break
        case 'pinLeft':
        case 'pinRight':
          api.applyColumnState({
            state: [{ colId, pinned: action === 'pinLeft' ? 'left' : 'right' }],
          })
          break
        case 'unpin':
          api.applyColumnState({ state: [{ colId, pinned: null }] })
          break
        case 'autosizeThis':
          api.autoSizeColumns([colId])
          break
        case 'autosizeAll':
          api.autoSizeAllColumns()
          break
        case 'resetColumns':
          // Order, width, pinning and sorting back to their defaults.
          api.resetColumnState()
          break
        case 'hideColumn':
          api.setColumnsVisible([colId], false)
          break
        case 'showAllColumns':
          api.setColumnsVisible(
            (api.getColumns() ?? []).map((column) => column.getColId()),
            true,
          )
          break
      }
    },
    [menu, result],
  )

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
          <Tooltip title="See everything this table can do">
            <IconButton
              size="small"
              aria-label="Table features"
              onClick={(event) => setHelpAnchor(event.currentTarget)}
              sx={{ width: 40, height: 40 }}
            >
              <HelpOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
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
            {copied ? 'Copied!' : 'Copy'}
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
        <Box
          ref={gridWrapRef}
          className="ag-theme-quartz"
          sx={{ height: { xs: 420, md: 560 }, width: '100%' }}
        >
          <AgGridReact
            ref={gridRef}
            rowData={result.rows}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            headerHeight={52}
            rowSelection={{ mode: 'multiRow' }}
            cellSelection
            // The grid's own context menu is Enterprise-only, so the browser
            // menu is suppressed and replaced by the MUI menu below.
            suppressContextMenu
            preventDefaultOnContextMenu
            onCellContextMenu={handleCellContextMenu}
            onColumnHeaderContextMenu={handleHeaderContextMenu}
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

      {/* Right-click menu. AG Grid Community ships no context menu, so this
          covers its Enterprise column menu items plus copy / filter helpers. */}
      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={{ top: menu?.mouseY ?? 0, left: menu?.mouseX ?? 0 }}
        slotProps={{ paper: { sx: { minWidth: 248 } } }}
      >
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<ContentCopyIcon fontSize="small" />}
            label="Copy cell"
            onClick={() => void runMenuAction('copyCell')}
          />
        )}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<ContentCopyIcon fontSize="small" />}
            label="Copy row"
            onClick={() => void runMenuAction('copyRow')}
          />
        )}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<ContentCopyIcon fontSize="small" />}
            label={
              menu && menu.facts.selectedCount > 1
                ? `Copy ${menu.facts.selectedCount} selected rows`
                : 'Copy selected rows'
            }
            disabled={!menu || menu.facts.selectedCount === 0}
            onClick={() => void runMenuAction('copySelected')}
          />
        )}
        {menu?.scope === 'cell' && <MenuDivider />}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<FilterAltIcon fontSize="small" />}
            label="Filter by this value"
            onClick={() => void runMenuAction('filterBy')}
          />
        )}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<FilterAltOffIcon fontSize="small" />}
            label="Filter out this value"
            onClick={() => void runMenuAction('filterOut')}
          />
        )}
        <ActionItem
          icon={<FilterAltIcon fontSize="small" />}
          label="Open filter"
          onClick={() => void runMenuAction('openFilter')}
        />
        <ActionItem
          icon={<FilterAltOffIcon fontSize="small" />}
          label="Clear this column's filter"
          disabled={!menu?.facts.filtered}
          onClick={() => void runMenuAction('clearFilter')}
        />
        <ActionItem
          icon={<ClearAllIcon fontSize="small" />}
          label="Clear all filters"
          disabled={!menu?.facts.anyFilter}
          onClick={() => void runMenuAction('clearAllFilters')}
        />
        <MenuDivider />
        <ActionItem
          icon={<ArrowUpwardIcon fontSize="small" />}
          label="Sort ascending"
          onClick={() => void runMenuAction('sortAsc')}
        />
        <ActionItem
          icon={<ArrowDownwardIcon fontSize="small" />}
          label="Sort descending"
          onClick={() => void runMenuAction('sortDesc')}
        />
        <ActionItem
          icon={<SwapVertIcon fontSize="small" />}
          label="Clear sort"
          disabled={!menu?.facts.sorted}
          onClick={() => void runMenuAction('clearSort')}
        />
        <MenuDivider />
        <ActionItem
          icon={<PushPinIcon fontSize="small" />}
          label="Pin column left"
          disabled={menu?.facts.pinned === 'left'}
          onClick={() => void runMenuAction('pinLeft')}
        />
        <ActionItem
          icon={<PushPinIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />}
          label="Pin column right"
          disabled={menu?.facts.pinned === 'right'}
          onClick={() => void runMenuAction('pinRight')}
        />
        <ActionItem
          icon={<BlockIcon fontSize="small" />}
          label="Unpin column"
          disabled={!menu?.facts.pinned}
          onClick={() => void runMenuAction('unpin')}
        />
        <MenuDivider />
        <ActionItem
          icon={<StraightenIcon fontSize="small" />}
          label="Autosize this column"
          onClick={() => void runMenuAction('autosizeThis')}
        />
        <ActionItem
          icon={<StraightenIcon fontSize="small" />}
          label="Autosize all columns"
          onClick={() => void runMenuAction('autosizeAll')}
        />
        <ActionItem
          icon={<RestartAltIcon fontSize="small" />}
          label="Reset columns"
          onClick={() => void runMenuAction('resetColumns')}
        />
        <MenuDivider />
        <ActionItem
          icon={<VisibilityOffIcon fontSize="small" />}
          label="Hide this column"
          disabled={!menu?.facts.canHide}
          onClick={() => void runMenuAction('hideColumn')}
        />
        <ActionItem
          icon={<VisibilityIcon fontSize="small" />}
          label="Show all columns"
          disabled={!menu?.facts.canShowAll}
          onClick={() => void runMenuAction('showAllColumns')}
        />
      </Menu>

      <Popover
        open={helpAnchor !== null}
        anchorEl={helpAnchor}
        onClose={() => setHelpAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { p: 2, width: 420, maxWidth: '92vw', maxHeight: '70vh' } },
        }}
      >
        <Stack spacing={1.25}>
          <Box>
            <Typography variant="subtitle2">Everything this table can do</Typography>
            <Typography variant="caption" color="text.secondary">
              Right-click a cell or a column header for the full menu.
            </Typography>
          </Box>
          <Divider />
          <HelpRow
            icon={<ContentCopyIcon fontSize="small" />}
            title="Copy"
            detail="Copy cell / row / selected rows from the right-click menu. The Copy button copies the rows you selected, or the whole result when nothing is selected — paste it straight into Excel."
          />
          <HelpRow
            icon={<SwapVertIcon fontSize="small" />}
            title="Sort"
            detail="Click a header to sort, or use Sort ascending / descending / Clear sort in the right-click menu."
          />
          <HelpRow
            icon={<LowPriorityIcon fontSize="small" />}
            title="Sort by several columns"
            detail="Hold Shift and click more headers to add them to the sort. Numbered badges on the headers show the order; click a header again to flip or extend its direction."
          />
          <HelpRow
            icon={<FilterAltIcon fontSize="small" />}
            title="Filter"
            detail="Filter by or out a single value, open the filter, or clear one / all filters from the right-click menu."
          />
          <HelpRow
            icon={<PushPinIcon fontSize="small" />}
            title="Columns"
            detail="Pin left or right, autosize one or all columns, reset columns, and hide or show columns — all from the right-click menu. Drag between headers to resize or reorder."
          />
          <HelpRow
            icon={<TuneIcon fontSize="small" />}
            title="Rename a column"
            detail="Double-click any column header."
          />
          <HelpRow
            icon={<StraightenIcon fontSize="small" />}
            title="Data types"
            detail="The Data types button switches a column between text, number and date so sorting and filters behave correctly."
          />
          <HelpRow
            icon={<FunctionsIcon fontSize="small" />}
            title="Add column"
            detail="Build a calculated column with a formula over the existing columns."
          />
          {onOpenAiTransform && (
            <HelpRow
              icon={<AutoAwesomeIcon fontSize="small" />}
              title="AI edit"
              detail="Describe a change in plain English and AI writes the Python script that updates this table."
            />
          )}
          {onRevertGrid && (
            <HelpRow
              icon={<UndoIcon fontSize="small" />}
              title="Revert"
              detail="Undo the last AI edit and restore the previous table."
            />
          )}
          <HelpRow
            icon={<HelpOutlinedIcon fontSize="small" />}
            title="Selection"
            detail="Click a row to select it; ctrl/cmd-click or drag to select several, then copy them in one go."
          />
        </Stack>
      </Popover>
    </Stack>
  )
}
