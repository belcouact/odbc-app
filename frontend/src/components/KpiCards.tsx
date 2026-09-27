import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import type { KpiCard } from '../utils/chartData'
import { OPERATIONS } from '../utils/chartCatalog'

interface KpiCardsProps {
  cards: KpiCard[]
}

/**
 * Big-number KPI cards. Shared by the chart builder and dashboard tiles so a
 * pinned KPI looks exactly like the one that was previewed. Renders nothing
 * when there are no cards — the caller owns the "pick a column" hint.
 */
export default function KpiCards({ cards }: KpiCardsProps) {
  if (cards.length === 0) return null
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(auto-fit, minmax(180px, 1fr))' },
        gap: 1.5,
      }}
    >
      {cards.map((card) => {
        const opLabel = OPERATIONS.find((o) => o.value === card.op)?.label
        return (
          <Paper
            key={card.label}
            variant="outlined"
            sx={{ p: 1.5, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ display: 'block' }}
              title={opLabel && card.stats.length > 0 ? `${card.label} · ${opLabel}` : card.label}
            >
              {card.label}
              {opLabel && card.stats.length > 0 ? ` · ${opLabel}` : ''}
            </Typography>
            <Typography variant="h5" noWrap sx={{ fontWeight: 700 }} title={card.formatted}>
              {card.formatted}
            </Typography>
            {card.stats.length > 0 && (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  columnGap: 1,
                  rowGap: 0.25,
                  mt: 0.5,
                }}
              >
                {card.stats.map((stat) => (
                  <Box key={stat.label} sx={{ minWidth: 0 }}>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', lineHeight: 1.2 }}
                    >
                      {stat.label}
                    </Typography>
                    <Typography variant="body2" noWrap title={stat.formatted}>
                      {stat.formatted}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
          </Paper>
        )
      })}
    </Box>
  )
}
