import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import { BRAND } from '../theme'
import './IntroAnimation.css'

/**
 * In-app intro animation.
 *
 * This is a native React port of the app's former standalone intro page. It no
 * longer ships as its own HTML file: ECharts comes from the app's bundled
 * `echarts` package (no CDN) and the typography is the app's own Lora + IBM
 * Plex Mono, so the whole thing runs offline inside the frontend bundle and
 * wears the warm app theme.
 *
 * Six scenes auto-advance on a timer (Intro → Query → Charts → Scripts → AI →
 * Finale), each with its own entrance choreography, a typewriter for the code
 * scenes, an ECharts chart that cycles bar → line → pie, and a canvas particle
 * backdrop. Arrow keys / clickable progress segments / Replay all work, and
 * `prefers-reduced-motion` collapses the motion.
 *
 * The copy and the mock-window tab strip mirror the app's real navigation:
 * charts and scripts both live under the Analyze tab, so the demo window shows
 * the true top-level tabs (Query / Analyze / Dashboard / Tools) and highlights
 * the tab each scene belongs to.
 */

const SCENE_DURATIONS = [5600, 8000, 8200, 7800, 7600, 0]

/** Which nav tab each scene sits under — charts and scripts both live in Analyze. */
const SCENE_TAB_INDEX: (number | null)[] = [null, 0, 1, 1, 0, null]

const SQL =
  "SELECT region, revenue\nFROM orders\nWHERE status = 'Shipped'\n  AND order_date >= CURRENT_DATE - 30\nORDER BY revenue DESC;"
const PY = 'df["share"] = df.revenue / df.revenue.sum()\nprint(df.nlargest(3, "revenue"))'
const OUTPUT =
  '  region   revenue  share\n  East       52700  0.253\n  North      48200  0.231\n  Central    41100  0.197'

const PALETTE = {
  ink: BRAND.ink,
  mute: '#6b6a63',
  line: BRAND.lightGray,
  blue: BRAND.blue,
  accent: BRAND.clay,
  sage: BRAND.sage,
}

const RESULT_ROWS = [
  { region: 'East', revenue: '52,700' },
  { region: 'North', revenue: '48,200' },
  { region: 'Central', revenue: '41,100' },
  { region: 'South', revenue: '36,900' },
  { region: 'West', revenue: '29,400' },
]

type ChartKind = 'bar' | 'line' | 'pie'

const REGIONS = ['East', 'North', 'Central', 'South', 'West']
const REGION_VALUES = [52.7, 48.2, 41.1, 36.9, 29.4]

/** Inline custom-property style, e.g. `style={d('.15s')}` for a delay. */
const d = (v: string): CSSProperties => ({ '--d': v } as CSSProperties)

