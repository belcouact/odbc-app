// Redesigned intro: three acts (Query, Analyze, Ask) on one horizontal "camera dolly".
// Source: backend/templates/IntroV2_2.tsx — wired to the app's i18n (EN/ZH).
// Requires: motion, gsap (installed in package.json).
import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import gsap from 'gsap'

const DUR = [6500, 9000, 9500, 9500, 0]
const SQL = "SELECT region, revenue\nFROM orders\nWHERE status = 'Shipped'\n  AND order_date >= CURRENT_DATE - 30\nORDER BY revenue DESC;"
const PY = 'total = df.revenue.sum()\ndf["share"] = df.revenue / total\nprint(df.sort_values("share").head(3))'
const ROWS: [string, number][] = [['East', 52700], ['North', 48200], ['Central', 41100], ['South', 36900], ['West', 29400]]
const SHARE = [0.253, 0.231, 0.197, 0.177, 0.141]
const DRIVERS = ['SQL Server', 'Oracle', 'DB2', 'Access', 'MySQL', 'any ODBC driver']

const par = { hidden: {}, show: { transition: { staggerChildren: 0.12, delayChildren: 0.15 } } }
const up = { hidden: { opacity: 0, y: 28 }, show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 110, damping: 16 } } }
const mask = { hidden: { y: '110%' }, show: { y: 0, transition: { type: 'spring' as const, stiffness: 90, damping: 16 } } }
const chip = { hidden: { scale: 0, opacity: 0 }, show: { scale: 1, opacity: 1, transition: { type: 'spring' as const, stiffness: 320, damping: 14 } } }
const chips = (delay: number) => ({ hidden: {}, show: { transition: { staggerChildren: 0.15, delayChildren: delay } } })

function useTyped(text: string, on: boolean, delay: number, speed: number, tick?: (ch: string) => void) {
  const tk = useRef(tick)
  tk.current = tick
  const [n, setN] = useState(0)
  const reduce = useReducedMotion()
  useEffect(() => {
    setN(0)
    if (!on) return
    if (reduce) { setN(text.length); return }
    let i = 0, id = 0
    const t = window.setTimeout(() => { id = window.setInterval(() => { setN(++i); tk.current?.(text[i - 1]); if (i >= text.length) clearInterval(id) }, speed) }, delay)
    return () => { clearTimeout(t); clearInterval(id) }
  }, [on, text, reduce, delay, speed])
  return text.slice(0, n)
}

