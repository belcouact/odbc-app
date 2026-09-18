import { useMemo, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { QueryResult } from '../types'
import { formatCellValue } from '../utils/format'
import {
  extractColumnRefs,
  previewFormula,
  validateFormula,
  type ComputedColumn,
} from '../utils/formula'

const OPERATOR_BUTTONS = ['+', '-', '*', '/', '%', '^', '(', ')', '&', ',', '=', '!=']
const FUNCTION_BUTTONS = ['IF', 'ROUND', 'ABS', 'CEIL', 'FLOOR', 'SQRT', 'LEN', 'UPPER', 'LOWER', 'TRIM', 'COALESCE']

interface AddColumnDialogProps {
  open: boolean
  columns: QueryResult['columns']
  rows: QueryResult['rows']
  /** Names already used (source + computed); the new name must be unique. */
  existingNames: string[]
  onClose: () => void
  onAdd: (col: ComputedColumn) => void
}

/**
 * Builder for a calculated grid column. Users pick columns / operators from the
 * helper palette (which inserts at the cursor) and see a live preview on the
 * first rows before committing.
 */
export default function AddColumnDialog({
  open,
  columns,
  rows,
  existingNames,
  onClose,
  onAdd,
}: AddColumnDialogProps) {
  const [name, setName] = useState('')
  const [expression, setExpression] = useState('')
  const [error, setError] = useState<string | null>(null)
  const exprRef = useRef<HTMLTextAreaElement | null>(null)

  /** Insert a snippet at the cursor of the formula field. */
  const insert = (snippet: string) => {
    setError(null)
    const input = exprRef.current
    if (!input) {
      setExpression((prev) => prev + snippet)
      return
    }
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const next = input.value.slice(0, start) + snippet + input.value.slice(end)
    setExpression(next)
    requestAnimationFrame(() => {
      const pos = start + snippet.length
      input.focus()
      input.setSelectionRange(pos, pos)
    })
  }

  const insertColumn = (col: string) => insert(`{${col}}`)
  const insertFunction = (fn: string) => insert(`${fn}(`)

  const formulaError = useMemo(
    () => (expression.trim() ? validateFormula(expression) : 'Enter a formula.'),
    [expression],
  )

  const missingColumns = useMemo(() => {
    const refs = extractColumnRefs(expression)
    return refs.filter((ref) => !columns.some((c) => c.name === ref))
  }, [expression, columns])

  const preview = useMemo(() => {
    if (!expression.trim() || formulaError || missingColumns.length > 0) return []
    try {
      return previewFormula(expression, rows)
    } catch {
      return []
    }
  }, [expression, rows, formulaError, missingColumns])

  const canAdd =
    name.trim() !== '' &&
    !existingNames.includes(name.trim()) &&
    !formulaError &&
    missingColumns.length === 0

  const handleAdd = () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Enter a column name.')
      return
    }
    if (existingNames.includes(trimmedName)) {
      setError('A column with that name already exists.')
      return
    }
    const formulaErr = validateFormula(expression)
    if (formulaErr) {
      setError(formulaErr)
      return
    }
    const missing = extractColumnRefs(expression).filter((ref) => !columns.some((c) => c.name === ref))
    if (missing.length > 0) {
      setError(`Unknown column(s): ${missing.join(', ')}`)
      return
    }
    onAdd({ name: trimmedName, expression: expression.trim() })
    reset()
  }

  const reset = () => {
    setName('')
    setExpression('')
    setError(null)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const hintText =
    expression.trim() && !formulaError
      ? `${preview.length} of ${rows.length.toLocaleString()} rows shown`
      : ''

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Add calculated column</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          Build a formula for a new column. Reference source columns with{' '}
          <Box component="span" sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', px: 0.5, borderRadius: 0.5 }}>
            {'{ColumnName}'}
          </Box>{' '}
          — e.g. <Box component="span" sx={{ fontFamily: 'monospace' }}>{'{Price} * {Qty}'}</Box>.
        </Typography>

        <TextField
          label="Column name"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          fullWidth
          size="small"
          autoFocus
        />

        <TextField
          label="Formula"
          value={expression}
          onChange={(e) => {
            setExpression(e.target.value)
            setError(null)
          }}
          fullWidth
          size="small"
          multiline
          minRows={2}
          inputRef={exprRef}
          sx={{ '& textarea': { fontFamily: 'monospace', fontSize: 13 } }}
        />

        {/* Operator helper */}
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {OPERATOR_BUTTONS.map((op) => (
            <Button
              key={op}
              size="small"
              variant="outlined"
              onClick={() => insert(op === '=' ? ' = ' : op)}
              sx={{ minWidth: 36, minHeight: 40, px: 1, fontFamily: 'monospace' }}
            >
              {op}
            </Button>
          ))}
        </Stack>

        {/* Function helper */}
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {FUNCTION_BUTTONS.map((fn) => (
            <Button
              key={fn}
              size="small"
              variant="outlined"
              onClick={() => insertFunction(fn)}
              sx={{ minHeight: 40, fontFamily: 'monospace' }}
            >
              {fn}(
            </Button>
          ))}
        </Stack>

        {/* Column palette */}
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Columns
          </Typography>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {columns.map((col) => (
              <Chip
                key={col.name}
                size="small"
                label={col.name}
                onClick={() => insertColumn(col.name)}
                sx={{ cursor: 'pointer' }}
              />
            ))}
          </Stack>
        </Box>

        {(formulaError || missingColumns.length > 0 || error) && (
          <Alert severity="error">
            {error || formulaError || `Unknown column(s): ${missingColumns.join(', ')}`}
          </Alert>
        )}

        {hintText && (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Preview · {hintText}
            </Typography>
            <Stack spacing={0.25}>
              {preview.slice(0, 8).map((value, index) => (
                <Typography key={index} variant="body2" noWrap sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {formatCellValue(value)}
                </Typography>
              ))}
            </Stack>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} sx={{ minHeight: 40 }}>
          Cancel
        </Button>
        <Button onClick={handleAdd} variant="contained" disabled={!canAdd} sx={{ minHeight: 40 }}>
          Add column
        </Button>
      </DialogActions>
    </Dialog>
  )
}
