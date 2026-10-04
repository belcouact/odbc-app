import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enApp from './locales/en/app.json'
import zhApp from './locales/zh/app.json'
import enFeedback from './locales/en/feedback.json'
import zhFeedback from './locales/zh/feedback.json'
import enWorkspace from './locales/en/workspace.json'
import zhWorkspace from './locales/zh/workspace.json'
import enCharts from './locales/en/charts.json'
import zhCharts from './locales/zh/charts.json'
import enSummary from './locales/en/summary.json'
import zhSummary from './locales/zh/summary.json'
import enGrid from './locales/en/grid.json'
import zhGrid from './locales/zh/grid.json'
import enScript from './locales/en/script.json'
import zhScript from './locales/zh/script.json'
import enBi from './locales/en/bi.json'
import zhBi from './locales/zh/bi.json'
import enConnections from './locales/en/connections.json'
import zhConnections from './locales/zh/connections.json'
import enSettings from './locales/en/settings.json'
import zhSettings from './locales/zh/settings.json'
import enAiSettings from './locales/en/aiSettings.json'
import zhAiSettings from './locales/zh/aiSettings.json'
import enAiSidebar from './locales/en/aiSidebar.json'
import zhAiSidebar from './locales/zh/aiSidebar.json'
import enRelationships from './locales/en/relationships.json'
import zhRelationships from './locales/zh/relationships.json'
import enDialogs from './locales/en/dialogs.json'
import zhDialogs from './locales/zh/dialogs.json'
import enIntro from './locales/en/intro.json'
import zhIntro from './locales/zh/intro.json'
import enMisc from './locales/en/misc.json'
import zhMisc from './locales/zh/misc.json'

export const LANGUAGE_STORAGE_KEY = 'odbc-language'
export type AppLanguage = 'en' | 'zh'

function detectInitialLanguage(): AppLanguage {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch {
    // Storage unavailable (private mode etc.) — fall through to the default.
  }
  // Default to English when the user has not chosen a language yet.
  return 'en'
}

void i18n.use(initReactI18next).init({
  resources: {
    en: {
      app: enApp,
      feedback: enFeedback,
      workspace: enWorkspace,
      charts: enCharts,
      summary: enSummary,
      grid: enGrid,
      script: enScript,
      bi: enBi,
      connections: enConnections,
      settings: enSettings,
      aiSettings: enAiSettings,
      aiSidebar: enAiSidebar,
      relationships: enRelationships,
      dialogs: enDialogs,
      intro: enIntro,
      misc: enMisc,
    },
    zh: {
      app: zhApp,
      feedback: zhFeedback,
      workspace: zhWorkspace,
      charts: zhCharts,
      summary: zhSummary,
      grid: zhGrid,
      script: zhScript,
      bi: zhBi,
      connections: zhConnections,
      settings: zhSettings,
      aiSettings: zhAiSettings,
      aiSidebar: zhAiSidebar,
      relationships: zhRelationships,
      dialogs: zhDialogs,
      intro: zhIntro,
      misc: zhMisc,
    },
  },
  lng: detectInitialLanguage(),
  fallbackLng: 'en',
  defaultNS: 'app',
  interpolation: { escapeValue: false },
})

export function applyDocumentLanguage(language: AppLanguage): void {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
}
applyDocumentLanguage(i18n.language as AppLanguage)

export function changeAppLanguage(language: AppLanguage): void {
  void i18n.changeLanguage(language)
  applyDocumentLanguage(language)
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Ignore persistence failures; the in-session language still changes.
  }
}

export function isChinese(): boolean {
  return i18n.language.startsWith('zh')
}