/* ---------- sound design: synthesized one-shot effects, no audio files, no background drone ---------- */
const PENT = [523, 587, 659, 784, 880, 1047, 1175, 1319]
function useSound() {
  const ac = useRef<AudioContext | null>(null)
  const bus = useRef<GainNode | null>(null)
  const live = useRef(false)
  const [on, setOn] = useState(false)
  const boot = () => {
    if (ac.current) return
    const c = new AudioContext(), comp = c.createDynamicsCompressor(), m = c.createGain(), d = c.createDelay(), f = c.createGain(), lp = c.createBiquadFilter()
    m.gain.value = 1; d.delayTime.value = 0.2; f.gain.value = 0.25; lp.type = 'lowpass'; lp.frequency.value = 3000
    m.connect(comp); m.connect(d); d.connect(lp); lp.connect(f); f.connect(d); lp.connect(comp); comp.connect(c.destination)
    ac.current = c; bus.current = m
  }
  const ready = () => live.current && !!ac.current && !!bus.current
  const tone = (f: number, at: number, d: number, ty: OscillatorType = 'sine', v = 0.05, f2?: number) => {
    if (!ready()) return
    const c = ac.current!, t = c.currentTime + at, o = c.createOscillator(), g = c.createGain()
    o.type = ty; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.02, d / 3)); g.gain.exponentialRampToValueAtTime(0.0001, t + d)
    o.connect(g); g.connect(bus.current!); o.start(t); o.stop(t + d + 0.05)
  }
  const noise = (d: number, f0: number, f1: number, v: number, q = 4) => {
    if (!ready()) return
    const c = ac.current!, t = c.currentTime, n = Math.floor(c.sampleRate * d), b = c.createBuffer(1, n, c.sampleRate), src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain()
    const ch = b.getChannelData(0); for (let i = 0; i < n; i++) ch[i] = Math.random() * 2 - 1
    src.buffer = b; bp.type = 'bandpass'; bp.Q.value = q; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + d)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + d * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + d)
    src.connect(bp); bp.connect(g); g.connect(bus.current!); src.start(t)
  }
  const bell = (f: number, at = 0, v = 0.06, d = 1.4) => { tone(f, at, d, 'sine', v); tone(f * 2.76, at, d * 0.4, 'sine', v * 0.35); tone(f * 5.4, at, d * 0.15, 'sine', v * 0.15) }
  const toggle = () => { live.current = !live.current; setOn(live.current); if (live.current) { boot(); ac.current!.resume() } }
  useEffect(() => () => { const c = ac.current; if (c) setTimeout(() => c.close(), 3500) }, [])
  return {
    on, toggle, tone, bell,
    whoosh: () => noise(0.75, 300, 3200, 0.2, 3),
    swoop: () => tone(900, 0, 0.5, 'sine', 0.07, 180),
    boom: () => { tone(90, 0, 0.6, 'sine', 0.3, 32); noise(0.25, 1200, 150, 0.12, 0.8) },
    hit: (f: number) => { tone(f, 0, 0.25, 'sawtooth', 0.06, f * 0.5); noise(0.08, 1500, 400, 0.08, 1) },
    key: (ch = 'a') => {
      if (ch === '\n') { noise(0.06, 2000, 900, 0.16, 1); tone(110, 0, 0.12, 'square', 0.05, 60); tone(1760, 0.03, 0.5, 'sine', 0.04); return }
      if (ch === ' ') { noise(0.04, 1200, 800, 0.08, 1); tone(140, 0, 0.06, 'square', 0.025, 70); return }
      noise(0.03, 2500 + Math.random() * 2500, 1800, 0.11, 2); tone(150 + Math.random() * 60, 0, 0.05, 'square', 0.025, 80)
    },
    blip: () => tone(PENT[Math.floor(Math.random() * PENT.length)] * 2, 0, 0.07, 'sine', 0.035),
    pop: (i = 0) => tone(480 + i * 85, 0, 0.14, 'sine', 0.09, 900 + i * 85),
    tick: (i = 0) => tone(1100 + i * 140, 0, 0.05, 'square', 0.025),
    click: () => { noise(0.05, 4000, 2000, 0.14, 3); tone(1800, 0, 0.04, 'square', 0.035, 900) },
    pluck: (f: number) => { tone(f, 0, 0.5, 'triangle', 0.08); tone(f * 2, 0, 0.2, 'sine', 0.025) },
    ratchet: (n: number, d: number) => { for (let i = 0; i < n; i++) tone(900 + i * 60, i * (d / n), 0.04, 'square', 0.025) },
    crunch: (n = 8) => { for (let i = 0; i < n; i++) tone(600 + (i % 4) * 220 + Math.random() * 80, i * 0.045, 0.05, 'square', 0.024) },
    sparkle: (n = 6) => { for (let i = 0; i < n; i++) { const f = PENT[i % PENT.length] * 2; tone(f, i * 0.06, 0.35, 'sine', 0.04); tone(f * 2, i * 0.06, 0.15, 'sine', 0.014) } },
    scan: () => noise(0.5, 600, 4000, 0.12, 6),
    alarm: () => { tone(311, 0, 0.45, 'triangle', 0.08); tone(330, 0.06, 0.45, 'triangle', 0.06) },
    chime: (a: number[], sp = 0.08, d = 1.2) => a.forEach((f, i) => bell(f, i * sp, 0.05, d)),
  }
}

const DECOR = [
  { c: 'var(--v-blue)', r: '50%', cp: 'none' }, { c: 'var(--v-yellow)', r: '50% 50% 0 0', cp: 'none' },
  { c: 'var(--v-red)', r: '0', cp: 'polygon(50% 0,100% 100%,0 100%)' }, { c: 'var(--v-blue)', r: '50% 0 50% 0', cp: 'none' },
  { c: 'var(--v-red)', r: '50%', cp: 'none' },
]
function Act({ i, on, children }: { i: number; on: boolean; children: ReactNode }) {
  const d = DECOR[i]
  return (
    <section className="v-act" aria-hidden={!on}>
      <motion.div className="v-decor" style={{ background: d.c, borderRadius: d.r, clipPath: d.cp }} animate={{ rotate: 360 }} transition={{ duration: 60, repeat: Infinity, ease: 'linear' }} />
      <motion.div className="v-in" variants={par} initial="hidden" animate={on ? 'show' : 'hidden'}>{children}</motion.div>
    </section>
  )
}
const Cap = ({ n, h, p, extra }: { n: string; h: string; p: string; extra?: ReactNode }) => (
  <div className="v-cap">
    <motion.div variants={up} className="v-num">{n}</motion.div>
    <motion.h2 variants={up}>{h}</motion.h2>
    <motion.p variants={up}>{p}</motion.p>
    {extra}
  </div>
)
const Caret = () => <span className="v-caret" />

