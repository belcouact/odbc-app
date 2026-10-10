import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import BlockIcon from '@mui/icons-material/Block'
import ClearAllIcon from '@mui/icons-material/ClearAll'
import CloseIcon from '@mui/icons-material/Close'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import ContentPasteIcon from '@mui/icons-material/ContentPaste'
import EditIcon from '@mui/icons-material/Edit'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff'
import HelpOutlinedIcon from '@mui/icons-material/HelpOutlined'
import LowPriorityIcon from '@mui/icons-material/LowPriority'
import PushPinIcon from '@mui/icons-material/PushPin'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import SaveIcon from '@mui/icons-material/Save'
import SearchIcon from '@mui/icons-material/Search'
import StraightenIcon from '@mui/icons-material/Straighten'
import SwapVertIcon from '@mui/icons-material/SwapVert'
import TuneIcon from '@mui/icons-material/Tune'
import UndoIcon from '@mui/icons-material/Undo'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import { useTranslation } from 'react-i18next'
import type { GridDrillFilter, QueryResult } from '../types'
import { AG_GRID_LOCALE_ZH } from '../i18n/agGridZh'
import { formatCellValue } from '../utils/format'
import { detectColumnKind, groupingKey, type ColumnKind } from '../utils/columns'
import type { ComputedColumn } from '../utils/formula'
import GridToolsDialog, { type GridToolsTab } from './GridToolsDialog'

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

/** Parse a pasted TSV block into a grid of strings. Handles Excel quoting:
 *  cells containing tabs, newlines or quotes come wrapped in "..." with ""
 *  escapes, so a quoted line break is cell data rather than a row break. */
function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const pushCell = () => {
    row.push(cell)
    cell = ''
  }
  const pushRow = () => {
    pushCell()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === '\t') {
      pushCell()
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1
      pushRow()
    } else if (ch === '\n') {
      pushRow()
    } else {
      cell += ch
    }
  }
  // Trailing content without a final line break still forms a row, and a
  // block that is empty overall still yields one empty row for the caller.
  if (cell !== '' || row.length > 0 || rows.length === 0) pushRow()
  return rows
}

/** Dedupe raw column names: blank cells become "Column N", duplicates get
 *  " (2)"-style suffixes. Order and length are preserved. */
