// Alex voxel show: embeds the standalone WebGL animation
// (public/alex-voxel-show.html) full-screen in an iframe, passing the app's
// current language. A close button is added because the show has none and App
// renders this as an overlay.
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

export default function AlexShow({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const src = useMemo(() => `/alex-voxel-show.html?lang=${lang}`, [lang])

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [onClose])

  // The app page scrolls, so its scrollbar would otherwise stay visible over the
  // right edge of the full-screen animation.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  return (
    <div className="ax-root" role="dialog" aria-label={t('bar.openAlexShow')}>
      <iframe className="ax-frame" src={src} title="Alex voxel show" allow="autoplay" />
      <button className="ax-close" onClick={onClose}>{t('bar.closeAlexShow')}</button>
      <style>{CSS}</style>
    </div>
  )
}

const CSS = `
.ax-root{position:fixed;inset:0;z-index:1400;background:#07080d;overflow:hidden}
.ax-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.ax-close{position:fixed;top:16px;left:16px;z-index:10;min-height:44px;padding:0 20px;display:inline-flex;align-items:center;gap:8px;
font:700 14px "Lora","LXGW WenKai Screen","Kaiti SC",STKaiti,KaiTi,"楷体",Georgia,"Times New Roman",serif;color:#e2e8f0;background:rgba(8,20,36,.6);border:1px solid rgba(255,255,255,.16);
border-radius:999px;cursor:pointer;backdrop-filter:blur(6px);transition:background .2s,border-color .2s,transform .1s}
.ax-close:hover{background:rgba(8,20,36,.85);border-color:rgba(255,255,255,.32)}
.ax-close:active{transform:scale(.97)}
.ax-close:focus-visible{outline:3px solid #6c8cff;outline-offset:2px}
@media(max-width:768px){.ax-close{min-height:48px;padding:0 18px;font-size:13px}}
`
