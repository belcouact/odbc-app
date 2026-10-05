/**
 * Analysis panels hosted on the Analyze page — Insights and Deep analysis.
 * Each panel stacks its controls above the results: the text input sits on
 * the left and the action buttons on the right (vertically on phones).
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import DownloadIcon from '@mui/icons-material/Download'
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined'
import InsightsIcon from '@mui/icons-material/Insights'
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import type { AiAnalyzePipelineResult, AiDashboardChart } from '../api/client'
import { emit } from '../editorBus'
import type { AiDataProfile, AiInsightResult } from '../types'
import { aiChartToVisual, buildVisualChart, visualTitle } from '../utils/visual'
import { getWorkspaceSnapshot } from '../workspaceBus'
import EChart from './EChart'
import MarkdownContent from './MarkdownContent'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** Persisted results reuse the keys the old AI sidebar tabs used, so anything
 *  generated before the move still shows up on the Analyze page. */
const INSIGHT_STORAGE_KEY = 'ai_insight_card_v1'
const ANALYZE_STORAGE_KEY = 'ai_analyze_pipeline_v1'
/** Follow-up conversation of the Deep analysis tab (its own storage). */
const ANALYZE_CHAT_STORAGE_KEY = 'ai_analyze_chat_v1'
/** At most this many follow-up messages are kept (storage sanity cap). */
const MAX_STORED_MESSAGES = 100

/** Restore the persisted insight card, ignoring anything malformed. */
function loadStoredInsight(): AiInsightResult | null {
  try {
    const raw = localStorage.getItem(INSIGHT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AiInsightResult>
    if (typeof parsed?.insights !== 'string' || !parsed.profile) return null
    // Cards persisted before guided questions existed lack this field.
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter((q): q is string => typeof q === 'string')
      : []
    return { insights: parsed.insights, questions, profile: parsed.profile }
  } catch {
    return null
  }
}

/** Restore the persisted analysis pipeline result, ignoring anything malformed. */
function loadStoredAnalyze(): AiAnalyzePipelineResult | null {
  try {
    const raw = localStorage.getItem(ANALYZE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AiAnalyzePipelineResult>
    if (typeof parsed?.narrative !== 'string' || !parsed.profile) return null
    return {
      narrative: parsed.narrative,
      questions: Array.isArray(parsed.questions)
        ? parsed.questions.filter((q): q is string => typeof q === 'string')
        : [],
      charts: Array.isArray(parsed.charts) ? (parsed.charts as AiDashboardChart[]) : [],
      stats: parsed.stats ?? null,
      profile: parsed.profile,
    }
  } catch {
    return null
  }
}

/** Restore the persisted follow-up conversation, sanitizing anything unexpected. */
function loadStoredAnalyzeChat(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(ANALYZE_CHAT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (m): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string',
      )
      .slice(-MAX_STORED_MESSAGES)
  } catch {
    return []
  }
}

/** Transient success notice (auto-hides) shared by the three panels. */
function useNotice() {
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const show = (text: string) => {
    setNotice(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setNotice(null), 3500)
  }
  return { notice, show }
}

/** Normalize an AI request failure, detecting the "not configured" case. */
function aiErrorText(err: unknown, t: TFunction): string {
  const message = err instanceof Error ? err.message : t('errors.aiRequestFailed')
  return message.includes('not configured') ? t('errors.notConfigured') : message
}

/** Download a text payload as a file (shared by all copy/download actions). */
function downloadTextFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * Control row above the results: the text input takes the left side and the
 * action button sits on the right. On phones the two stack vertically and the
 * button spans the full width for a comfortable touch target.
 */
function ControlRow({ field, action }: { field: ReactNode; action: ReactNode }) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.5}
      sx={{ alignItems: { sm: 'center' } }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>{field}</Box>
      {action}
    </Stack>
  )
}