export default function IntroV2({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('intro')
  const reduce = useReducedMotion()
  const [scene, setScene] = useState(0)
  const snd = useSound()
  const root = useRef<HTMLDivElement>(null)
  const conv = useRef<HTMLDivElement>(null)
  const rows = useMotionValue(0)
  const rowsTxt = useTransform(rows, v => t('intro.v2.queryCard.rows', { n: Math.round(v).toLocaleString() }))

  const LABEL = [t('intro.v2.labels.idea'), t('intro.v2.labels.n1'), t('intro.v2.labels.n2'), t('intro.v2.labels.n3'), t('intro.v2.labels.loop')]
  const drivers = [...DRIVERS.slice(0, -1), t('intro.v2.anyDriver')]
  const qChips = ['Sales DSN', 'orders', 'region, revenue', 'status = Shipped', t('intro.v2.queryCard.last30')]

  useEffect(() => { rows.set(0); if (scene !== 1) return; const a = animate(rows, 1284, { duration: reduce ? 0 : 1.4, delay: reduce ? 0 : 4.4, ease: 'easeOut' }); return () => a.stop() }, [scene, reduce, rows])
  useEffect(() => { if (!DUR[scene]) return; const t = setTimeout(() => setScene(s => s + 1), DUR[scene]); return () => clearTimeout(t) }, [scene])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); setScene(s => Math.min(4, s + 1)) }
      else if (e.key === 'ArrowLeft') setScene(s => Math.max(0, s - 1))
    }
    addEventListener('keydown', k); return () => removeEventListener('keydown', k)
  }, [onClose])

  /* GSAP: endless conveyor of data rows that travels with the camera, plus pointer parallax */
  useEffect(() => {
    const els = Array.from(conv.current!.children) as HTMLElement[], W = innerWidth * 5
    els.forEach((el, i) => {
      const s = 10 + (i % 4) * 3
      Object.assign(el.style, { width: s + 'px', height: s + 'px', top: ((i * 37) % 44) + 'px' })
      if (reduce) gsap.set(el, { x: (W / els.length) * i }); else gsap.fromTo(el, { x: -30 }, { x: W, duration: 28, ease: 'none', repeat: -1, delay: -(i * 28) / els.length })
    })
    const mv = (e: PointerEvent) => { if (!reduce) gsap.to(root.current!.querySelectorAll('.v-decor'), { x: (e.clientX / innerWidth - 0.5) * 40, y: (e.clientY / innerHeight - 0.5) * 40, duration: 1, overwrite: 'auto' }) }
    addEventListener('pointermove', mv)
    return () => { gsap.killTweensOf(els); removeEventListener('pointermove', mv) }
  }, [reduce])

  const sql = useTyped(SQL, scene === 1, 900, 22, ch => snd.key(ch))
  const py = useTyped(PY, scene === 2, 900, 26, ch => snd.key(ch))
  const ai = useTyped(t('intro.v2.aiMsg'), scene === 3, 1600, 22, () => snd.blip())
  const aiText = t('intro.v2.aiMsg')
  const pyDone = py === PY, aiDone = ai === aiText, hl = scene === 3 && ai.length > 12

  /* scene cues, timed against the animation delays */
  useEffect(() => {
    if (!snd.on) return
    const T: number[] = [], at = (f: () => void, ms: number) => T.push(window.setTimeout(f, ms))
    if (scene > 0) { snd.whoosh(); snd.swoop(); at(() => snd.boom(), 650) }
    if (scene === 0) {
      ;[0, 120, 240].forEach((d, i) => at(() => snd.hit(110 * (1 + i * 0.25)), 150 + d))
      at(() => snd.sparkle(5), 500)
      ;[392, 494, 587, 740].forEach((f, i) => at(() => snd.pluck(f), 600 + i * 180))
      at(() => { snd.click(); snd.bell(1319, 0, 0.05, 1) }, 1500)
      DRIVERS.forEach((_, i) => at(() => snd.pop(i), 1000 + i * 150))
    }
    if (scene === 1) {
      for (let i = 0; i < 5; i++) { at(() => snd.pop(i), 900 + i * 150); at(() => { snd.tick(i); snd.tone(220 + i * 40, 0, 0.12, 'triangle', 0.05) }, 4500 + i * 200) }
      at(() => { snd.bell(1568, 0, 0.05, 1.1); snd.tone(110, 0, 0.15, 'square', 0.05, 60) }, 3200)
      at(() => snd.ratchet(14, 1.3), 4900)
      at(() => { snd.bell(1047); snd.bell(1568, 0.12) }, 6300)
    }
    if (scene === 3) { at(() => { snd.swoop(); snd.pop(3) }, 600); at(() => { snd.bell(880); snd.bell(1319, 0.12); snd.sparkle(3) }, 1250) }
    if (scene === 4) {
      ;[523, 659, 784].forEach((f, i) => at(() => { snd.bell(f); snd.swoop() }, 600 + i * 200))
      at(() => { snd.chime([262, 330, 392, 523], 0.05, 2.4); snd.sparkle(10) }, 1500)
      at(() => snd.bell(2093, 0, 0.04, 2), 2200)
    }
    return () => T.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, snd.on])
  useEffect(() => {
    if (!pyDone) return
    const T: number[] = [], at = (f: () => void, ms: number) => T.push(window.setTimeout(f, ms))
    snd.click(); snd.crunch(10)
    at(() => snd.chime([523, 659, 784, 1047], 0.06, 1.2), 500)
    SHARE.forEach((_, i) => at(() => (i === 4 ? snd.alarm() : snd.pluck(392 + i * 70)), 900 + i * 110))
    return () => T.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pyDone])
  useEffect(() => {
    if (!aiDone) return
    snd.sparkle(8); snd.chime([1047, 1319, 1568], 0.09, 1.4)
    const T = [0, 1, 2].map(i => window.setTimeout(() => snd.pop(i), 500 + i * 120))
    return () => T.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDone])
  useEffect(() => { if (hl) { snd.scan(); snd.bell(1047, 0.3, 0.05, 1) } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl])

  return (
    <div className="v-root" ref={root} role="dialog" aria-label={t('intro.v2.dialogAria')}>
      <style>{CSS}</style>
      <header className="v-top">
        <b>{t('intro.v2.brand')}</b>
        <span className="v-local"><i />{t('intro.v2.runsLocal')}</span>
        <button className="v-ghost" aria-pressed={snd.on} onClick={snd.toggle}>{snd.on ? t('intro.v2.soundOn') : t('intro.v2.soundOff')}</button>
        <button className="v-ghost" onClick={onClose}>{t('intro.v2.skip')}</button>
      </header>

      <main className="v-stage">
        <motion.div className="v-track" animate={{ x: `${-scene * 100}vw` }} transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 55, damping: 18 }}>
          <div className="v-conv" ref={conv} aria-hidden>{Array.from({ length: 36 }, (_, i) => <span key={i} className={'v-sq v-sq' + (i % 3)} />)}</div>

          <Act i={0} on={scene === 0}>
            <div className="v-hero">
              <h1>{[t('intro.v2.hero1'), t('intro.v2.hero2'), t('intro.v2.hero3')].map((w, i) => <span className="v-ln" key={w}><motion.span variants={mask} className={'v-c' + i}>{w}</motion.span></span>)}</h1>
              <motion.p variants={up} className="v-lead">{t('intro.v2.lead')}</motion.p>
              <motion.div className="v-tags" variants={chips(0.9)}>{drivers.map(d => <motion.span key={d} variants={chip}>{d}</motion.span>)}</motion.div>
            </div>
            <svg className="v-db" viewBox="0 0 200 258" aria-hidden>
              {['M20 50V190', 'M180 50V190'].map(d => <motion.path key={d} d={d} className="v-st" initial={{ pathLength: 0 }} animate={{ pathLength: scene === 0 ? 1 : 0 }} transition={{ duration: 0.8, delay: 0.5 }} />)}
              {[50, 105, 150].map((y, i) => <motion.path key={y} d={`M20 ${y}A80 28 0 0 0 180 ${y}`} className="v-st" initial={{ pathLength: 0 }} animate={{ pathLength: scene === 0 ? 1 : 0 }} transition={{ duration: 0.8, delay: 0.7 + i * 0.15 }} />)}
              <motion.path d="M20 190A80 28 0 0 0 180 190" className="v-st" initial={{ pathLength: 0 }} animate={{ pathLength: scene === 0 ? 1 : 0 }} transition={{ duration: 0.8, delay: 1 }} />
              <motion.ellipse cx="100" cy="50" rx="80" ry="28" className="v-st v-fill" initial={{ scale: 0 }} animate={{ scale: scene === 0 ? 1 : 0 }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} transition={{ type: 'spring', delay: 0.4 }} />
              <motion.g initial={{ scale: 0 }} animate={{ scale: scene === 0 ? 1 : 0 }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} transition={{ type: 'spring', delay: 1.4 }}>
                <rect x="78" y="128" width="44" height="34" rx="6" className="v-lock" /><path d="M86 128v-10a14 14 0 0 1 28 0v10" className="v-st" fill="none" />
              </motion.g>
              <text x="100" y="250" className="v-lab">ODBC</text>
            </svg>
          </Act>

          <Act i={1} on={scene === 1}>
            <Cap n="01" h={t('intro.v2.cap1.title')} p={t('intro.v2.cap1.body')}
              extra={<motion.div variants={up} className="v-badges"><span>{t('intro.v2.cap1.readOnly')}</span><span>{t('intro.v2.cap1.creds')}</span></motion.div>} />
            <motion.div variants={up} className="v-card">
              <div className="v-bar2"><span>{t('intro.v2.queryCard.title')}</span><motion.em>{rowsTxt}</motion.em></div>
              <div className="v-body">
                <motion.div className="v-chips" variants={chips(0.4)}>{qChips.map(c => <motion.span key={c} variants={chip}>{c}</motion.span>)}</motion.div>
                <pre className="v-code">{sql}<Caret /></pre>
                <table><tbody>
                  <tr><th>{t('intro.v2.thRegion')}</th><th>{t('intro.v2.thRevenue')}</th></tr>
                  {ROWS.map(([n, v], i) => <motion.tr key={n} variants={{ hidden: { opacity: 0, x: -14 }, show: { opacity: 1, x: 0, transition: { delay: 4 + i * 0.2 } } }}><td>{n}</td><td>{v.toLocaleString()}</td></motion.tr>)}
                </tbody></table>
              </div>
            </motion.div>
          </Act>

          <Act i={2} on={scene === 2}>
            <Cap n="02" h={t('intro.v2.cap2.title')} p={t('intro.v2.cap2.body')}
              extra={<motion.div variants={up} className="v-badges"><span>Python</span><span>JavaScript</span><span>{t('intro.v2.cap2.fromGrid')}</span></motion.div>} />
            <motion.div variants={up} className="v-card">
              <div className="v-bar2"><span>{t('intro.v2.scriptCard.title')}</span><motion.em animate={pyDone ? { scale: [1, 1.15, 1] } : {}}>{pyDone ? t('intro.v2.scriptCard.ran') : 'Python'}</motion.em></div>
              <div className="v-body">
                <pre className="v-code">{py}<Caret /></pre>
                <div className="v-split">
                  <motion.pre className="v-out" animate={{ opacity: pyDone ? 1 : 0.15 }}>{'  region   revenue  share\n  West       29400  0.141\n  South      36900  0.177\n  Central    41100  0.197'}</motion.pre>
                  <svg viewBox="0 0 200 100" className="v-mini" aria-hidden>
                    {SHARE.map((s, i) => <motion.rect key={i} x={6 + i * 38} y={96 - s * 330} width={28} height={s * 330} rx={3} fill={i === 4 ? 'var(--v-red)' : 'var(--v-blue)'}
                      style={{ transformBox: 'fill-box', transformOrigin: 'bottom' }} animate={{ scaleY: pyDone ? 1 : 0 }} transition={{ delay: 0.3 + i * 0.1, type: 'spring', stiffness: 140, damping: 14 }} />)}
                  </svg>
                </div>
              </div>
            </motion.div>
          </Act>

          <Act i={3} on={scene === 3}>
            <Cap n="03" h={t('intro.v2.cap3.title')} p={t('intro.v2.cap3.body')}
              extra={<motion.div variants={up} className="v-badges"><span>{t('intro.v2.cap3.explain')}</span><span>{t('intro.v2.cap3.writeSql')}</span><span>{t('intro.v2.cap3.buildScripts')}</span></motion.div>} />
            <motion.div variants={up} className="v-card">
              <div className="v-bar2"><span>{t('intro.v2.aiCard.title')}</span><em>{t('intro.v2.aiCard.seesGrid')}</em></div>
              <div className="v-body v-ask">
                <table><tbody>
                  <tr><th>{t('intro.v2.thRegion')}</th><th>{t('intro.v2.thRevenue')}</th></tr>
                  {ROWS.map(([n, v]) => <motion.tr key={n} initial={false} animate={{ backgroundColor: n === 'West' && ai.length > 12 ? 'rgba(255,74,42,.3)' : 'rgba(255,74,42,0)' }}><td>{n}</td><td>{v.toLocaleString()}</td></motion.tr>)}
                </tbody></table>
                <div>
                  <motion.div className="v-b v-me" variants={{ hidden: { opacity: 0, x: 40 }, show: { opacity: 1, x: 0, transition: { delay: 0.5 } } }}>{t('intro.v2.question')}</motion.div>
                  <motion.div className="v-b v-ai" variants={{ hidden: { opacity: 0, x: -40 }, show: { opacity: 1, x: 0, transition: { delay: 1.1 } } }}>{ai}<Caret /></motion.div>
                  <motion.div className="v-chips" animate={{ opacity: aiDone ? 1 : 0, y: aiDone ? 0 : 10 }}><span>{t('intro.v2.suggest.script')}</span><span>{t('intro.v2.suggest.chart')}</span><span>{t('intro.v2.suggest.sql')}</span></motion.div>
                </div>
              </div>
            </motion.div>
          </Act>

          <Act i={4} on={scene === 4}>
            <div className="v-hero v-hero-fin">
              <h1>{[[t('intro.v2.final.l1'), t('intro.v2.final.l2')], [t('intro.v2.final.l3'), t('intro.v2.final.l4')]].map((pair, li) => <span className="v-ln" key={li}>{pair.map((w, i) => <motion.span key={w} variants={mask} className={'v-w v-c' + ((li * 2 + i) % 3)}>{w}</motion.span>)}</span>)}</h1>
              <motion.ul variants={up} className="v-pts">
                <li>{t('intro.v2.final.p1')}</li>
                <li>{t('intro.v2.final.p2')}</li>
                <li>{t('intro.v2.final.p3')}</li>
              </motion.ul>
              <motion.div variants={up} className="v-cta"><button className="v-go" onClick={() => { snd.chime([523, 659, 784, 1047], 0.07, 1.4); snd.sparkle(8); onClose() }}>{t('intro.v2.final.start')}</button><button className="v-ghost" onClick={() => setScene(0)}>{t('intro.v2.final.again')}</button></motion.div>
            </div>
            <svg className="v-loop" viewBox="0 0 400 400" aria-label={t('intro.v2.final.loopAria')}>
              <motion.circle cx="200" cy="200" r="130" className="v-ring" animate={{ rotate: 360 }} transition={{ duration: 40, repeat: Infinity, ease: 'linear' }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
              <circle r="8" fill="var(--v-yellow)" stroke="var(--v-ink)" strokeWidth="3"><animateMotion dur="6s" repeatCount="indefinite" path="M200 70A130 130 0 1 1 199.99 70" /></circle>
              {[[t('intro.v2.final.loopQuery'), 200, 70, 'var(--v-blue)'], [t('intro.v2.final.loopAnalyze'), 312.6, 265, 'var(--v-red)'], [t('intro.v2.final.loopAsk'), 87.4, 265, 'var(--v-ink)']].map(([txt, x, y, c], i) => (
                <motion.g key={txt as string} initial={{ scale: 0 }} animate={{ scale: scene === 4 ? 1 : 0 }} transition={{ type: 'spring', delay: 0.5 + i * 0.2 }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
                  <circle cx={x as number} cy={y as number} r="46" style={{ fill: c as string }} stroke="var(--v-ink)" strokeWidth="3" /><text x={x as number} y={(y as number) + 6} className="v-nt">{txt}</text>
                </motion.g>
              ))}
              <text x="200" y="196" className="v-lab">{t('intro.v2.final.localTitle')}</text><text x="200" y="218" className="v-lab2">{t('intro.v2.final.localSub')}</text>
            </svg>
          </Act>
        </motion.div>
      </main>

      <nav className="v-nav" aria-label={t('intro.aria.progress')}>
        {LABEL.map((l, i) => (
          <button key={l} className="v-seg" onClick={() => { snd.click(); setScene(i) }} aria-label={l} aria-current={i === scene}>
            <span className="v-trk">{i < scene || (i === scene && !DUR[i]) ? <b style={{ width: '100%' }} /> : i === scene ? <motion.b key={scene} initial={{ width: 0 }} animate={{ width: '100%' }} transition={{ duration: DUR[i] / 1000, ease: 'linear' }} /> : null}</span>
            <small>{l}</small>
          </button>
        ))}
      </nav>
    </div>
  )
}

