// Intro overlay: embeds the standalone 54s promo animation (public/intro-promo.html)
// full-screen in an iframe, passing the app's current language. A close/skip affordance
// is added because the promo itself has none and App renders this as an overlay.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function IntroV2({ onClose }: { onClose: () => void }) {
  const { i18n } = useTranslation()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const src = useMemo(() => `/intro-promo.html?lang=${lang}`, [lang])
  const frameRef = useRef<HTMLIFrameElement>(null)
  // The promo has its own language toggle, so mirror it here to keep the skip
  // button in the same language as the animation the user is watching.
  const [promoLang, setPromoLang] = useState<'en' | 'zh'>(lang)
  useEffect(() => setPromoLang(lang), [lang])
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (d && d.type === 'promo-lang' && (d.lang === 'en' || d.lang === 'zh')) setPromoLang(d.lang)
    }
    addEventListener('message', onMsg)
    return () => removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [onClose])

  // @font-face rules are per-document, so the iframe cannot see the app's webfonts.
  // Copy them from this document on load so the promo renders in the very same
  // "Lora" + "LXGW WenKai Screen" (Kai-style Chinese) stack as the rest of the UI.
  const copyFontFaces = () => {
    const doc = frameRef.current?.contentDocument
    if (!doc || doc.getElementById('host-fonts')) return
    let css = ''
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null
      try {
        rules = sheet.cssRules
      } catch {
        continue // stylesheet from another origin — not readable
      }
      for (const rule of Array.from(rules ?? [])) {
        if (rule instanceof CSSFontFaceRule) css += `${rule.cssText}\n`
      }
    }
    if (!css) return
    const style = doc.createElement('style')
    style.id = 'host-fonts'
    style.textContent = css
    doc.head.appendChild(style)
  }

  const skip = promoLang === 'zh' ? '跳过' : 'Skip'

  return (
    <div className="pv-root" role="dialog" aria-label="ODBC Query App promo">
      <iframe
        ref={frameRef}
        className="pv-frame"
        src={src}
        title="ODBC Query App promo"
        allow="autoplay"
        onLoad={copyFontFaces}
      />
      <button className="pv-skip" onClick={onClose}>{skip}</button>
      <style>{CSS}</style>
    </div>
  )
}

const CSS = `
.pv-root{position:fixed;inset:0;z-index:1400;background:#05080e;overflow:hidden}
.pv-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.pv-skip{position:fixed;top:16px;left:16px;z-index:10;min-height:44px;padding:0 20px;display:inline-flex;align-items:center;gap:8px;
font:700 14px "Lora","LXGW WenKai Screen","Kaiti SC",STKaiti,KaiTi,"楷体",Georgia,"Times New Roman",serif;color:#e2e8f0;background:rgba(8,20,36,.6);border:1px solid rgba(255,255,255,.16);
border-radius:999px;cursor:pointer;backdrop-filter:blur(6px);transition:background .2s,border-color .2s,transform .1s}
.pv-skip:hover{background:rgba(8,20,36,.85);border-color:rgba(255,255,255,.32)}
.pv-skip:active{transform:scale(.97)}
.pv-skip:focus-visible{outline:3px solid #6c8cff;outline-offset:2px}
@media(max-width:768px){.pv-skip{min-height:48px;padding:0 18px;font-size:13px}}
`