/** Status + error block shown at the top of every control rail. */
function RailStatus({
  notice,
  error,
}: {
  notice: string | null
  error: string | null
}) {
  return (
    <>
      {notice && <Alert severity="success">{notice}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
    </>
  )
}

/** Clickable list of AI-suggested questions that send themselves when tapped. */
export function QuestionChips({
  questions,
  onPick,
  disabled,
}: {
  questions: string[]
  onPick: (question: string) => void
  disabled?: boolean
}) {
  return (
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {questions.map((question) => (
        <Chip
          key={question}
          icon={<HelpOutlineIcon fontSize="small" />}
          label={question}
          variant="outlined"
          clickable
          onClick={() => onPick(question)}
          disabled={disabled}
          sx={{
            height: 'auto',
            minHeight: 48,
            maxWidth: '100%',
            alignItems: 'flex-start',
            py: 0.25,
            '& .MuiChip-icon': { mt: 1, ml: 1 },
            '& .MuiChip-label': { whiteSpace: 'normal', textAlign: 'left', py: 1 },
          }}
        />
      ))}
    </Stack>
  )
}

/** Render AI-designed charts from a pipeline result via the shared chart pipeline. */
function AnalyzeCharts({
  charts,
  rows,
}: {
  charts: AiDashboardChart[]
  rows: Record<string, unknown>[]
}) {
  const { t } = useTranslation('aiSidebar')
  return (
    <Stack spacing={1.5}>
      {charts.map((spec, index) => {
        const config = aiChartToVisual(spec)
        const visual = buildVisualChart(rows, config)
        const title = spec.title?.trim() || visualTitle(config)
        const hasKpi = visual.kpiCards.length > 0
        return (
          <Box key={index}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              {title}
            </Typography>
            {visual.hasData && visual.option ? (
              <Box sx={{ width: '100%', height: { xs: 240, md: 300 } }}>
                <EChart option={visual.option} />
              </Box>
            ) : hasKpi ? (
              <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {visual.kpiCards.map((card, i) => (
                  <Box key={i}>
                    <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
                      {card.formatted}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {card.label}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography variant="caption" color="text.secondary">
                {t('analyze.noChartData')}
              </Typography>
            )}
          </Box>
        )
      })}
    </Stack>
  )
}

/** Escape text for safe insertion into the standalone HTML report. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Compact "min – max" summary of a numeric column, when available. */
function formatNumericRange(numeric?: Record<string, number>): string {
  if (!numeric || typeof numeric.min !== 'number' || typeof numeric.max !== 'number') return '—'
  return `${numeric.min} – ${numeric.max}`
}

/** Up to three representative values for a categorical column. */
function formatTopValues(top?: { value: unknown; count: number }[]): string {
  if (!top || top.length === 0) return '—'
  return top
    .slice(0, 3)
    .map((entry) => `${String(entry.value)} (${entry.count})`)
    .join(', ')
}

/** Where the report's data came from, shown in the report header. */
interface ReportSource {
  connectionId?: string
  table?: string
  columns: number
  rows: number
}

/** "Connection: x · Table: y · Rows: n · Columns: m" line for the report header. */
function buildReportSourceText(source: ReportSource, t: TFunction): string {
  return [
    source.connectionId ? `${t('report.connection')}: ${source.connectionId}` : '',
    source.table ? `${t('report.table')}: ${source.table}` : '',
    `${t('report.rows')}: ${source.rows.toLocaleString()}`,
    `${t('report.columns')}: ${source.columns.toLocaleString()}`,
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ')
}

/** Render the shared data-profile table as one report section. */
function buildProfileSectionHtml(profile: AiDataProfile, t: TFunction): string {
  const headerCells = ['column', 'type', 'nonNull', 'missing', 'unique', 'range', 'topValues']
    .map((key) => `<th>${escapeHtml(t(`report.${key}`))}</th>`)
    .join('')
  const rows = profile.columns
    .map((column) => {
      const cells = [
        `<td>${escapeHtml(column.name)}</td>`,
        `<td>${escapeHtml(column.type || '—')}</td>`,
        `<td class="num">${column.non_null.toLocaleString()}</td>`,
        `<td class="num">${column.missing.toLocaleString()} (${column.missing_pct.toFixed(1)}%)</td>`,
        `<td class="num">${column.unique.toLocaleString()}</td>`,
        `<td>${escapeHtml(formatNumericRange(column.numeric))}</td>`,
        `<td>${escapeHtml(formatTopValues(column.top))}</td>`,
      ]
      return `<tr>${cells.join('')}</tr>`
    })
    .join('')
  return `<section>
    <h2>${escapeHtml(t('report.profile'))}</h2>
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`
}

/** Render the follow-up questions list as one report section. */
function buildQuestionsSectionHtml(questions: string[], t: TFunction): string {
  const list = questions.length
    ? `<ol>${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ol>`
    : `<p class="muted">${escapeHtml(t('report.noQuestions'))}</p>`
  return `<section>
    <h2>${escapeHtml(t('report.questions'))}</h2>
    ${list}
  </section>`
}

/**
 * Shared page shell (styles + header) for the standalone, printable HTML
 * reports. Sections are passed in pre-built; the shell adds the document
 * chrome so both reports stay visually identical with zero duplication.
 */
function buildReportHtml(params: {
  title: string
  sourceText: string
  sectionsHtml: string
  t: TFunction
}): string {
  const lang = document.documentElement.lang || 'en'

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(params.title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 24px 64px;
    background: #f5f6f8;
    color: #1f2328;
    line-height: 1.6;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  main {
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 36px 40px;
    background: #fff;
    border: 1px solid #e2e4e8;
    border-radius: 12px;
  }
  header { border-bottom: 2px solid #e2e4e8; padding-bottom: 16px; }
  h1 { margin: 0 0 8px; font-size: 1.6rem; }
  h2 {
    margin: 28px 0 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid #eceef1;
    font-size: 1.15rem;
  }
  .meta { margin: 2px 0; color: #6a737d; font-size: 0.85rem; }
  table { width: 100%; margin: 8px 0 4px; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 6px 10px; border: 1px solid #e2e4e8; text-align: left; vertical-align: top; }
  th { background: #f5f6f8; font-weight: 600; }
  td.num { text-align: right; white-space: nowrap; }
  .markdown > :first-child { margin-top: 0; }
  .markdown h1, .markdown h2, .markdown h3, .markdown h4 {
    margin: 20px 0 8px;
    padding: 0;
    border: 0;
  }
  .markdown ul, .markdown ol { padding-left: 22px; }
  .markdown code {
    padding: 1px 5px;
    border-radius: 4px;
    background: #f1f2f4;
    font-family: Consolas, "SFMono-Regular", Menlo, monospace;
    font-size: 0.85em;
  }
  .markdown pre { padding: 12px 14px; border-radius: 8px; background: #f6f8fa; overflow-x: auto; }
  .markdown pre code { padding: 0; background: none; }
  .markdown blockquote {
    margin: 12px 0;
    padding: 4px 14px;
    border-left: 4px solid #d0d7de;
    color: #57606a;
  }
  .markdown th, .markdown td { font-size: 0.85rem; }
  pre.stats {
    margin: 8px 0 4px;
    padding: 12px 14px;
    border-radius: 8px;
    background: #f6f8fa;
    overflow-x: auto;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .muted { color: #6a737d; font-style: italic; }
  @media print {
    body { padding: 0; background: #fff; }
    main { max-width: none; padding: 0; border: 0; border-radius: 0; }
    h2 { page-break-after: avoid; }
    tr, pre { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(params.title)}</h1>
    <p class="meta">${escapeHtml(params.t('report.generated'))}: ${escapeHtml(new Date().toLocaleString())}</p>
    <p class="meta">${escapeHtml(params.t('report.source'))}: ${params.sourceText}</p>
  </header>
  ${params.sectionsHtml}
</main>
</body>
</html>`
}

/** Build a self-contained, printable HTML report for the current insight card. */
async function buildInsightReportHtml(
  result: AiInsightResult,
  source: ReportSource,
  t: TFunction,
): Promise<string> {
  // Render the markdown to plain semantic HTML (no MUI/emotion classes) so the
  // standalone report has no runtime dependencies. Loaded lazily to keep the
  // server renderer out of the main bundle.
  const { renderToStaticMarkup } = await import('react-dom/server')
  const insightsHtml = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, result.insights),
  )
  const sectionsHtml = [
    buildProfileSectionHtml(result.profile, t),
    `<section>
    <h2>${escapeHtml(t('report.insights'))}</h2>
    <div class="markdown">${insightsHtml}</div>
  </section>`,
    buildQuestionsSectionHtml(result.questions, t),
  ].join('\n')
  return buildReportHtml({ title: t('report.title'), sourceText: buildReportSourceText(source, t), sectionsHtml, t })
}

/** Build a self-contained, printable HTML report for the deep-analysis pipeline result. */
async function buildAnalyzeReportHtml(
  result: AiAnalyzePipelineResult,
  source: ReportSource,
  t: TFunction,
): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const findingsHtml = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, result.narrative),
  )
  const chartsHtml = result.charts.length
    ? `<ol>${result.charts
        .map((chart) => {
          const config = aiChartToVisual(chart)
          return `<li>${escapeHtml(chart.title?.trim() || visualTitle(config))}</li>`
        })
        .join('')}</ol>`
    : ''
  const statsText = result.stats?.stdout.trim() || result.stats?.stderr.trim() || ''
  const sectionsHtml = [
    buildProfileSectionHtml(result.profile, t),
    `<section>
    <h2>${escapeHtml(t('report.findings'))}</h2>
    <div class="markdown">${findingsHtml}</div>
  </section>`,
    chartsHtml
      ? `<section>
    <h2>${escapeHtml(t('report.charts'))}</h2>
    ${chartsHtml}
  </section>`
      : '',
    statsText
      ? `<section>
    <h2>${escapeHtml(t('report.stats'))}</h2>
    <pre class="stats">${escapeHtml(statsText)}</pre>
  </section>`
      : '',
    buildQuestionsSectionHtml(result.questions, t),
  ]
    .filter(Boolean)
    .join('\n')
  return buildReportHtml({ title: t('report.title'), sourceText: buildReportSourceText(source, t), sectionsHtml, t })
}

// ---------------------------------------------------------------------------
// Insights (AI card)
// ---------------------------------------------------------------------------

/** Insights tab: the AI insight card with its generate/copy/export controls. */
export function InsightPanel() {
  const { t } = useTranslation('aiSidebar')
  const [insight, setInsight] = useState<AiInsightResult | null>(loadStoredInsight)
  const [loading, setLoading] = useState(false)
  const [exportingReport, setExportingReport] = useState(false)
  const [focus, setFocus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { notice, show } = useNotice()

  // Persist the insight card so the last analysis survives app restarts.
  useEffect(() => {
    try {
      if (insight) localStorage.setItem(INSIGHT_STORAGE_KEY, JSON.stringify(insight))
      else localStorage.removeItem(INSIGHT_STORAGE_KEY)
    } catch {
      // Storage unavailable — the in-memory card still works normally.
    }
  }, [insight])

  /** Generate (or regenerate) the insight card for the currently loaded grid. */
  const handleGenerate = async () => {
    if (loading) return
    const snapshotNow = getWorkspaceSnapshot()
    if (snapshotNow.rows.length === 0 || snapshotNow.columns.length === 0) {
      setError(t('errors.noGridData'))
      return
    }
    setError(null)
    setLoading(true)
    try {
      const result = await api.aiInsights({
        columns: snapshotNow.columns.map((name) => ({ name, type: '' })),
        rows: snapshotNow.rows,
        requirement: focus.trim(),
      })
      setInsight(result)
    } catch (err) {
      setError(aiErrorText(err, t))
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    if (!insight) return
    try {
      await navigator.clipboard.writeText(insight.insights)
      show(t('notices.insightCopied'))
    } catch {
      setError(t('errors.copyFailed'))
    }
  }

  const handleDownload = () => {
    if (!insight) return
    downloadTextFile(
      insight.insights,
      `data-insights-${new Date().toISOString().slice(0, 10)}.md`,
      'text/markdown;charset=utf-8',
    )
    show(t('notices.insightDownloaded'))
  }

  /** Export the insight card as a self-contained, printable HTML report. */
  const handleExportReport = async () => {
    if (!insight || exportingReport) return
    setExportingReport(true)
    try {
      const snapshotNow = getWorkspaceSnapshot()
      const html = await buildInsightReportHtml(
        insight,
        {
          connectionId: snapshotNow.connectionId || undefined,
          table: snapshotNow.table || undefined,
          columns: snapshotNow.columns.length,
          rows: snapshotNow.rows.length,
        },
        t,
      )
      downloadTextFile(
        html,
        `data-report-${new Date().toISOString().slice(0, 10)}.html`,
        'text/html;charset=utf-8',
      )
      show(t('notices.reportExported'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.reportFailed'))
    } finally {
      setExportingReport(false)
    }
  }

  /** A suggested question hops to the AI sidebar's Chat tab and is sent there. */
  const askQuestion = (question: string) => {
    emit({ type: 'ai-ask', text: question })
  }

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {t('modes.insight.hint')}
      </Typography>
      <ControlRow
        field={
          <TextField
            label={t('insight.focusLabel')}
            value={focus}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setFocus(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleGenerate()
              }
            }}
            fullWidth
            multiline
            minRows={1}
            placeholder={t('insight.focusPlaceholder')}
          />
        }
        action={
          <Button
            variant="contained"
            onClick={() => void handleGenerate()}
            disabled={loading}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <InsightsIcon />}
            sx={{ minHeight: 48, flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
          >
            {insight ? t('insight.regenerate') : t('insight.generate')}
          </Button>
        }
      />
      <RailStatus notice={notice} error={error} />
      {loading && !insight && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            {t('insight.generating')}
          </Typography>
        </Stack>
      )}
      {!loading && !insight && (
        <Typography variant="body2" color="text.secondary">
          {t('empty.insight')}
        </Typography>
      )}
      {insight && (
        <Paper
          variant="outlined"
          sx={{
            p: { xs: 1.5, sm: 2 },
            borderColor: 'primary.main',
            opacity: loading ? 0.5 : 1,
            transition: 'opacity 0.2s',
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
            <InsightsIcon color="primary" fontSize="small" />
            <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
              {t('insight.cardTitle')}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {t('insight.profileSummary', {
              profiled: insight.profile.rows_profiled.toLocaleString(),
              total: insight.profile.row_total.toLocaleString(),
              columns: insight.profile.columns.length,
            })}
          </Typography>
          <MarkdownContent content={insight.insights} />
          {insight.questions.length > 0 && (
            <Box sx={{ mt: 1.5 }}>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: 0.75 }}>
                <HelpOutlineIcon fontSize="small" color="action" />
                <Typography variant="caption" color="text.secondary">
                  {t('insight.questionsTitle')}
                </Typography>
              </Stack>
              <QuestionChips questions={insight.questions} onPick={askQuestion} disabled={loading} />
            </Box>
          )}
          <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" onClick={() => void handleCopy()} sx={{ minHeight: 48 }}>
              {t('insight.copy')}
            </Button>
            <Button size="small" variant="outlined" onClick={handleDownload} sx={{ minHeight: 48 }}>
              {t('insight.download')}
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => void handleExportReport()}
              disabled={loading || exportingReport}
              startIcon={exportingReport ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
              sx={{ minHeight: 48 }}
            >
              {t('insight.exportReport')}
            </Button>
          </Stack>
        </Paper>
      )}
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Deep analysis (one-shot pipeline + follow-up conversation)
// ---------------------------------------------------------------------------

/** Deep analysis tab: run the pipeline, then keep asking follow-up questions. */
export function AnalyzePanel() {
  const { t } = useTranslation('aiSidebar')
  const snapshot = getWorkspaceSnapshot()
  const [analyzeResult, setAnalyzeResult] = useState<AiAnalyzePipelineResult | null>(loadStoredAnalyze)
  const [analyzeLoading, setAnalyzeLoading] = useState(false)
  const [exportingReport, setExportingReport] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>(loadStoredAnalyzeChat)
  const [goal, setGoal] = useState('')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { notice, show } = useNotice()

  // Persist the pipeline result so the last run survives app restarts.
  useEffect(() => {
    try {
      if (analyzeResult) localStorage.setItem(ANALYZE_STORAGE_KEY, JSON.stringify(analyzeResult))
      else localStorage.removeItem(ANALYZE_STORAGE_KEY)
    } catch {
      // Storage unavailable — the in-memory result still works normally.
    }
  }, [analyzeResult])

  // Persist the follow-up conversation so previous context survives restarts.
  useEffect(() => {
    try {
      localStorage.setItem(ANALYZE_CHAT_STORAGE_KEY, JSON.stringify(messages))
    } catch {
      // Storage full/unavailable — keep only the most recent messages once.
      try {
        localStorage.setItem(
          ANALYZE_CHAT_STORAGE_KEY,
          JSON.stringify(messages.slice(-50)),
        )
      } catch {
        // Ignore — the in-memory conversation still works normally.
      }
    }
  }, [messages])

  /** Run the one-shot analysis pipeline (narrative + charts + stats) on the grid. */
  const handleRunPipeline = async () => {
    if (analyzeLoading || streaming) return
    const snapshotNow = getWorkspaceSnapshot()
    if (snapshotNow.rows.length === 0 || snapshotNow.columns.length === 0) {
      setError(t('errors.noGridData'))
      return
    }
    setError(null)
    setAnalyzeLoading(true)
    try {
      const result = await api.aiAnalyzePipeline({
        goal: goal.trim(),
        connectionId: snapshotNow.connectionId || undefined,
        table: snapshotNow.table || undefined,
        columns: snapshotNow.columns.map((name) => ({ name, type: '' })),
        rows: snapshotNow.rows,
      })
      setAnalyzeResult(result)
    } catch (err) {
      setError(aiErrorText(err, t))
    } finally {
      setAnalyzeLoading(false)
    }
  }

  /** Export the current pipeline result as a self-contained printable HTML report. */
  const handleExportReport = async () => {
    if (!analyzeResult || exportingReport) return
    setExportingReport(true)
    try {
      const snapshotNow = getWorkspaceSnapshot()
      const html = await buildAnalyzeReportHtml(
        analyzeResult,
        {
          connectionId: snapshotNow.connectionId || undefined,
          table: snapshotNow.table || undefined,
          columns: snapshotNow.columns.length,
          rows: snapshotNow.rows.length,
        },
        t,
      )
      downloadTextFile(html, `data-report-${new Date().toISOString().slice(0, 10)}.html`, 'text/html;charset=utf-8')
      show(t('notices.reportExported'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.reportFailed'))
    } finally {
      setExportingReport(false)
    }
  }

  /** Send a follow-up question (streamed, same data context as the pipeline). */
  const sendFollowup = async (promptOverride?: string) => {
    const text = (promptOverride ?? input).trim()
    if (!text || streaming) return
    const snapshotNow = getWorkspaceSnapshot()
    const conversation: ChatMessage[] = [...messages, { role: 'user', content: text }]
    // Append an empty assistant placeholder that fills in as chunks stream in.
    setMessages([...conversation, { role: 'assistant', content: '' }])
    setInput('')
    setError(null)
    setStreaming(true)
    /** Grow the trailing assistant message with the next streamed chunk. */
    const appendDelta = (delta: string) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last === undefined || last.role !== 'assistant') return prev
        const next = [...prev]
        next[next.length - 1] = { ...last, content: last.content + delta }
        return next
      })
    }
    try {
      const reply = await api.askAiChatStream(
        {
          messages: conversation,
          connectionId: snapshotNow.connectionId || undefined,
          columns: snapshotNow.columns.map((name) => ({ name, type: '' })),
          rows: snapshotNow.rows,
          mode: 'analyze',
        },
        appendDelta,
      )
      if (!reply.trim()) {
        throw new Error(t('errors.emptyResponse'))
      }
      setMessages([...conversation, { role: 'assistant', content: reply }])
    } catch (err) {
      setError(aiErrorText(err, t))
      // Drop the placeholder when nothing streamed; keep partial output otherwise.
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && !last.content.trim()) {
          return prev.slice(0, -1)
        }
        return prev
      })
    } finally {
      setStreaming(false)
    }
  }

  const lastMessage = messages[messages.length - 1]
  /** Waiting for the first streamed chunk (assistant placeholder still empty). */
  const waitingForFirstChunk =
    streaming && lastMessage?.role === 'assistant' && lastMessage.content === ''

  const noData = snapshot.rows.length === 0 || snapshot.columns.length === 0

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {t('modes.analyze.hint')}
      </Typography>
      <ControlRow
        field={
          <TextField
            label={t('analyze.goalLabel')}
            value={goal}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleRunPipeline()
              }
            }}
            fullWidth
            multiline
            minRows={2}
            placeholder={t('analyze.goalPlaceholder')}
          />
        }
        action={
          <Button
            variant="contained"
            onClick={() => void handleRunPipeline()}
            disabled={analyzeLoading || streaming || noData}
            startIcon={
              analyzeLoading ? <CircularProgress size={16} color="inherit" /> : <PsychologyOutlinedIcon />
            }
            sx={{ minHeight: 48, flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
          >
            {analyzeResult ? t('analyze.rerun') : t('analyze.run')}
          </Button>
        }
      />
      <Divider />
      <ControlRow
        field={
          <TextField
            label={t('input.message')}
            value={input}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendFollowup()
              }
            }}
            fullWidth
            multiline
            minRows={2}
            placeholder={t('empty.analyze')}
          />
        }
        action={
          <Button
            variant="outlined"
            onClick={() => void sendFollowup()}
            disabled={streaming || analyzeLoading || !input.trim()}
            startIcon={
              streaming ? <CircularProgress size={16} color="inherit" /> : <AutoAwesomeIcon />
            }
            sx={{ minHeight: 48, flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
          >
            {t('send')}
          </Button>
        }
      />
      <RailStatus notice={notice} error={error} />
      {analyzeLoading && !analyzeResult && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            {t('analyze.running')}
          </Typography>
        </Stack>
      )}
      {!analyzeResult && messages.length === 0 && !analyzeLoading && (
        <Typography variant="body2" color="text.secondary">
          {t('empty.analyze')}
        </Typography>
      )}
      {analyzeResult && (
        <Paper
          variant="outlined"
          sx={{
            p: { xs: 1.5, sm: 2 },
            borderColor: 'primary.main',
            opacity: analyzeLoading ? 0.5 : 1,
            transition: 'opacity 0.2s',
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
            <PsychologyOutlinedIcon color="primary" fontSize="small" />
            <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
              {t('analyze.cardTitle')}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {t('analyze.profileSummary', {
              profiled: analyzeResult.profile.rows_profiled.toLocaleString(),
              total: analyzeResult.profile.row_total.toLocaleString(),
              columns: analyzeResult.profile.columns.length,
            })}
          </Typography>
          <MarkdownContent content={analyzeResult.narrative} />
          {analyzeResult.charts.length > 0 && (
            <Box sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                {t('analyze.chartsTitle')}
              </Typography>
              <AnalyzeCharts charts={analyzeResult.charts} rows={snapshot.rows} />
            </Box>
          )}
          {analyzeResult.stats &&
            (analyzeResult.stats.stdout.trim() || analyzeResult.stats.stderr.trim()) && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                  {t('analyze.statsTitle')}
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1,
                    maxHeight: 240,
                    overflow: 'auto',
                    borderRadius: 1,
                    bgcolor: 'action.hover',
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {analyzeResult.stats.stdout.trim() || analyzeResult.stats.stderr.trim()}
                </Box>
              </Box>
            )}
          {analyzeResult.questions.length > 0 && (
            <Box sx={{ mt: 1.5 }}>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: 0.75 }}>
                <HelpOutlineIcon fontSize="small" color="action" />
                <Typography variant="caption" color="text.secondary">
                  {t('analyze.questionsTitle')}
                </Typography>
              </Stack>
              <QuestionChips
                questions={analyzeResult.questions}
                onPick={(question) => void sendFollowup(question)}
                disabled={streaming || analyzeLoading}
              />
            </Box>
          )}
          <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}>
            <Button
              size="small"
              variant="outlined"
              onClick={async () => {
                if (!analyzeResult) return
                try {
                  await navigator.clipboard.writeText(analyzeResult.narrative)
                  show(t('notices.analyzeCopied'))
                } catch {
                  setError(t('errors.copyFailed'))
                }
              }}
              sx={{ minHeight: 48 }}
            >
              {t('analyze.copy')}
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                if (!analyzeResult) return
                downloadTextFile(
                  analyzeResult.narrative,
                  `analysis-${new Date().toISOString().slice(0, 10)}.md`,
                  'text/markdown;charset=utf-8',
                )
                show(t('notices.analyzeDownloaded'))
              }}
              sx={{ minHeight: 48 }}
            >
              {t('analyze.download')}
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => void handleExportReport()}
              disabled={analyzeLoading || exportingReport}
              startIcon={exportingReport ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
              sx={{ minHeight: 48 }}
            >
              {t('analyze.exportReport')}
            </Button>
          </Stack>
        </Paper>
      )}
      {messages.map((message, index) =>
        // Skip the in-flight placeholder (empty assistant bubble) while it
        // has no content yet — the "Thinking…" row covers that state.
        message.role === 'assistant' && !message.content.trim() && streaming ? null : (
          <Paper
            key={index}
            variant={message.role === 'user' ? 'elevation' : 'outlined'}
            elevation={message.role === 'user' ? 1 : 0}
            sx={{
              p: 1.5,
              bgcolor: message.role === 'user' ? 'primary.main' : 'action.hover',
              color: message.role === 'user' ? 'primary.contrastText' : 'text.primary',
              alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '95%',
            }}
          >
            {message.role === 'assistant' ? (
              <MarkdownContent content={message.content} />
            ) : (
              <Typography
                component="pre"
                sx={{
                  m: 0,
                  fontFamily: 'inherit',
                  fontSize: '0.875rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {message.content}
              </Typography>
            )}
          </Paper>
        ),
      )}
      {waitingForFirstChunk && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            {t('thinking')}
          </Typography>
        </Stack>
      )}
    </Stack>
  )
}

