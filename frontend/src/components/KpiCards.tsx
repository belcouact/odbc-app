import { useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import type { KpiCard } from '../utils/chartData'
import { formatCompactNumber } from '../utils/chartData'
import { useTranslation } from 'react-i18next'

interface KpiCardsProps {
  cards: KpiCard[]
}

/** Duration of the number roll-up animation. */
const COUNT_UP_MS = 600

/** Stat labels that have translations; anything else is a data-driven label. */
const STAT_LABEL_KEYS: Record<string, string> = {
  Count: 'kpi.stats.count',
  Nulls: 'kpi.stats.nulls',
  Sum: 'kpi.stats.sum',
  Mean: 'kpi.stats.mean',
  Median: 'kpi.stats.median',
  Min: 'kpi.stats.min',
  Max: 'kpi.stats.max',
  'Std dev': 'kpi.stats.stdDev',
}

/**
 * Animates a displayed number toward `target` with an rAF ease-out roll.
 * Starts from the currently displayed value, so a re-query while an animation
 * is still running seamlessly retargets instead of jumping. Skipped entirely
 * for users who prefer reduced motion.
 */
function useCountUp(target: number, enabled: boolean): number {
  const [display, setDisplay] = useState(enabled ? 0 : target)
  /** Mirror of `display` for reading the animation start inside the effect. */
  const displayRef = useRef(display)
  const frameRef = useRef(0)

  useEffect(() => {
    const finish = () => {
      displayRef.current = target
      setDisplay(target)
    }
    if (!enabled || displayRef.current === target) {
      finish()
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish()
      return
    }
    const from = displayRef.current
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS)
      const eased = 1 - Math.pow(1 - t, 3)
      const current = from + (target - from) * eased
      displayRef.current = current
      setDisplay(current)
      if (t < 1) frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [target, enabled])

  return display
}

/** The rolling number itself; '—' cards bypass the animation entirely. */
function CountUpValue({ value, enabled }: { value: number; enabled: boolean }) {
  const display = useCountUp(value, enabled)
  return <>{formatCompactNumber(display)}</>
}

/**
 * Big-number KPI cards. Shared by the chart builder and dashboard tiles so a
 * pinned KPI looks exactly like the one that was previewed. Renders nothing
 * when there are no cards — the caller owns the "pick a column" hint.
 * Numbers roll up when a new result lands; desktops get a hover lift, touch
 * devices a press-down scale.
 */
export default function KpiCards({ cards }: KpiCardsProps) {
  const { t } = useTranslation('charts')
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
        const opLabel = t(`ops.${card.op}`)
        const label = card.label === 'Total rows' ? t('kpi.totalRows') : card.label
        const numeric = card.formatted !== '—'
        return (
          <Paper
            key={card.label}
            variant="outlined"
            sx={{
              p: 1.5,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
              // GPU-friendly lift on pointer devices; a press-scale covers touch.
              transition: 'transform 0.2s ease-out, box-shadow 0.2s ease-out',
              '@media (hover: hover)': {
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: '0 6px 16px rgba(217, 119, 87, 0.14)',
                },
              },
              '&:active': { transform: 'scale(0.98)' },
            }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ display: 'block' }}
              title={opLabel && card.stats.length > 0 ? t('kpi.titleWithOp', { label, op: opLabel }) : label}
            >
              {label}
              {opLabel && card.stats.length > 0 ? ` · ${opLabel}` : ''}
            </Typography>
            <Typography variant="h5" noWrap sx={{ fontWeight: 700 }} title={card.formatted}>
              {numeric ? <CountUpValue value={card.value} enabled /> : card.formatted}
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
                      {STAT_LABEL_KEYS[stat.label] ? t(STAT_LABEL_KEYS[stat.label]) : stat.label}
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
