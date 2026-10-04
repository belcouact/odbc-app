import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/lora/400.css'
import '@fontsource/lora/500.css'
import '@fontsource/lora/600.css'
import '@fontsource/lora/700.css'
import '@fontsource/ibm-plex-mono'
// Kai-style Chinese (Lora has no CJK glyphs): LXGW WenKai Screen, self-hosted
// and split into unicode-range chunks, so a page only fetches the glyph
// subsets it actually renders (~100-300 KB in practice).
import 'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css'
import './index.css'
import './i18n'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
