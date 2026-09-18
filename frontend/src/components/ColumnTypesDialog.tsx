import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { QueryResult } from '../types'
import {
  COLUMN_KIND_OPTIONS,
  detectColumnKind,
  type ColumnKind,
} from '../utils/columns'

interface ColumnTypesDialogProps {
  open: boolean
  columns: QueryResult['columns']
  rows: QueryResult['rows']
  /** User-chosen kinds keyed by column name (overrides auto-detection). */
  kinds: Record<string, ColumnKind>
  onClose: () => void
  onKindChange: (name: string, kind: ColumnKind) => void
}

/**
 * Popup that lets the user review / override how each result column is treated
 * (Number / Text / Boolean / Date) — affecting numeric sorting, filters and
 * cell formatting. Replaces the old per-column type chip in the header.
 */
export default function ColumnTypesDialog({
  open,
  columns,
  rows,
  kinds,
  onClose,
  onKindChange,
}: ColumnTypesDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Column data types</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
          Choose how each column is treated in the grid (sorting, filters, formatting). Kinds are
          auto-detected from the database type; override any column here.
        </Typography>
        {columns.map((column) => {
          const inferred = detectColumnKind(column.name, column.type, rows)
          const current = kinds[column.name] ?? inferred
          return (
            <Stack
              key={column.name}
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ py: 0.5, alignItems: 'center' }}
            >
              <Typography variant="body2" noWrap sx={{ flexGrow: 1, fontFamily: 'monospace' }}>
                {column.name}
              </Typography>
              <Select
                size="small"
                value={current}
                onChange={(event) => onKindChange(column.name, event.target.value as ColumnKind)}
                sx={{ minWidth: 120 }}
              >
                {COLUMN_KIND_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </Stack>
          )
        })}
        {columns.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No columns to show.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ minHeight: 40 }}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}