const CSS = `
.v-root{--v-paper:#F3EFE6;--v-ink:#10131A;--v-card:#fff;--v-code:#10131A;--v-codeink:#F3EFE6;--v-blue:#2340FF;--v-red:#FF4A2A;--v-yellow:#FFC933;--v-green:#16A34A;--v-grid:rgba(16,19,26,.07);--v-mute:#4A5060;
position:fixed;inset:0;z-index:1400;display:flex;flex-direction:column;overflow:hidden;color:var(--v-ink);font-family:inherit;
background-color:var(--v-paper);background-image:linear-gradient(var(--v-grid) 1px,transparent 1px),linear-gradient(90deg,var(--v-grid) 1px,transparent 1px);background-size:48px 48px}
@media(prefers-color-scheme:dark){.v-root{--v-paper:#0F1218;--v-ink:#F3EFE6;--v-card:#181C25;--v-code:#080A0F;--v-grid:rgba(243,239,230,.07);--v-mute:#A3A9B8;--v-blue:#6C83FF}}
.v-top{display:flex;align-items:center;gap:14px;padding:16px clamp(20px,5vw,64px);font-weight:800;position:relative;z-index:2}
.v-local{margin-left:auto;font-size:13px;font-weight:700;border:2px solid var(--v-ink);border-radius:999px;padding:2px 12px;display:flex;align-items:center;gap:8px}
.v-local i{width:9px;height:9px;border-radius:50%;background:var(--v-green);animation:v-p 1.6s infinite}
@keyframes v-p{50%{box-shadow:0 0 0 7px rgba(22,163,74,0)}0%{box-shadow:0 0 0 0 rgba(22,163,74,.6)}}
.v-stage{flex:1;min-height:0;position:relative;overflow:hidden}
.v-track{display:flex;width:500vw;height:100%;position:relative}
.v-conv{position:absolute;left:0;right:0;bottom:14px;height:60px;pointer-events:none}
.v-sq{position:absolute;left:0;border:2px solid var(--v-ink)}.v-sq0{background:var(--v-blue)}.v-sq1{background:var(--v-red)}.v-sq2{background:var(--v-yellow)}
.v-act{flex:0 0 100vw;height:100%;position:relative;display:flex;padding:8px clamp(20px,5vw,64px) 70px;box-sizing:border-box;overflow:hidden}
.v-decor{position:absolute;right:-6vw;top:-8vh;width:min(34vw,380px);aspect-ratio:1;opacity:.9}
.v-in{position:relative;z-index:1;width:100%;margin:auto;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,8fr);gap:clamp(24px,5vw,64px);align-items:center}
@media(max-width:820px){.v-in{grid-template-columns:minmax(0,1fr);align-content:start;gap:16px}.v-act{overflow-y:auto}}
.v-hero{grid-column:1/2}
h1{margin:0;font-size:clamp(38px,7.2vw,104px);line-height:.95;letter-spacing:-.04em;font-weight:900}
.v-ln{display:block;overflow:hidden;width:max-content;padding-bottom:.08em}.v-ln span{display:block}
.v-hero-fin{grid-column:1/-1}.v-hero-fin h1{font-size:clamp(38px,6vw,88px)}.v-ln .v-w{display:inline-block;margin-right:.24em}
@media(min-width:821px) and (max-height:760px){h1{font-size:clamp(32px,5.4vw,78px)}.v-hero-fin h1{font-size:clamp(30px,4.6vw,66px)}}
.v-c0{color:var(--v-ink)}.v-c1{color:var(--v-blue)}.v-c2{color:var(--v-red)}
.v-lead{font-size:clamp(16px,1.8vw,21px);line-height:1.5;color:var(--v-mute);max-width:50ch;margin:22px 0 0}
.v-tags,.v-badges,.v-chips{display:flex;flex-wrap:wrap;gap:8px}
.v-tags{margin-top:20px}
.v-tags span,.v-badges span{font-size:14px;font-weight:700;border:2px solid var(--v-ink);border-radius:999px;padding:3px 12px;background:var(--v-card)}
.v-badges{margin-top:18px}.v-badges span{background:var(--v-yellow);color:#10131A}
.v-db{position:absolute;right:6vw;top:50%;width:min(24vw,260px);margin-top:calc(min(24vw,260px)*-.645);z-index:1}
@media(max-width:820px){.v-db{display:none}}
.v-st{fill:none;stroke:var(--v-ink);stroke-width:5;stroke-linecap:round}.v-fill{fill:var(--v-blue)}.v-lock{fill:var(--v-red);stroke:var(--v-ink);stroke-width:4}
.v-lab{font-weight:900;font-size:18px;fill:var(--v-ink);text-anchor:middle}.v-lab2{font-size:14px;fill:var(--v-mute);text-anchor:middle}
.v-num{font-size:clamp(70px,10vw,140px);font-weight:900;line-height:.85;color:transparent;-webkit-text-stroke:3px var(--v-ink);letter-spacing:-.05em}
h2{font-size:clamp(28px,3.8vw,52px);line-height:1;letter-spacing:-.03em;margin:10px 0 12px;font-weight:900}
.v-cap p{font-size:clamp(15px,1.6vw,19px);line-height:1.5;color:var(--v-mute);margin:0;max-width:38ch}
.v-card{background:var(--v-card);border:3px solid var(--v-ink);border-radius:10px;box-shadow:10px 10px 0 var(--v-ink);overflow:hidden}
.v-bar2{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;background:var(--v-ink);color:var(--v-paper);font-weight:800;font-size:14px}
.v-bar2 em{font-style:normal;background:var(--v-yellow);color:#10131A;border-radius:6px;padding:0 8px;font-size:13px}
.v-body{padding:14px 16px;height:clamp(300px,50vh,400px);overflow:hidden;box-sizing:border-box}
.v-chips{margin-bottom:10px}
.v-chips span{font-size:13px;font-weight:700;border:2px solid var(--v-blue);color:var(--v-blue);border-radius:999px;padding:1px 10px}
pre{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:clamp(11.5px,1.25vw,14px);line-height:1.6;white-space:pre-wrap}
.v-code{background:var(--v-code);color:var(--v-codeink);border-radius:6px;padding:12px;min-height:6.4em}
.v-caret{display:inline-block;width:7px;height:1.05em;background:var(--v-red);vertical-align:text-bottom;animation:v-b 1s steps(1) infinite}
@keyframes v-b{50%{opacity:0}}
table{border-collapse:collapse;width:100%;font-size:14px;margin-top:12px}
th,td{text-align:left;padding:6px 8px;border-bottom:2px solid var(--v-grid)}th{font-weight:800;border-bottom-color:var(--v-ink)}
td:last-child,th:last-child{text-align:right;font-variant-numeric:tabular-nums}
.v-split{display:flex;gap:12px;margin-top:12px;align-items:flex-end}.v-split>*{flex:1;min-width:0}
.v-out{border:2px solid var(--v-ink);border-radius:6px;padding:10px}.v-mini{height:110px}
.v-ask{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,6fr);gap:16px}
@media(max-width:820px){.v-ask{grid-template-columns:minmax(0,1fr)}}
.v-b{max-width:92%;padding:9px 13px;border:2px solid var(--v-ink);border-radius:12px;font-size:14px;line-height:1.5;margin:0 0 10px}
.v-me{margin-left:auto;background:var(--v-blue);color:#fff}.v-ai{background:var(--v-card)}
.v-pts{padding-left:20px;margin:22px 0 0;font-size:clamp(15px,1.7vw,19px);line-height:1.6;color:var(--v-mute);max-width:46ch}
.v-cta{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
.v-go{background:var(--v-red);color:#fff;border:3px solid var(--v-ink);border-radius:8px;padding:11px 22px;font:800 18px inherit;cursor:pointer;box-shadow:5px 5px 0 var(--v-ink)}
.v-ghost{font:inherit;font-size:15px;font-weight:700;color:var(--v-ink);border:2px solid var(--v-ink);background:var(--v-card);border-radius:6px;padding:4px 12px;cursor:pointer}
.v-loop{position:absolute;right:5vw;top:50%;width:min(36vw,440px);margin-top:calc(min(36vw,440px)*-.5);z-index:1}
@media(max-width:820px){.v-loop{display:none}}
.v-ring{fill:none;stroke:var(--v-ink);stroke-width:4;stroke-dasharray:3 14;stroke-linecap:round}
.v-nt{fill:#fff;font-weight:800;font-size:18px;text-anchor:middle}
.v-nav{display:flex;gap:8px;padding:10px clamp(20px,5vw,64px) 14px;position:relative;z-index:2}
.v-seg{flex:1;background:none;border:0;padding:0;cursor:pointer;text-align:left;color:var(--v-ink);font:inherit}
.v-seg small{display:block;font-size:12px;font-weight:700;margin-top:4px;opacity:.7}
.v-trk{display:block;height:6px;border:2px solid var(--v-ink);border-radius:4px;background:var(--v-card);overflow:hidden}
.v-trk b{display:block;height:100%;background:var(--v-red)}
button:focus-visible{outline:3px solid var(--v-blue);outline-offset:2px}
`
