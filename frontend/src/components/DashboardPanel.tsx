import AddIcon from '@mui/icons-material/Add'
import DashboardCustomizeIcon from '@mui/icons-material/DashboardCustomize'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import VisualTile from './VisualTile'
import type { DashboardVisual, VisualSize } from '../utils/visual'

interface DashboardPanelProps {
  visuals: DashboardVisual[]
  /** The snapshot's rows — the dashboard's single dataset. */
  rows: Record<string, unknown>[]
  loading: boolean
  editingVisualId: string | null
  /** Go to the chart tab (with no tile loaded) to build a new visual. */
  onAdd: () => void
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onResize: (id: string, size: VisualSize) => void
  onRemove: (id: string) => void
}

/**
 * A snapshot's dashboard: every visual the user pinned, as one responsive
 * canvas. Mobile gets a single column, tablets two, desktops three — the tiles
 * themselves decide how many columns they span (see VISUAL_SPAN).
 */
export default function DashboardPanel({
  visuals,
  rows,
  loading,
  editingVisualId,
  onAdd,
  onEdit,
  onDuplicate,
  onMove,
  onResize,
  onRemove,
}: DashboardPanelProps) {
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    )
  }

  if (visuals.length === 0) {
    return (
      <Paper
        variant="outlined"
        sx={{
          p: { xs: 3, sm: 5 },
          textAlign: 'center',
          borderStyle: 'dashed',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1.5,
        }}
      >
        <DashboardCustomizeIcon sx={{ fontSize: 40, color: 'text.disabled' }} />
        <Typography variant="h6">This dashboard is empty</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>
          Describe the dashboard you want and the AI designs several charts for it. Preview them,
          then pin the ones you like here — they all read this snapshot’s data.
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={onAdd} sx={{ minHeight: 48, mt: 0.5 }}>
          Build with AI
        </Button>
      </Paper>
    )
  }

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {visuals.length} visual{visuals.length === 1 ? '' : 's'}
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={<AddIcon />}
          onClick={onAdd}
          sx={{ minHeight: { xs: 48, sm: 40 } }}
        >
          Add chart
        </Button>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, minmax(0, 1fr))',
            lg: 'repeat(3, minmax(0, 1fr))',
          },
          gap: 1.5,
          alignItems: 'start',
        }}
      >
        {visuals.map((visual, index) => (
          <VisualTile
            key={visual.id}
            visual={visual}
            rows={rows}
            index={index}
            count={visuals.length}
            editing={visual.id === editingVisualId}
            onEdit={onEdit}
            onDuplicate={onDuplicate}
            onMove={onMove}
            onResize={onResize}
            onRemove={onRemove}
          />
        ))}
      </Box>
    </Stack>
  )
}
