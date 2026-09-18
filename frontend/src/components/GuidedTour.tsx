import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Button from '@mui/material/Button'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import type { SettingsSection } from '../pages/SettingsPage'
import { emit } from '../editorBus'

/** Storage key used to remember that the first-run guide was seen/finished.
 *  Bump the suffix when new steps are added so existing users see it again. */
export const TOUR_STORAGE_KEY = 'odbcapp.tour.v1'

type TourView = 'editor' | 'script' | 'settings'

interface TourStep {
  id: string
  title: string
  body: ReactNode
  /** data-tour attribute of the control to spotlight. */
  target: string
  /** Where the app should navigate to before spotlighting the target. */
  goto: { view: TourView; section?: SettingsSection; analyzeTab?: 'chart' | 'script' }
}

const CARD_GAP = 16

const TOUR_STEPS: TourStep[] = [
  {
    id: 'connections',
    title: 'Connect your database',
    body: (
      <>
        This app talks to your databases over ODBC. Click <b>Add connection</b> — DSNs
        already installed on this PC are detected automatically and listed for you.
        Save one and it appears as a badge in the top bar.
      </>
    ),
    target: 'connections-actions',
    goto: { view: 'settings', section: 'connections' },
  },
  {
    id: 'query-template',
    title: 'Query with a template',
    body: (
      <>
        Pick the connection you saved in the row above. With <b>Use template</b> on, a{' '}
        <b>Template</b> menu appears — choose a ready-made quick-search, fill the
        criteria (dates with a red * are required), then press <b>Run</b>. The SQL is
        generated for you.
      </>
    ),
    target: 'query-template',
    goto: { view: 'editor' },
  },
  {
    id: 'script-template',
    title: 'Analyze with a template script',
    body: (
      <>
        Open the <b>Script</b> tab — <b>Use template</b> is already on — and pick a
        script such as <i>analyze-mesa-yield</i>: it loads into the editor. Hit{' '}
        <b>Run</b> and the charts open in your browser, with the file saved to your
        Downloads folder.
      </>
    ),
    target: 'script-template',
    goto: { view: 'script', analyzeTab: 'script' },
  },
]

