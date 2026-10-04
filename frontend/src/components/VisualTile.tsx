import { useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined'
import EditIcon from '@mui/icons-material/Edit'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import StraightenIcon from '@mui/icons-material/Straighten'
import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import EChart from './EChart'
import KpiCards from './KpiCards'
import {
  buildVisualChart,
  VISUAL_SPAN,
  type DashboardVisual,
  type VisualSize,
} from '../utils/visual'

interface VisualTileProps {
  visual: DashboardVisual
  /** The snapshot's rows — every tile on a dashboard reads the same dataset. */
  rows: Record<string, unknown>[]
  /** 1-based position among the dashboard's visuals (move up/down enablement). */
  index: number
  count: number
  /** True while this tile's config is loaded back into the chart builder. */
  editing?: boolean
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onResize: (id: string, size: VisualSize) => void
  onRemove: (id: string) => void
}

const SIZES: VisualSize[] = ['small', 'medium', 'large']

/**
 * One pinned chart on a snapshot's dashboard.
 *
 * The tile is a renderer, never a builder: it replays the stored config through
 * the same {@link buildVisualChart} the chart tab uses, so a pinned visual can
 * never drift from what was previewed. Actions live in a menu rather than as
 * drag handles, so they work identically with a mouse and with touch.
 */
export default function VisualTile({
  visual,
  rows,
  index,
  count,
  editing,
  onEdit,
  onDuplicate,
  onMove,
  onResize,
  onRemove,
}: VisualTileProps) {
  const { t } = useTranslation('charts')
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const chart = useMemo(() => buildVisualChart(rows, visual.config), [rows, visual.config])
  const isKpi = visual.config.chartType === 'kpi'

  const closeMenu = () => setMenuAnchor(null)

  const run = (action: () => void) => (event: ReactMouseEvent) => {
    event.stopPropagation()
    closeMenu()
    action()
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        overflow: 'hidden',
        gridColumn: {
          xs: VISUAL_SPAN[visual.size].xs,
          sm: VISUAL_SPAN[visual.size].sm,
          lg: VISUAL_SPAN[visual.size].lg,
        },
        borderColor: editing ? 'primary.main' : 'divider',
        borderWidth: editing ? 2 : 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: 1.5, pr: 0.5, py: 0.5 }}>
        <Typography
          variant="subtitle2"
          noWrap
          title={visual.title}
          sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}
        >
          {visual.title}
        </Typography>
        <Tooltip title={t('tile.editTooltip')}>
          <IconButton
            size="small"
            aria-label={t('tile.editAria', { name: visual.title })}
            onClick={(event) => {
              event.stopPropagation()
              onEdit(visual.id)
            }}
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('tile.optionsTooltip')}>
          <IconButton
            size="small"
            aria-label={t('tile.optionsAria', { name: visual.title })}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={closeMenu}>
          <MenuItem disabled sx={{ opacity: '1 !important' }}>
            <ListItemIcon>
              <StraightenIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t('tile.size')} secondary={t(`tileSize.${visual.size}`)} />
          </MenuItem>
          {SIZES.map((size) => (
            <MenuItem
              key={size}
              disabled={size === visual.size}
              onClick={run(() => onResize(visual.id, size))}
              sx={{ pl: 4 }}
            >
              {t(`tileSize.${size}`)}
            </MenuItem>
          ))}
          <Divider />
          <MenuItem onClick={run(() => onDuplicate(visual.id))}>
            <ListItemIcon>
              <ContentCopyIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t('tile.duplicate')} />
          </MenuItem>
          <MenuItem disabled={index === 0} onClick={run(() => onMove(visual.id, -1))}>
            <ListItemIcon>
              <ChevronLeftIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t('tile.moveEarlier')} />
          </MenuItem>
          <MenuItem disabled={index === count - 1} onClick={run(() => onMove(visual.id, 1))}>
            <ListItemIcon>
              <ChevronRightIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t('tile.moveLater')} />
          </MenuItem>
          <Divider />
          <MenuItem onClick={run(() => onRemove(visual.id))}>
            <ListItemIcon>
              <DeleteOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t('tile.remove')} />
          </MenuItem>
        </Menu>
      </Box>

      <Divider />

      <Box sx={{ p: 1.5, flex: 1, minWidth: 0 }}>
        {isKpi ? (
          chart.kpiCards.length > 0 ? (
            <KpiCards cards={chart.kpiCards} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t('tile.kpiEmpty')}
            </Typography>
          )
        ) : (
          <Box sx={{ position: 'relative', height: 260, minHeight: 200 }}>
            <EChart option={chart.option} />
            {!chart.hasData && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.paper',
                  px: 2,
                  textAlign: 'center',
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  {t('tile.noData')}
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Paper>
  )
}
