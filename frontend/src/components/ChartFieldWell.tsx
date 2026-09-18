import { useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import CloseIcon from '@mui/icons-material/Close'
import { COLUMN_KIND_LABELS, type ColumnKind } from '../utils/columns'

/** A selectable column shown in a well's picker menu. */
export interface WellColumn {
  name: string
  kind: ColumnKind
}

interface FieldWellProps {
  /** Axis label, e.g. "X axis", "Y (primary)", "Y2 (secondary)". */
  label: string
  /** Currently assigned column names (an empty array = empty well). */
  value: string[]
  /** When true the well accepts multiple columns; otherwise a single column. */
  multi?: boolean
  /** Columns offered for this well (used to validate drops + fill the picker). */
  options: WellColumn[]
  /** Called when the user picks from the "+" menu. */
  onChoose: (name: string) => void
  /** Called when a palette chip is dropped onto the well. */
  onAdd: (name: string) => void
  /** Called when a chip's remove button is clicked. */
  onRemove: (name: string) => void
  /** Placeholder shown while the well is empty. */
  hint?: string
}

/**
 * A drop target ("shelf") for chart fields. Desktop users drag a column chip
 * from the palette onto the well; touch users tap the "+" button to pick from a
 * menu. Both paths feed the same callbacks so behaviour stays consistent.
 */
export default function FieldWell({
  label,
  value,
  multi,
  options,
  onChoose,
  onAdd,
  onRemove,
  hint,
}: FieldWellProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [over, setOver] = useState(false)
  const open = Boolean(anchorEl)

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setOver(false)
    const name = event.dataTransfer.getData('text/plain')
    if (!name || !options.some((o) => o.name === name)) return
    onAdd(name)
  }

  const handleChoose = (name: string) => {
    onChoose(name)
    // Single-select shelves close after a choice; multi-select stays open so
    // users can toggle several columns in one go.
    if (!multi) setAnchorEl(null)
  }

  return (
    <Box sx={{ minWidth: { xs: '100%', sm: 180 }, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="caption" color="text.secondary" noWrap>
        {label}
      </Typography>

      <Box
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
        sx={{
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 0.75,
          p: 1,
          borderRadius: 1,
          border: '1.5px dashed',
          borderColor: over ? 'primary.main' : 'divider',
          bgcolor: over ? 'action.hover' : 'transparent',
          transition: 'border-color 0.15s, background-color 0.15s',
        }}
      >
        {value.length === 0 && (
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: 12 }}>
            {hint}
          </Typography>
        )}
        {value.map((name) => (
          <Chip
            key={name}
            size="small"
            label={
              <Box
                component="span"
                sx={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
              >
                {name}
              </Box>
            }
            onDelete={() => onRemove(name)}
            deleteIcon={<CloseIcon />}
            sx={{ maxWidth: 220 }}
          />
        ))}
        <IconButton
          size="small"
          onClick={(event: ReactMouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget)}
          aria-label={`Add ${label}`}
          // On phones/tablets this "+" is the main way to fill a shelf (dragging
          // is unreliable on touch), so it keeps a full-size touch target. Desktop
          // keeps the compact pointer-sized button.
          sx={{ minHeight: { xs: 48, md: 36 }, minWidth: { xs: 48, md: 36 } }}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      </Box>

      <Menu anchorEl={anchorEl} open={open} onClose={() => setAnchorEl(null)}>
        {options.length === 0 ? (
          <MenuItem disabled>No matching columns</MenuItem>
        ) : (
          options.map((o) => {
            const selected = value.includes(o.name)
            return (
              <MenuItem key={o.name} selected={selected} onClick={() => handleChoose(o.name)}>
                <Box component="span" sx={{ display: 'flex', gap: 1, alignItems: 'center', minWidth: 0 }}>
                  <Box
                    component="span"
                    sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {o.name}
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                    {COLUMN_KIND_LABELS[o.kind]}
                  </Typography>
                </Box>
              </MenuItem>
            )
          })
        )}
      </Menu>
    </Box>
  )
}