interface GuidedTourProps {
  /** Increment this counter each time the tour should (re)start. */
  runToken: number
  gotoView: (view: TourView) => void
  gotoSection: (section: SettingsSection) => void
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

interface Position {
  top: number
  left: number
  place: 'below' | 'above' | 'center'
}

export default function GuidedTour({ runToken, gotoView, gotoSection }: GuidedTourProps) {
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  const [active, setActive] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [pos, setPos] = useState<Position | null>(null)
  const [found, setFound] = useState<boolean | null>(null) // null = measuring

  const cardRef = useRef<HTMLDivElement | null>(null)

  const step = TOUR_STEPS[Math.min(stepIndex, TOUR_STEPS.length - 1)]
  const isLast = stepIndex === TOUR_STEPS.length - 1

  const finish = () => {
    setActive(false)
    try {
      window.localStorage.setItem(TOUR_STORAGE_KEY, 'done')
    } catch {
      /* storage unavailable — just close */
    }
  }

  // ---- Start whenever runToken increments (first-run or replay from About) ----
  useEffect(() => {
    if (runToken > 0) {
      setStepIndex(0)
      setRect(null)
      setPos(null)
      setFound(null)
      setActive(true)
    }
  }, [runToken])

  // ---- Navigate to the step's page/section, then find + center the target ----
  useEffect(() => {
    if (!active) return
    gotoView(step.goto.view)
    if (step.goto.section) gotoSection(step.goto.section)
    // The Analyze page supports sub-tabs; a step whose target lives on one of
    // them has to ask for it, otherwise the target never mounts.
    if (step.goto.analyzeTab) emit({ type: 'show-analyze-tab', tab: step.goto.analyzeTab })

    setRect(null)
    setFound(null)
    let alive = true
    let tries = 0

    const attempt = () => {
      if (!alive) return
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      if (!el) {
        // The target may mount late (async lists); retry briefly.
        tries += 1
        if (tries < 25) window.setTimeout(attempt, 150)
        else setFound(false)
        return
      }
      setFound(true)
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
      } catch {
        /* older engines ignore options */
        el.scrollIntoView()
      }
      // Wait a frame for the scroll + view switch layout to settle.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!alive) return
          const r = el.getBoundingClientRect()
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
        })
      })
    }

    const timer = window.setTimeout(attempt, reducedMotion ? 40 : 180)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIndex])

  // ---- Keep the ring glued to its target across resize / scroll ----
  useEffect(() => {
    if (!active || !rect) return
    const recompute = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      if (!el) return
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    const onResize = () => window.setTimeout(recompute, 50)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    window.addEventListener('scroll', recompute, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      window.removeEventListener('scroll', recompute, true)
    }
  }, [active, rect !== null, step.target]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Freeze page scrolling while the tour overlay is up ----
  useEffect(() => {
    if (!active) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [active])

  // ---- Keep keyboard focus on the card so Tab never leaks behind the overlay ----
  useEffect(() => {
    if (active) cardRef.current?.focus({ preventScroll: true })
  }, [active, stepIndex])

  // ---- Esc closes (treated as finished) ----
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // ---- Place the desktop card next to the spotlighted target ----
  useLayoutEffect(() => {
    if (!active || isMobile || !rect) {
      setPos(null)
      return
    }
    const el = cardRef.current
    if (!el) return
    const cardWidth = Math.min(380, el.offsetWidth)
    const cardHeight = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pad = 12
    const rectBottom = rect.top + rect.height

    let top: number
    let place: Position['place'] = 'center'
    if (rectBottom + CARD_GAP + cardHeight <= vh - pad) {
      place = 'below'
      top = rectBottom + CARD_GAP
    } else if (rect.top - CARD_GAP - cardHeight >= pad) {
      place = 'above'
      top = rect.top - CARD_GAP - cardHeight
    } else {
      top = Math.max(pad, (vh - cardHeight) / 2)
    }
    const left = Math.min(Math.max(pad, rect.left + rect.width / 2 - cardWidth / 2), Math.max(pad, vw - cardWidth - pad))
    setPos({ top, left, place })
  }, [active, isMobile, rect, stepIndex])

  if (!active) return null

  const showSpotlight = found !== false && rect !== null
  const dimColor = 'rgba(13, 23, 33, 0.55)'

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: theme.zIndex.modal + 60,
        // The layer below eats all clicks; the spotlight hole + card float above it.
      }}
    >
      {/* Click shield — transparent so the spotlight's own shadow supplies the
          darkening around the hole. Keeps the app behind the overlay inert. */}
      <Box aria-hidden sx={{ position: 'absolute', inset: 0 }} onClick={() => {}} />

      {/* Plain full-window dim used when no target was found (centered card). */}
      {!showSpotlight && (
        <Box aria-hidden sx={{ position: 'absolute', inset: 0, bgcolor: dimColor }} />
      )}

      {/* Spotlight cut-out + ring around the target. */}
      {showSpotlight && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            borderRadius: 2,
            pointerEvents: 'none',
            boxShadow: [
              `0 0 0 9999px ${dimColor}`,
              `0 0 0 3px rgba(255,255,255,0.92)`,
              `0 0 0 6px ${theme.palette.primary.main}`,
              `0 14px 34px rgba(0,0,0,0.25)`,
            ].join(', '),
          }}
        />
      )}

      {/* Progress bar */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          display: 'flex',
        }}
      >
        {TOUR_STEPS.map((s, index) => (
          <Box
            key={s.id}
            sx={{
              flex: 1,
              mx: 0.5,
              mt: 0.5,
              borderRadius: 2,
              bgcolor: index <= stepIndex ? theme.palette.primary.main : 'rgba(255,255,255,0.55)',
              transition: reducedMotion ? 'none' : 'background-color 300ms ease',
            }}
          />
        ))}
      </Box>

      {/* Floating card / bottom sheet */}
      <Box
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={step.title}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        sx={{
          position: 'absolute',
          ...(isMobile
            ? {
                left: 8,
                right: 8,
                bottom: 8,
                maxHeight: '48vh',
                overflowY: 'auto',
              }
            : {
                top: pos?.top ?? '50%',
                left: pos?.left ?? '50%',
                transform: pos ? undefined : 'translate(-50%, -50%)',
                width: { xs: 'auto', sm: 380 },
              }),
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderRadius: 3,
          border: '1px solid',
          borderColor: 'divider',
          boxShadow: theme.shadows[16],
          p: { xs: 2, sm: 2.5 },
          outline: 'none',
        }}
      >
        {/* Caret pointing at the target (desktop only). */}
        {!isMobile && pos && pos.place !== 'center' && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              width: 14,
              height: 14,
              bgcolor: 'background.paper',
              transform: 'rotate(45deg)',
              left: 'calc(50% - 7px)',
              ...(pos.place === 'below'
                ? { top: -7 }
                : { bottom: -7 }),
            }}
          />
        )}

        <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.75 }}>
          Step {stepIndex + 1} of {TOUR_STEPS.length}
        </Typography>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.75, pr: 0.5 }}>
          {step.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {step.body}
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
          <Button size="small" onClick={finish} sx={{ minHeight: { xs: 48, sm: 40 }, color: 'text.secondary' }}>
            Skip
          </Button>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {stepIndex > 0 && (
              <Button size="small" onClick={() => setStepIndex((index) => index - 1)} sx={{ minHeight: { xs: 48, sm: 40 } }}>
                Back
              </Button>
            )}
            <Button variant="contained" onClick={() => (isLast ? finish() : setStepIndex((index) => index + 1))} sx={{ minHeight: { xs: 48, sm: 40 } }}>
              {isLast ? 'Finish' : 'Next'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
