import { useState } from 'react'
import Box from '@mui/material/Box'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import useMediaQuery from '@mui/material/useMediaQuery'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CloseIcon from '@mui/icons-material/Close'
import FunctionsIcon from '@mui/icons-material/Functions'
import TuneIcon from '@mui/icons-material/Tune'
import type { QueryResult } from '../types'
import type { ColumnKind } from '../utils/columns'
import type { ComputedColumn } from '../utils/formula'
import AiTransformPanel from './AiGridTransformDialog'
import ColumnTypesPanel from './ColumnTypesDialog'
import AddColumnPanel from './AddColumnDialog'

/** Which tool tab the window opens on. */
export type GridToolsTab = 'ai' | 'types' | 'add'

interface GridToolsDialogProps {
  open: boolean
  /** Tab to show when the window opens (the entry point the user clicked). */
  initialTab: GridToolsTab
  result: QueryResult
  /** User-chosen data kinds keyed by column name (overrides auto-detection). */
  kinds: Record<string, ColumnKind>
  onKindChange: (name: string, kind: ColumnKind) => void
  /** Adds a calculated column built with the formula helper. */
  onAddComputedColumn: (col: ComputedColumn) => void
  /** Runs an AI transform on the grid; undefined hides the AI edit tab. */
  onAiApply?: (
    rows: Record<string, unknown>[],
    columns: { name: string; type: string }[],
    log: string,
  ) => void
  /** Reports tab switches so the parent can reopen on the last-used tab. */
  onTabChange?: (tab: GridToolsTab) => void
  onClose: () => void
}

/**
 * One window for the grid editing tools — "AI edit", "Data types" and
 * "Add column" — as tabs. All panels stay mounted while the window is open,
 * so an in-progress AI request survives a peek at the other tabs.
 */
export default function GridToolsDialog({
  open,
  initialTab,
  result,
  kinds,
  onKindChange,
  onAddComputedColumn,
  onAiApply,
  onTabChange,
  onClose,
}: GridToolsDialogProps) {
  const [tab, setTab] = useState<GridToolsTab>(initialTab)
  const fullScreen = useMediaQuery((theme) => theme.breakpoints.down('sm'))

  // Re-opening jumps to the requested tab; the AI tab needs a handler.
  // Adjusting state during render (not in an effect) — the documented way to
  // reset state when a prop changes, without a cascading extra render.
  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setTab(initialTab === 'ai' && !onAiApply ? 'types' : initialTab)
  } else if (!open && wasOpen) {
    setWasOpen(false)
  }

  /** AI transform accepted — hand it to the page and close the window. */
  const handleAiApply: NonNullable<GridToolsDialogProps['onAiApply']> = (rows, columns, log) => {
    onAiApply?.(rows, columns, log)
    onClose()
  }

  const tabSx = {
    minHeight: 48,
    '& .MuiTab-iconWrapper': { display: { xs: 'none', sm: 'inline-flex' } },
  } as const

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={fullScreen}>
      <DialogTitle sx={{ position: 'relative', pr: 7, pb: 0.5 }}>
        Edit grid
        <IconButton
          aria-label="Close edit grid window"
          onClick={onClose}
          sx={{ position: 'absolute', top: 4, right: 6 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <Tabs
        value={tab}
        onChange={(_, next: GridToolsTab) => {
          setTab(next)
          onTabChange?.(next)
        }}
        variant="fullWidth"
      >
        {onAiApply && (
          <Tab
            value="ai"
            icon={<AutoAwesomeIcon fontSize="small" />}
            iconPosition="start"
            label="AI edit"
            sx={tabSx}
          />
        )}
        <Tab
          value="types"
          icon={<TuneIcon fontSize="small" />}
          iconPosition="start"
          label="Data types"
          sx={tabSx}
        />
        <Tab
          value="add"
          icon={<FunctionsIcon fontSize="small" />}
          iconPosition="start"
          label="Add column"
          sx={tabSx}
        />
      </Tabs>
      <DialogContent dividers sx={{ p: 0 }}>
        {onAiApply && (
          <Box hidden={tab !== 'ai'}>
            <AiTransformPanel
              open={open}
              result={result}
              onClose={onClose}
              onApply={handleAiApply}
            />
          </Box>
        )}
        <Box hidden={tab !== 'types'}>
          <ColumnTypesPanel
            columns={result.columns}
            rows={result.rows}
            kinds={kinds}
            onKindChange={onKindChange}
          />
        </Box>
        <Box hidden={tab !== 'add'}>
          <AddColumnPanel
            columns={result.columns}
            rows={result.rows}
            existingNames={result.columns.map((c) => c.name)}
            onAdd={onAddComputedColumn}
            onClose={onClose}
          />
        </Box>
      </DialogContent>
    </Dialog>
  )
}