function buildChartOption(kind: ChartKind, animate: boolean): EChartsOption {
  const axis = {
    axisLine: { lineStyle: { color: PALETTE.line } },
    axisLabel: { color: PALETTE.mute },
    splitLine: { lineStyle: { color: PALETTE.line } },
  }
  const base: EChartsOption = {
    animationDuration: animate ? 900 : 0,
    textStyle: { color: PALETTE.mute },
    grid: { left: 36, right: 10, top: 14, bottom: 26 },
  }

  if (kind === 'pie') {
    return {
      ...base,
      color: [PALETTE.blue, PALETTE.accent, PALETTE.sage, '#9b7fd4', '#d98aa0'],
      series: [
        {
          type: 'pie',
          radius: ['38%', '68%'],
          label: { color: PALETTE.ink },
          data: REGIONS.map((name, i) => ({ name, value: REGION_VALUES[i] })),
        },
      ],
    }
  }

  if (kind === 'line') {
    return {
      ...base,
      xAxis: { type: 'category', data: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'], ...axis },
      yAxis: { type: 'value', ...axis },
      series: [
        {
          type: 'line',
          smooth: true,
          symbolSize: 8,
          data: [31, 34, 33, 40, 46, 52],
          itemStyle: { color: PALETTE.accent },
          lineStyle: { width: 3 },
          areaStyle: { opacity: 0.18, color: PALETTE.accent },
        },
      ],
    }
  }

  return {
    ...base,
    xAxis: { type: 'category', data: REGIONS, ...axis },
    yAxis: { type: 'value', ...axis },
    series: [
      { type: 'bar', data: REGION_VALUES, itemStyle: { color: PALETTE.blue, borderRadius: [4, 4, 0, 0] } },
    ],
  }
}

/** Types `text` out once `active` turns true; restarts when it re-activates. */
function useTypewriter(active: boolean, text: string, delayMs: number, speedMs: number, reduced: boolean) {
  const [value, setValue] = useState('')

  useEffect(() => {
    if (!active) return
    if (reduced) {
      setValue(text)
      return
    }
    setValue('')
    let i = 0
    let timer = 0
    const step = () => {
      i += 1
      setValue(text.slice(0, i))
      if (i < text.length) timer = window.setTimeout(step, speedMs)
    }
    const start = window.setTimeout(step, delayMs)
    return () => {
      window.clearTimeout(start)
      window.clearTimeout(timer)
    }
  }, [active, text, delayMs, speedMs, reduced])

  return value
}

export default function IntroAnimation() {
  const { t } = useTranslation('intro')

  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const sceneLabels = useMemo(
    () => [
      t('intro.scenes.intro'),
      t('intro.scenes.query'),
      t('intro.scenes.charts'),
      t('intro.scenes.scripts'),
      t('intro.scenes.ai'),
      t('intro.scenes.finale'),
    ],
    [t],
  )

  const navTabs = useMemo(
    () => [
      t('intro.nav.query'),
      t('intro.nav.analyze'),
      t('intro.nav.dashboard'),
      t('intro.nav.tools'),
    ],
    [t],
  )

  const captions = useMemo(
    () => [
      { title: t('intro.captions.connect.title'), body: t('intro.captions.connect.body') },
      { title: t('intro.captions.charts.title'), body: t('intro.captions.charts.body') },
      { title: t('intro.captions.scripts.title'), body: t('intro.captions.scripts.body') },
      { title: t('intro.captions.ai.title'), body: t('intro.captions.ai.body') },
    ],
    [t],
  )

  const chartLabels = useMemo(
    () => [
      t('intro.demo.charts.bar'),
      t('intro.demo.charts.trend'),
      t('intro.demo.charts.pie'),
      t('intro.demo.charts.scatter'),
      t('intro.demo.charts.histogram'),
      t('intro.demo.charts.box'),
    ],
    [t],
  )

  const queryChips = useMemo(
    () => ['Sales DSN', 'orders', 'region, revenue', 'status = Shipped', t('intro.demo.last30Days')],
    [t],
  )

  const aiText = t('intro.demo.aiAnswer')

  const [scene, setScene] = useState(0)
  const [chartKind, setChartKind] = useState<ChartKind>('bar')

  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartElRef = useRef<HTMLDivElement | null>(null)

  const go = useCallback((i: number) => {
    setScene(Math.max(0, Math.min(SCENE_DURATIONS.length - 1, i)))
  }, [])

  // Auto-advance through the scenes (the last one is terminal).
  useEffect(() => {
    const dur = SCENE_DURATIONS[scene]
    if (!dur) return
    const timer = window.setTimeout(() => go(scene + 1), dur)
    return () => window.clearTimeout(timer)
  }, [scene, go])

  // Keyboard navigation: right / space advance, left goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        go(scene + 1)
      } else if (e.key === 'ArrowLeft') {
        go(scene - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scene, go])

  // The chart scene owns an ECharts instance that cycles bar → line → pie.
  useEffect(() => {
    if (scene !== 2) return
    const el = chartElRef.current
    if (!el) return

    const chart = echarts.init(el)
    const setKind = (kind: ChartKind) => {
      setChartKind(kind)
      chart.setOption(buildChartOption(kind, !reduced), true)
    }
    setKind('bar')

    const timers = [
      window.setTimeout(() => setKind('line'), 2700),
      window.setTimeout(() => setKind('pie'), 5200),
    ]
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(el)

    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      observer.disconnect()
      chart.dispose()
    }
  }, [scene, reduced])

  // Data-point particle backdrop.
  useEffect(() => {
    const canvas = canvasRef.current
    const root = rootRef.current
    if (!canvas || !root) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let W = root.clientWidth || window.innerWidth
    let H = root.clientHeight || window.innerHeight

    const points = Array.from({ length: 64 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
    }))

    const size = () => {
      W = root.clientWidth || window.innerWidth
      H = root.clientHeight || window.innerHeight
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    size()

    let raf = 0
    const draw = () => {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = PALETTE.blue
      ctx.strokeStyle = PALETTE.blue
      for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (!reduced) {
          p.x = (p.x + p.vx + W) % W
          p.y = (p.y + p.vy + H) % H
        }
        ctx.globalAlpha = 0.55
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2)
        ctx.fill()
        for (let j = i + 1; j < points.length; j++) {
          const q = points[j]
          const dist = Math.hypot(p.x - q.x, p.y - q.y)
          if (dist < 140) {
            ctx.globalAlpha = 0.18 * (1 - dist / 140)
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(q.x, q.y)
            ctx.stroke()
          }
        }
      }
      if (!reduced) raf = requestAnimationFrame(draw)
    }
    draw()

    window.addEventListener('resize', size)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', size)
    }
  }, [reduced])

  const sql = useTypewriter(scene === 1, SQL, 1000, 22, reduced)
  const py = useTypewriter(scene === 3, PY, 600, 26, reduced)
  const ai = useTypewriter(scene === 4, aiText, 1500, 24, reduced)

  const scriptRan = scene === 3 && py === PY
  const aiRan = scene === 4 && ai === aiText
  const chartChipIndex = chartKind === 'bar' ? 0 : chartKind === 'line' ? 1 : 2
  const windowVisible = scene > 0 && scene < 5

  return (
    <div className="intro-anim" ref={rootRef}>
      <canvas ref={canvasRef} className="ia-bg" aria-hidden="true" />

      <div className="ia-mark">
        <i />
        ODBC Query App
      </div>

      <main className="ia-stage">
        {/* Scene 0 — Intro */}
        <section className={`ia-s ${scene === 0 ? 'on' : ''}`} aria-hidden={scene !== 0}>
          <h1>
            <b>
              <span style={d('.1s')}>{t('intro.hero.query')}</span>
            </b>{' '}
            <b>
              <span className="ia-ol" style={d('.3s')}>
                {t('intro.hero.analyze')}
              </span>
            </b>{' '}
            <b>
              <span className="ia-am" style={d('.5s')}>
                {t('intro.hero.dashboard')}
              </span>
            </b>{' '}
            <b>
              <span className="ia-bl" style={d('.7s')}>
                {t('intro.hero.ask')}
              </span>
            </b>
          </h1>
          <p className="ia-lead ia-up" style={d('1.5s')}>
            {t('intro.hero.lead')}
          </p>
        </section>

        {/* Scenes 1–4 — the app window */}
        <section className={`ia-w ${windowVisible ? 'vis' : ''}`} aria-hidden={!windowVisible}>
          <div className="ia-caps">
            {captions.map((caption, i) => (
              <div key={caption.title} className={`ia-cp ${scene === i + 1 ? 'on' : ''}`}>
                <h2 className="ia-up">{caption.title}</h2>
                <p className="ia-up" style={d('.15s')}>
                  {caption.body}
                </p>
              </div>
            ))}
          </div>

          <div className="ia-win" aria-hidden="true">
            <div className="ia-tabs">
              <i />
              <i />
              <i />
              {navTabs.map((label, i) => (
                <span key={label} className={`ia-tb ${SCENE_TAB_INDEX[scene] === i ? 'on' : ''}`}>
                  {label}
                </span>
              ))}
            </div>

            <div className="ia-body">
              {/* Query */}
              <div className={`ia-pn ${scene === 1 ? 'on' : ''}`}>
                <div className="ia-chips">
                  {queryChips.map((chip, i) => (
                    <span key={chip} className="ia-up" style={d(`${0.1 + i * 0.15}s`)}>
                      {chip}
                    </span>
                  ))}
                </div>
                <pre className="ia-code">{sql}</pre>
                <table>
                  <tbody>
                    <tr>
                      <th>region</th>
                      <th>revenue</th>
                    </tr>
                    {RESULT_ROWS.map((row, i) => (
                      <tr key={row.region} className="ia-fi" style={d(`${3.4 + i * 0.2}s`)}>
                        <td>{row.region}</td>
                        <td>{row.revenue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Chart */}
              <div className={`ia-pn ${scene === 2 ? 'on' : ''}`}>
                <div className="ia-chips">
                  {chartLabels.map((label, i) => (
                    <span key={label} className={chartChipIndex === i ? 'hot' : ''}>
                      {label}
                    </span>
                  ))}
                </div>
                <div className="ia-chart" ref={chartElRef} />
              </div>

              {/* Script */}
              <div className={`ia-pn ${scene === 3 ? 'on' : ''} ${scriptRan ? 'ran' : ''}`}>
                <pre className="ia-code">{py}</pre>
                <span className="ia-run">{t('intro.demo.run')}</span>
                <pre className="ia-out">{OUTPUT}</pre>
              </div>

              {/* AI assistant */}
              <div className={`ia-pn ${scene === 4 ? 'on' : ''} ${aiRan ? 'ran' : ''}`}>
                <div className="ia-b ia-me ia-up" style={d('.2s')}>
                  {t('intro.demo.aiQuestion')}
                </div>
                <div className="ia-b ia-ai ia-up" style={d('.9s')}>
                  <span className="ia-ty">{ai}</span>
                </div>
                <div className="ia-acts">
                  <span>{t('intro.demo.actions.sql')}</span>
                  <span>{t('intro.demo.actions.script')}</span>
                  <span>{t('intro.demo.actions.chart')}</span>
                  <span>{t('intro.demo.actions.explain')}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Scene 5 — Finale */}
        <section className={`ia-s ${scene === 5 ? 'on' : ''}`} aria-hidden={scene !== 5}>
          <h1>
            <b>
              <span style={d('.1s')}>{t('intro.final.data')}</span>
            </b>{' '}
            <b>
              <span className="ia-am" style={d('.35s')}>
                {t('intro.final.pc')}
              </span>
            </b>
          </h1>
          <div className="ia-pills ia-up" style={d('.9s')}>
            <span>{t('intro.nav.query')}</span>
            <span>{t('intro.nav.analyze')}</span>
            <span>{t('intro.nav.dashboard')}</span>
            <span>{t('intro.nav.tools')}</span>
            <span>{t('intro.final.ai')}</span>
            <span>{t('intro.final.export')}</span>
          </div>
          <p className="ia-lead ia-up" style={d('1.2s')}>
            {t('intro.final.lead')}
          </p>
          <button type="button" className="ia-go ia-up" style={d('1.5s')} onClick={() => go(0)}>
            {t('intro.watchAgain')}
          </button>
        </section>
      </main>

      <nav className="ia-bar" aria-label={t('intro.aria.progress')}>
        <div className="ia-segs">
          {sceneLabels.map((label, i) => {
            const isCurrent = i === scene && SCENE_DURATIONS[i] > 0
            const isDone = i < scene || (i === scene && SCENE_DURATIONS[i] === 0)
            return (
              <button
                key={label}
                type="button"
                className={`ia-seg ${isDone ? 'done' : ''} ${isCurrent ? 'cur' : ''}`}
                style={{ '--dur': `${SCENE_DURATIONS[i]}ms` } as CSSProperties}
                aria-label={label}
                aria-current={i === scene ? 'step' : undefined}
                onClick={() => go(i)}
              />
            )
          })}
        </div>
        <button type="button" className="ia-rp" onClick={() => go(0)}>
          {t('intro.replay')}
        </button>
      </nav>
    </div>
  )
}