function dedupeColumnNames(bases: string[]): string[] {
  const seen = new Map<string, number>()
  return bases.map((base, index) => {
    const name = base.trim() || `Column ${index + 1}`
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name} (${count + 1})`
  })
}

/** Infer a column type from pasted values: all-numeric → number, all
 *  ISO-looking → date, otherwise text. Blank cells are ignored. */
function inferColumnType(values: string[]): string {
  const filled = values.filter((value) => value !== '')
  if (filled.length > 0 && filled.every((v) => Number.isFinite(Number(v)))) return 'number'
  if (filled.length > 0 && filled.every((v) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v))) {
    return 'date'
  }
  return 'text'
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
  const { t } = useTranslation('grid')
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
      title={renameHeaderKey ? t('header.renameTooltip', { name: displayName }) : displayName}
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
          aria-label={t('header.renameAria', { name: displayName })}
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
  /** Runs an AI transform on the current grid rows (undefined hides the
   *  AI edit tab in the Edit grid window). */
  onAiTransformApply?: (
    rows: Record<string, unknown>[],
    columns: { name: string; type: string }[],
    log: string,
  ) => void
  /** Restores the previous grid state; undefined hides the Revert button. */
  onRevertGrid?: () => void
  /** Drill-through conditions pushed from the Summary tab (empty = no filter). */
  drillFilters?: GridDrillFilter[]
  /** Clears the drill-through filter; undefined hides the banner's Clear button. */
  onClearDrill?: () => void
  /** Applies clipboard-pasted rows to the grid data. When a paste creates a
   *  brand-new table (no query results yet), ``columns`` carries the fresh
   *  column definitions. Undefined hides nothing — the Paste button now lives
   *  in the page's results header, which stays mounted without a grid. */
  onRowsPasted?: (
    rows: Record<string, unknown>[],
    columns?: { name: string; type: string }[],
  ) => void
  /** Raises a column-type override (Column Types dialog) to the page, which
   *  writes it into the result so the chart builders and summary tab see the
   *  type change in real time. */
  onColumnTypeChange?: (name: string, kind: ColumnKind) => void
  /** Opens the page's save-to-warehouse dialog; when undefined the feature-help
   *  popover drops its "Save data" entry. The button itself lives in the page's
   *  results header, alongside the export actions. */
  onSaveToWarehouse?: () => void
}

/** Commands the page toolbar can invoke on the grid from outside. */
export interface ResultsGridHandle {
  /** Opens the paste-from-clipboard dialog (works with no grid mounted). */
  openPasteDialog: () => void
  /** Opens the "Edit grid" tools dialog (AI transform / data types / add column). */
  openTools: () => void
  /** Opens the feature-help popover anchored to the given element. */
  openHelp: (anchor: HTMLElement | null) => void
  /** Copies the selection (or the whole result) as TSV. Resolves true when rows
   *  were copied, so the caller can flash "Copied!". */
  copySelection: () => Promise<boolean>
}

const ResultsGrid = forwardRef<ResultsGridHandle, ResultsGridProps>(function ResultsGrid({
  result,
  onAddComputedColumn,
  onAiTransformApply,
  onRevertGrid,
  drillFilters = [],
  onClearDrill,
  onRowsPasted,
  onColumnTypeChange,
  onSaveToWarehouse,
}: ResultsGridProps,
  ref,
) {
  const gridRef = useRef<AgGridReact>(null)
  // Subscribes to language changes so the grid rebuilds with the matching
  // AG Grid localeText (localeText is read once, at grid creation).
  const { t, i18n } = useTranslation('grid')
  /** Wrapper around the grid; used to capture the right-click position early. */
  const gridWrapRef = useRef<HTMLDivElement | null>(null)
  /** Last result object the entrance effect saw; reference-equality is the
   *  "is this a fresh query result?" signal (grid edits mutate in place). */
  const prevResultRef = useRef<QueryResult | null>(null)
  /** Briefly true after a new result arrives so rows replay a staggered fade. */
  const [rowsEntering, setRowsEntering] = useState(false)
  useEffect(() => {
    if (!result || result === prevResultRef.current) return
    prevResultRef.current = result
    setRowsEntering(true)
    // Longest stagger (300ms) + animation (300ms) + small buffer.
    const timer = window.setTimeout(() => setRowsEntering(false), 900)
    return () => window.clearTimeout(timer)
  }, [result])
  /** User-chosen data kinds, keyed by column name. Overrides auto-detection. */
  const [columnKinds, setColumnKinds] = useState<Record<string, ColumnKind>>({})
  /** Renamed header labels, keyed by the original column name. Display only. */
  const [columnLabels, setColumnLabels] = useState<Record<string, string>>({})
  /** Combined editing window (AI edit / Data types / Add column tabs). */
  const [toolsOpen, setToolsOpen] = useState(false)
  /** Last tool tab used, so re-opening lands where the user left off. */
  const [toolsTab, setToolsTab] = useState<GridToolsTab>('ai')
  /** The custom right-click menu; null while it is closed. */
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  /** Anchor element for the toolbar's feature-help popover. */
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null)
  /** Paste-from-clipboard dialog (the touch/restricted-clipboard fallback).
   *  Also opened from the results header via `ResultsGridHandle`, so it works
   *  before any query has run — the paste then creates a brand-new table. */
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteDraft, setPasteDraft] = useState('')
  /** Does the pasted block's first row hold column headers? Pre-filled by
   *  auto-detection while the user edits the draft; their manual toggle wins. */
  const [pasteSkipHeader, setPasteSkipHeader] = useState(false)
  /** Flips true the moment the user toggles the header checkbox themselves. */
  const pasteHeaderTouched = useRef(false)
  /** Transient feedback after a paste, e.g. "Pasted 12 row(s) · 3 new". */
  const [pasteNotice, setPasteNotice] = useState('')
  /** Timer id of the running paste-notice timeout, so a new paste restarts it. */
  const pasteNoticeTimer = useRef<number | undefined>(undefined)
  /** Global search term, applied as AG Grid's quick filter across every column. */
  const [globalSearch, setGlobalSearch] = useState('')
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


  const handleKindChange = useCallback(
    (name: string, kind: ColumnKind) => {
      setColumnKinds((prev) => (prev[name] === kind ? prev : { ...prev, [name]: kind }))
      // Write the override through to the page's result as the canonical kind
      // string (detectColumnKind recognizes it), so the chart builders and the
      // summary tab reflect the type change in real time.
      onColumnTypeChange?.(name, kind)
    },
    [onColumnTypeChange],
  )

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

  /** Copies the grid (selection, or all rows) as TSV. Returns true when rows
   *  were copied, so the results-header button can flash "Copied!". */
  const handleCopy = useCallback(async (): Promise<boolean> => {
    if (!result || result.rows.length === 0) return false
    const headers = result.columns.map((column) => column.name)
    // A row selection narrows the copy to those rows; with nothing selected the
    // whole result is copied — except in drill-through mode, where only the
    // rows surviving the drill filter go out. Build the TSV snapshot from the
    // raw data and write it to the clipboard directly — the grid clipboard API
    // can silently fail depending on selection state / focus.
    const selected = gridRef.current?.api?.getSelectedNodes() ?? []
    const rows =
      selected.length > 0
        ? selected.map((node) => (node.data ?? {}) as Record<string, unknown>)
        : drillFilters.length > 0
          ? result.rows.filter(passesDrill)
          : result.rows
    await writeToClipboard(toTsv(headers, rows))
    return true
  }, [result, drillFilters.length, passesDrill])

  /** Shows a transient "Pasted …" line next to the row count. */
  const showPasteNotice = useCallback((message: string) => {
    setPasteNotice(message)
    window.clearTimeout(pasteNoticeTimer.current)
    pasteNoticeTimer.current = window.setTimeout(() => setPasteNotice(''), 4000)
  }, [])

  /** Lets the page's results header drive grid-only actions (Paste / Edit grid
   *  / feature help / Copy) from outside this component. */
  useImperativeHandle(
    ref,
    () => ({
      openPasteDialog: () => {
        setPasteDraft('')
        setPasteSkipHeader(false)
        pasteHeaderTouched.current = false
        setPasteOpen(true)
      },
      openTools: () => setToolsOpen(true),
      openHelp: (anchor) => setHelpAnchor(anchor),
      copySelection: () => handleCopy(),
    }),
    [handleCopy],
  )

  /** Draft edits auto-set the header checkbox until the user overrides it:
   *  with a grid, on when the first row matches the column headers; without
   *  one, on by default — an Excel copy made to start a table includes them. */
  const handlePasteDraftChange = useCallback(
    (value: string) => {
      setPasteDraft(value)
      if (pasteHeaderTouched.current) return
      const block = parseTsv(value)
      if (block.length === 0 || block.every((row) => row.every((cell) => cell.trim() === ''))) {
        return
      }
      if (!result) {
        setPasteSkipHeader(true)
        return
      }
      const api = gridRef.current?.api
      const displayedColumns = (api?.getAllDisplayedColumns() ?? []).filter(
        (column) => column.getColDef().field != null,
      )
      const names =
        displayedColumns.length > 0
          ? displayedColumns.map((column) => column.getColDef().field as string)
          : result.columns.map((column) => column.name)
      const first = block[0]
      const hits = first.reduce((acc, cell, index) => {
        const name = names[index]
        if (!name) return acc
        const label = columnLabels[name]
        const lower = cell.trim().toLowerCase()
        return lower === name.toLowerCase() || (label != null && lower === label.toLowerCase())
          ? acc + 1
          : acc
      }, 0)
      const matched = first.length >= 2 ? hits / first.length >= 0.6 : hits === 1
      // The dialog's paste replaces the table, so a self-evident header row —
      // every cell non-empty text, sitting above rows with numeric values —
      // is auto-checked even when its names differ from the current columns:
      // a replacing paste with new headers defines a brand-new column set.
      const dataBelow = block.slice(1)
      const headerish =
        first.length >= 2 &&
        dataBelow.length > 0 &&
        first.every((cell) => {
          const value = cell.trim()
          return (
            value !== '' && !Number.isFinite(Number(value)) && !/^\d{4}-\d{2}-\d{2}/.test(value)
          )
        }) &&
        dataBelow.some((row) =>
          row.some((cell) => {
            const value = cell.trim()
            return value !== '' && Number.isFinite(Number(value))
          }),
        )
      setPasteSkipHeader(matched || headerish)
    },
    [result, columnLabels],
  )

  /** Merges a pasted TSV block into the grid data, Excel-style: the block
   *  fills cells starting at the focused cell (top-left when nothing is
   *  focused), and pastes that extend past the last row append new rows.
   *  Blank rows are dropped. Header handling: ``options.skipHeader`` (the
   *  Paste dialog's checkbox) wins when given; the Ctrl+V path instead skips
   *  a first row that looks like the column headers, so a round-trip copy of
   *  this grid pastes back cleanly. With ``options.replace`` (the Paste
   *  dialog) the existing rows are cleared first — the block becomes the
   *  whole table: with a header row, the pasted names become the new column
   *  headers; without one, the grid's leading column names are kept. With no
   *  query results at all, the paste creates a brand-new table: the header
   *  row (when enabled) names the columns, otherwise generic "Column N"
   *  names are generated. */
  const applyPastedText = useCallback(
    (text: string, options?: { skipHeader?: boolean; replace?: boolean }) => {
      if (!onRowsPasted) return
      let block = parseTsv(text)
      // Blank rows — empty lines or Excel's trailing selection rows — are
      // never meaningful data. Drop them up front and report how many.
      const emptySkipped = block.filter((row) => row.every((cell) => cell.trim() === '')).length
      if (emptySkipped > 0) {
        block = block.filter((row) => row.some((cell) => cell.trim() !== ''))
      }
      if (block.length === 0) {
        if (emptySkipped > 0) showPasteNotice(t('paste.nothingEmpty'))
        return
      }

      // No grid yet: build a table from scratch. Column count comes from the
      // widest pasted row; names from the header row when enabled (deduped),
      // else "Column N". Types are inferred: all-numeric → number, all
      // ISO-looking → date, otherwise text.
      if (!result) {
        const width = block.reduce((w, row) => Math.max(w, row.length), 0)
        const useHeader = options?.skipHeader === true
        const headerRow = useHeader ? block[0] : null
        const freshRows = useHeader ? block.slice(1) : block
        if (width === 0 || freshRows.length === 0) {
          showPasteNotice(
            width === 0
              ? t('paste.noColumns')
              : t('paste.headerOnlyAddRows'),
          )
          return
        }
        const names = dedupeColumnNames(
          Array.from({ length: width }, (_, index) => headerRow?.[index] ?? ''),
        )
        const columns = names.map((name, index) => ({
          name,
          type: inferColumnType(freshRows.map((row) => (row[index] ?? '').trim())),
        }))
        const rows = freshRows.map((row) =>
          Object.fromEntries(
            columns.map((column, index) => {
              const raw = (row[index] ?? '').trim()
              const value =
                column.type === 'number' && raw !== '' && Number.isFinite(Number(raw))
                  ? Number(raw)
                  : raw
              return [column.name, value]
            }),
          ),
        )
        onRowsPasted(rows, columns)
        const parts = [
          t('paste.rowsColumns', { rows: rows.length, columns: columns.length }),
          ...(emptySkipped > 0 ? [t('paste.emptySkipped', { count: emptySkipped })] : []),
        ]
        showPasteNotice(t('paste.resultNewTable', { summary: parts.join(' · ') }))
        return
      }

      const api = gridRef.current?.api

      // Column order comes from the live grid when it is mounted; an empty
      // result renders no grid, so the Paste dialog falls back to the raw
      // column list (every pasted row is then appended). Non-data columns
      // (e.g. the row-selection column) have no field and must be skipped or
      // the whole paste would shift one column to the right.
      const displayedColumns = (api?.getAllDisplayedColumns() ?? []).filter(
        (column) => column.getColDef().field != null,
      )
      const columnNames = displayedColumns.map((column) => column.getColDef().field as string)
      const names = columnNames.length > 0 ? columnNames : result.columns.map((c) => c.name)

      // The Paste dialog replaces the whole table: clear the existing rows and
      // rebuild from the top-left — every pasted row lands fresh and grid
      // columns without a pasted value become blank. The Ctrl+V path keeps the
      // Excel-style fill-from-focused-cell merge.
      const replaceMode = options?.replace === true

      // Start cell: the grid's focused cell, else the cell focused in the DOM
      // (AG Grid only tracks real mouse/keyboard focus), else the top-left.
      // A replacing paste always starts at the top-left, so skip the lookup.
      const focused = replaceMode ? null : (api?.getFocusedCell() ?? null)
      let startColIndex = focused?.column
        ? displayedColumns.findIndex((column) => column.getColId() === focused.column.getColId())
        : -1
      let rowStart = focused?.rowIndex ?? -1
      if (startColIndex < 0 || rowStart < 0) {
        const cell = document.activeElement?.closest('.ag-cell') as HTMLElement | null
        const rowEl = cell?.closest('.ag-row') as HTMLElement | null
        if (cell && rowEl) {
          if (startColIndex < 0) {
            const colId = cell.getAttribute('col-id')
            const idx = colId ? displayedColumns.findIndex((c) => c.getColId() === colId) : -1
            if (idx >= 0) startColIndex = idx
          }
          if (rowStart < 0) {
            const parsed = Number(rowEl.getAttribute('row-index'))
            if (Number.isFinite(parsed) && parsed >= 0) rowStart = parsed
          }
        }
      }
      const colStart = startColIndex >= 0 ? startColIndex : 0
      const startRow = Math.max(0, rowStart)

      // Rows in display (filter + sort) order, so a focused cell's rowIndex
      // maps onto this list. Node enumeration can come back short on large
      // paginated grids, so only trust it when it accounts for every row —
      // otherwise fall back to result.rows order. Either way the merge starts
      // from the full dataset, so pasting can never drop untouched rows.
      // A replacing paste starts from an empty row set, so every pasted row
      // is built fresh (the existing rows are discarded).
      const displayOrder: Record<string, unknown>[] = []
      if (!replaceMode) {
        api?.forEachNodeAfterFilterAndSort((node) => {
          if (node.data) displayOrder.push(node.data as Record<string, unknown>)
        })
      }
      const rowSource = replaceMode
        ? []
        : displayOrder.length === result.rows.length
          ? displayOrder
          : result.rows

      const labels = (index: number) => {
        const name = names[colStart + index]
        if (!name) return []
        const label = columnLabels[name]
        return label ? [label.toLowerCase(), name.toLowerCase()] : [name.toLowerCase()]
      }

      // Header detection: at least 60% of the first pasted row (min 2 cells,
      // or an exact single-column match) equals the target column's name. The
      // dialog's checkbox (``options.skipHeader``) wins when given — checked
      // drops the first row, unchecked pastes it as data; the Ctrl+V path
      // passes no option and keeps the auto-detection.
      const first = block[0]
      const headerHits = first.reduce(
        (hits, cell, index) => (labels(index).includes(cell.trim().toLowerCase()) ? hits + 1 : hits),
        0,
      )
      const looksLikeHeader =
        colStart === 0 &&
        (first.length >= 2 ? headerHits / first.length >= 0.6 : headerHits === 1)
      const skipHeader = options?.skipHeader ?? looksLikeHeader
      const dataRows = skipHeader ? block.slice(1) : block
      if (dataRows.length === 0) {
        showPasteNotice(t('paste.headerOnlyNothing'))
        return
      }

      // A replacing paste (the Paste dialog) rebuilds the whole table from the
      // block. When the block includes its header row, the pasted names become
      // the new column headers — the old headers do not survive the replace. A
      // data-only block keeps the grid's column names, with "Column N" fill-ins
      // for pasted columns beyond the grid's width.
      if (replaceMode) {
        const width = block.reduce((w, row) => Math.max(w, row.length), 0)
        const headerRow = skipHeader ? first : null
        const baseNames = Array.from({ length: width }, (_, index) =>
          headerRow ? (headerRow[index] ?? '') : (names[index] ?? `Column ${index + 1}`),
        )
        const existingTypes = new Map(result.columns.map((column) => [column.name, column.type]))
        const columns = dedupeColumnNames(baseNames).map((name, index) => {
          if (!headerRow && index < names.length) {
            const adopted = existingTypes.get(names[index])
            if (adopted) return { name, type: adopted }
          }
          return {
            name,
            type: inferColumnType(dataRows.map((row) => (row[index] ?? '').trim())),
          }
        })
        const rows = dataRows.map((row) =>
          Object.fromEntries(
            columns.map((column, index) => {
              const raw = (row[index] ?? '').trim()
              const value =
                column.type === 'number' && raw !== '' && Number.isFinite(Number(raw))
                  ? Number(raw)
                  : raw
              return [column.name, value]
            }),
          ),
        )
        onRowsPasted(rows, columns)
        const parts = [
          t('paste.rowsColumns', { rows: rows.length, columns: columns.length }),
          ...(emptySkipped > 0 ? [t('paste.emptySkipped', { count: emptySkipped })] : []),
        ]
        showPasteNotice(t('paste.resultTableReplaced', { summary: parts.join(' · ') }))
        return
      }

      // Number-kind columns accept "12.5" as a number so filters and charts
      // treat the pasted value like the rest of the column.
      const columnTypes = new Map(result.columns.map((column) => [column.name, column.type]))
      const kindCache = new Map<string, ColumnKind>()
      const kindOf = (name: string): ColumnKind => {
        const cached = kindCache.get(name)
        if (cached) return cached
        const kind = columnKinds[name] ?? detectColumnKind(name, columnTypes.get(name) ?? '', result.rows)
        kindCache.set(name, kind)
        return kind
      }

      const builtRows: Record<string, unknown>[] = rowSource.slice()
      let appended = 0
      let skippedCols = 0
      for (let r = 0; r < dataRows.length; r += 1) {
        const idx = startRow + r
        if (idx < rowSource.length) {
          builtRows[idx] = { ...rowSource[idx] }
        } else {
          builtRows[idx] = Object.fromEntries(result.columns.map((column) => [column.name, '']))
          appended += 1
        }
        const cells = dataRows[r]
        for (let c = 0; c < cells.length; c += 1) {
          const name = names[colStart + c]
          if (!name) {
            skippedCols = Math.max(skippedCols, cells.length - c)
            break
          }
          const raw = cells[c]
          if (kindOf(name) === 'number') {
            const trimmed = raw.trim()
            builtRows[idx][name] =
              trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed
          } else {
            builtRows[idx][name] = raw
          }
        }
      }

      onRowsPasted(builtRows)
      const parts = [t('paste.rowsPasted', { count: dataRows.length })]
      if (replaceMode) parts.push(t('paste.tableReplaced'))
      else if (appended > 0) parts.push(t('paste.newAppended', { count: appended }))
      if (emptySkipped > 0) parts.push(t('paste.emptySkipped', { count: emptySkipped }))
      if (skippedCols > 0) parts.push(t('paste.beyondTable', { count: skippedCols }))
      showPasteNotice(parts.join(' · '))
    },
    [result, columnKinds, columnLabels, onRowsPasted, showPasteNotice, t],
  )

  // Ctrl+V anywhere in the grid pastes straight from the clipboard: the paste
  // event only carries data on a user gesture, which a keypress is. The
  // listener sits on document (the event's target can be the focused cell or
  // the document itself) and only acts when the grid has focus.
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const wrap = gridWrapRef.current
      if (!wrap) return
      const path = event.composedPath()
      if (!path.includes(wrap) && !wrap.contains(document.activeElement)) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      applyPastedText(text)
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [applyPastedText])

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

  // Paste-from-clipboard dialog: the touch/restricted-clipboard fallback, and
  // the only paste entry point before any query has run (it then creates a
  // brand-new table). Rendered in both the empty and the grid states.
  const pasteDialog = (
    <Dialog open={pasteOpen} onClose={() => setPasteOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle>{t('paste.dialogTitle')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {result ? t('paste.introWithGrid') : t('paste.introNoGrid')}
        </Typography>
        <TextField
          autoFocus
          multiline
          minRows={6}
          maxRows={14}
          fullWidth
          placeholder={t('paste.placeholder')}
          value={pasteDraft}
          onChange={(event) => handlePasteDraftChange(event.target.value)}
        />
        <FormControlLabel
          sx={{ mt: 1, alignItems: 'center' }}
          control={
            <Checkbox
              size="small"
              checked={pasteSkipHeader}
              onChange={(event) => {
                setPasteSkipHeader(event.target.checked)
                pasteHeaderTouched.current = true
              }}
            />
          }
          label={
            result
              ? t('paste.headerLabelWithGrid')
              : t('paste.headerLabelNoGrid')
          }
          slotProps={{ typography: { variant: 'body2' } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setPasteOpen(false)} sx={{ minHeight: 40 }}>
          {t('paste.cancel')}
        </Button>
        <Button
          variant="contained"
          disabled={!pasteDraft.trim()}
          onClick={() => {
            const text = pasteDraft
            setPasteOpen(false)
            setPasteDraft('')
            applyPastedText(text, { skipHeader: pasteSkipHeader, replace: true })
          }}
          sx={{ minHeight: 40 }}
        >
          {result ? t('paste.pasteIntoGrid') : t('paste.pasteAsNewTable')}
        </Button>
      </DialogActions>
    </Dialog>
  )

  if (!result) {
    return (
      <>
        <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
          <Typography color="text.secondary">
            {t('empty.noResult')}
          </Typography>
        </Box>
        {pasteDialog}
      </>
    )
  }

  const empty = result.rows.length === 0

  return (
    <Stack spacing={1.5} sx={{ width: '100%' }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            {drillFilters.length > 0
              ? t('rows.drilled', {
                  drilled: drilledCount.toLocaleString(),
                  total: result.row_count.toLocaleString(),
                })
              : t('rows.count', {
                  count: result.row_count,
                  value: result.row_count.toLocaleString(),
                })}{' '}
            · {result.elapsed_ms.toLocaleString()} ms
          </Typography>
          {pasteNotice && (
            <Typography variant="body2" color="success.main">
              {pasteNotice}
            </Typography>
          )}
        </Stack>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {!empty && (
            <TextField
              size="small"
              value={globalSearch}
              onChange={(event) => setGlobalSearch(event.target.value)}
              placeholder={t('search.placeholder')}
              sx={{ width: { xs: '100%', sm: 260 } }}
              slotProps={{
                htmlInput: { 'aria-label': t('search.placeholder') },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: globalSearch ? (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        edge="end"
                        aria-label={t('search.clear')}
                        onClick={() => setGlobalSearch('')}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : undefined,
                },
              }}
            />
          )}
          {onRevertGrid && (
            <Tooltip title={t('revert.tooltip')}>
              <Button
                size="small"
                variant="outlined"
                color="warning"
                startIcon={<UndoIcon />}
                onClick={onRevertGrid}
                sx={{ minHeight: 40 }}
              >
                {t('revert.button')}
              </Button>
            </Tooltip>
          )}
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
                {t('drill.clear')}
              </Button>
            )
          }
        >
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2">{t('drill.label')}</Typography>
            {drillFilters.map((filter) => (
              <Chip
                key={filter.column}
                size="small"
                label={`${filter.column} = ${filter.values.map((v) => (v === '' ? t('drill.blank') : v)).join(', ')}`}
              />
            ))}
          </Stack>
        </Alert>
      )}

      {empty ? (
        <Box sx={{ textAlign: 'center', py: { xs: 5, md: 8 } }}>
          <Typography color="text.secondary">{t('empty.noRows')}</Typography>
        </Box>
      ) : (
        <Box
          ref={gridWrapRef}
          className={rowsEntering ? 'ag-theme-quartz grid-rows-enter' : 'ag-theme-quartz'}
          sx={{ height: { xs: 420, md: 560 }, width: '100%' }}
        >
          <AgGridReact
            // Rebuilding on a language change re-reads localeText, which is
            // otherwise captured once at grid creation.
            key={i18n.language}
            localeText={i18n.language.startsWith('zh') ? AG_GRID_LOCALE_ZH : undefined}
            ref={gridRef}
            rowData={result.rows}
            quickFilterText={globalSearch}
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

      {/* One window, three tabs: AI edit / Data types / Add column. */}
      <GridToolsDialog
        open={toolsOpen}
        initialTab={toolsTab}
        result={result}
        kinds={columnKinds}
        onKindChange={handleKindChange}
        onAddComputedColumn={onAddComputedColumn}
        onAiApply={onAiTransformApply}
        onTabChange={setToolsTab}
        onClose={() => setToolsOpen(false)}
      />

      {/* Paste fallback for touch screens and restricted clipboards: the
          textarea receives the paste as a normal user gesture, so no
          clipboard-read permission is needed. */}
      {pasteDialog}

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
            label={t('menu.copyCell')}
            onClick={() => void runMenuAction('copyCell')}
          />
        )}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<ContentCopyIcon fontSize="small" />}
            label={t('menu.copyRow')}
            onClick={() => void runMenuAction('copyRow')}
          />
        )}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<ContentCopyIcon fontSize="small" />}
            label={
              menu && menu.facts.selectedCount > 1
                ? t('menu.copySelectedCount', { count: menu.facts.selectedCount })
                : t('menu.copySelected')
            }
            disabled={!menu || menu.facts.selectedCount === 0}
            onClick={() => void runMenuAction('copySelected')}
          />
        )}
        {menu?.scope === 'cell' && <MenuDivider />}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<FilterAltIcon fontSize="small" />}
            label={t('menu.filterBy')}
            onClick={() => void runMenuAction('filterBy')}
          />
        )}
        {menu?.scope === 'cell' && (
          <ActionItem
            icon={<FilterAltOffIcon fontSize="small" />}
            label={t('menu.filterOut')}
            onClick={() => void runMenuAction('filterOut')}
          />
        )}
        <ActionItem
          icon={<FilterAltIcon fontSize="small" />}
          label={t('menu.openFilter')}
          onClick={() => void runMenuAction('openFilter')}
        />
        <ActionItem
          icon={<FilterAltOffIcon fontSize="small" />}
          label={t('menu.clearFilter')}
          disabled={!menu?.facts.filtered}
          onClick={() => void runMenuAction('clearFilter')}
        />
        <ActionItem
          icon={<ClearAllIcon fontSize="small" />}
          label={t('menu.clearAllFilters')}
          disabled={!menu?.facts.anyFilter}
          onClick={() => void runMenuAction('clearAllFilters')}
        />
        <MenuDivider />
        <ActionItem
          icon={<ArrowUpwardIcon fontSize="small" />}
          label={t('menu.sortAsc')}
          onClick={() => void runMenuAction('sortAsc')}
        />
        <ActionItem
          icon={<ArrowDownwardIcon fontSize="small" />}
          label={t('menu.sortDesc')}
          onClick={() => void runMenuAction('sortDesc')}
        />
        <ActionItem
          icon={<SwapVertIcon fontSize="small" />}
          label={t('menu.clearSort')}
          disabled={!menu?.facts.sorted}
          onClick={() => void runMenuAction('clearSort')}
        />
        <MenuDivider />
        <ActionItem
          icon={<PushPinIcon fontSize="small" />}
          label={t('menu.pinLeft')}
          disabled={menu?.facts.pinned === 'left'}
          onClick={() => void runMenuAction('pinLeft')}
        />
        <ActionItem
          icon={<PushPinIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />}
          label={t('menu.pinRight')}
          disabled={menu?.facts.pinned === 'right'}
          onClick={() => void runMenuAction('pinRight')}
        />
        <ActionItem
          icon={<BlockIcon fontSize="small" />}
          label={t('menu.unpin')}
          disabled={!menu?.facts.pinned}
          onClick={() => void runMenuAction('unpin')}
        />
        <MenuDivider />
        <ActionItem
          icon={<StraightenIcon fontSize="small" />}
          label={t('menu.autosizeThis')}
          onClick={() => void runMenuAction('autosizeThis')}
        />
        <ActionItem
          icon={<StraightenIcon fontSize="small" />}
          label={t('menu.autosizeAll')}
          onClick={() => void runMenuAction('autosizeAll')}
        />
        <ActionItem
          icon={<RestartAltIcon fontSize="small" />}
          label={t('menu.resetColumns')}
          onClick={() => void runMenuAction('resetColumns')}
        />
        <MenuDivider />
        <ActionItem
          icon={<VisibilityOffIcon fontSize="small" />}
          label={t('menu.hideColumn')}
          disabled={!menu?.facts.canHide}
          onClick={() => void runMenuAction('hideColumn')}
        />
        <ActionItem
          icon={<VisibilityIcon fontSize="small" />}
          label={t('menu.showAllColumns')}
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
            <Typography variant="subtitle2">{t('help.title')}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t('help.subtitle')}
            </Typography>
          </Box>
          <Divider />
          <HelpRow
            icon={<ContentCopyIcon fontSize="small" />}
            title={t('help.copy.title')}
            detail={t('help.copy.detail')}
          />
          <HelpRow
            icon={<ContentPasteIcon fontSize="small" />}
            title={t('help.paste.title')}
            detail={t('help.paste.detail')}
          />
          <HelpRow
            icon={<SwapVertIcon fontSize="small" />}
            title={t('help.sort.title')}
            detail={t('help.sort.detail')}
          />
          <HelpRow
            icon={<LowPriorityIcon fontSize="small" />}
            title={t('help.multiSort.title')}
            detail={t('help.multiSort.detail')}
          />
          <HelpRow
            icon={<FilterAltIcon fontSize="small" />}
            title={t('help.filter.title')}
            detail={t('help.filter.detail')}
          />
          <HelpRow
            icon={<PushPinIcon fontSize="small" />}
            title={t('help.columns.title')}
            detail={t('help.columns.detail')}
          />
          <HelpRow
            icon={<TuneIcon fontSize="small" />}
            title={t('help.rename.title')}
            detail={t('help.rename.detail')}
          />
          <HelpRow
            icon={<EditIcon fontSize="small" />}
            title={t('help.editGrid.title')}
            detail={t('help.editGrid.detail')}
          />
          {onSaveToWarehouse && (
            <HelpRow
              icon={<SaveIcon fontSize="small" />}
              title={t('help.save.title')}
              detail={t('help.save.detail')}
            />
          )}
          {onRevertGrid && (
            <HelpRow
              icon={<UndoIcon fontSize="small" />}
              title={t('help.revert.title')}
              detail={t('help.revert.detail')}
            />
          )}
          <HelpRow
            icon={<HelpOutlinedIcon fontSize="small" />}
            title={t('help.selection.title')}
            detail={t('help.selection.detail')}
          />
        </Stack>
      </Popover>
    </Stack>
  )
})

export default ResultsGrid
