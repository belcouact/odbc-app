import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import ChatIcon from '@mui/icons-material/Chat'
import CodeIcon from '@mui/icons-material/Code'
import CloseIcon from '@mui/icons-material/Close'
import LightbulbIcon from '@mui/icons-material/Lightbulb'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import SpeedIcon from '@mui/icons-material/Speed'
import TerminalIcon from '@mui/icons-material/Terminal'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { EChartsOption } from 'echarts'
import { api } from '../api/client'
import { emit } from '../editorBus'
import type { AiMode } from '../types'
import { getWorkspaceSnapshot } from '../workspaceBus'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

interface AiSidebarProps {
  open: boolean
  mode: AiMode
  onModeChange: (mode: AiMode) => void
  onClose: () => void
  /** Switch the app to the Query tab (called after applying SQL). */
  onOpenEditor?: () => void
  /** Switch the app to the Analyze tab (called after inserting a script or chart). */
  onOpenScript?: () => void
  /** Where AI charts are applied — the Analyze page or the BI page's chart builder. */
  chartTarget?: 'script' | 'bi'
  /** Switch the app to the BI tab (called after applying a chart targeted at BI). */
  onOpenBi?: () => void
}

const MODES: { value: AiMode; label: string; icon: ReactElement; hint: string }[] = [
  {
    value: 'chat',
    label: 'Chat',
    icon: <ChatIcon fontSize="small" />,
    hint: 'Ask anything — general questions, explanations, calculations or how to use this app.',
  },
  {
    value: 'sql',
    label: 'SQL',
    icon: <CodeIcon fontSize="small" />,
    hint: 'Explain, debug or write read-only SQL. Apply generated SQL straight to the editor.',
  },
  {
    value: 'script',
    label: 'Analyze',
    icon: <TerminalIcon fontSize="small" />,
    hint: 'Generate or refine a Python/JavaScript script that processes the queried rows.',
  },
  {
    value: 'chart',
    label: 'Chart',
    icon: <ShowChartIcon fontSize="small" />,
    hint: 'Describe a chart (ECharts) to apply to the Analyze tab, or just ask anything. Refine it over several turns.',
  },
]

/** Predefined quick actions shown under the SQL tab (sent as-is to the AI). */
const EXPLAIN_SQL_PROMPT =
  'Explain what this SQL query does. Describe its purpose, the main clauses, ' +
  'joins, filters and aggregations, and note anything that may not work as intended.'
const OPTIMIZE_SQL_PROMPT =
  'Optimize this SQL query for better performance. Briefly point out the main issues ' +
  '(e.g. SELECT *, filters applied late, functions on indexed columns, redundant joins), ' +
  'then return the full optimized query in a single ```sql code block so it can be applied directly.'

/** Extract the content of the first markdown code block, if any. */
function extractCodeBlock(text: string): string | null {
  const match = text.match(/```[\w-]*\n?([\s\S]*?)```/)
  if (!match) return null
  return match[1].trim()
}

/**
 * Evaluate a JS script that assigns an ECharts option to a variable named
 * ``option`` (either ``option = {...}`` or ``const option = {...}``). The
 * current grid rows are exposed as a global named ``rows`` (keyed by column
 * header name) so the script builds data by mapping over column names.
 */
function parseEchartScript(script: string, rows: Record<string, unknown>[]): EChartsOption {
  const trimmed = script.trim()
  if (!trimmed) throw new Error('The script is empty — nothing to apply.')
  // Assignment style: `option = { ... }`
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('option', 'rows', `${trimmed}\n;return option;`)
    const value = fn({}, rows)
    if (value && typeof value === 'object') return value as EChartsOption
  } catch {
    // Fall through to declaration style below.
  }
  // Declaration style: `const option = { ... }`
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('rows', `${trimmed}\n;return typeof option !== 'undefined' ? option : null;`)
  const value = fn(rows)
  if (value && typeof value === 'object') return value as EChartsOption
  throw new Error('The script did not produce an ECharts `option` object.')
}

const EMPTY = { chat: [], sql: [], script: [], chart: [] } as Record<AiMode, ChatMessage[]>

const STORAGE_KEY = 'ai_chat_messages_v1'
/** At most this many messages are kept per mode (storage sanity cap). */
const MAX_STORED_MESSAGES = 100

/** Restore the persisted conversations, sanitizing anything unexpected. */
function loadStoredMessages(): Record<AiMode, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...EMPTY }
    const parsed = JSON.parse(raw) as Partial<Record<AiMode, ChatMessage[]>>
    const restored = { ...EMPTY }
    for (const key of Object.keys(restored) as AiMode[]) {
      const list = parsed[key]
      if (!Array.isArray(list)) continue
      restored[key] = list
        .filter(
          (m) =>
            m &&
            typeof m === 'object' &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string',
        )
        .slice(-MAX_STORED_MESSAGES)
    }
    return restored
  } catch {
    return { ...EMPTY }
  }
}

export default function AiSidebar({
  open,
  mode,
  onModeChange,
  onClose,
  onOpenEditor,
  onOpenScript,
  chartTarget = 'script',
  onOpenBi,
}: AiSidebarProps) {
  // Each mode keeps its own conversation so switching tabs never loses
  // context. Conversations are persisted so they survive app restarts.
  const [messages, setMessages] = useState<Record<AiMode, ChatMessage[]>>(loadStoredMessages)
  const [inputs, setInputs] = useState<Record<AiMode, string>>({ chat: '', sql: '', script: '', chart: '' })
  const [loadingMode, setLoadingMode] = useState<AiMode | null>(null)
  const [errors, setErrors] = useState<Record<AiMode, string | null>>({ chat: null, sql: null, script: null, chart: null })
  const [notice, setNotice] = useState<string | null>(null)

  /** Resizable drawer width (sm+ only; mobile stays full-width). */
  const [drawerWidth, setDrawerWidth] = useState(440)
  const resizingRef = useRef(false)

  /** Start dragging the drawer's left edge to resize its width. */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizingRef.current = true
    const onMove = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return
      const next = window.innerWidth - moveEvent.clientX
      setDrawerWidth(Math.min(Math.max(next, 320), window.innerWidth - 48))
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }


  const scrollRef = useRef<HTMLDivElement>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  const currentMode = MODES.find((m) => m.value === mode) ?? MODES[0]
  const snapshot = getWorkspaceSnapshot()

  // Keep the conversation scrolled to the newest message.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loadingMode, open])

  useEffect(() => {
    return () => window.clearTimeout(noticeTimer.current)
  }, [])

  // Persist the conversations so previous context survives app restarts.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
    } catch {
      // Storage full/unavailable — drop older messages once, then give up
      // (the in-memory conversation still works normally).
      try {
        const trimmed = Object.fromEntries(
          (Object.keys(messages) as AiMode[]).map((key) => [key, messages[key].slice(-50)]),
        )
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
      } catch {
        // Ignore.
      }
    }
  }, [messages])

  const showNotice = (text: string) => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500)
  }

  const handleSend = async (promptOverride?: string) => {
    const text = (promptOverride ?? inputs[mode]).trim()
    if (!text || loadingMode) return
    // Quick actions need SQL in the editor — validate against the live snapshot.
    if (promptOverride && mode === 'sql' && !getWorkspaceSnapshot().sqlText.trim()) {
      setErrors((prev) => ({
        ...prev,
        [mode]: 'The SQL editor is empty — write or load a query first.',
      }))
      return
    }
    const snapshotNow = getWorkspaceSnapshot()
    // The general Chat tab answers any question, so the grid/editor context is
    // not sent for it — it would only bloat the request.
    const gridContext =
      mode === 'chat'
        ? {}
        : {
            connectionId: snapshotNow.connectionId || undefined,
            columns: snapshotNow.columns.map((name) => ({ name, type: '' })),
            rows: snapshotNow.rows,
          }
    const conversation: ChatMessage[] = [...messages[mode], { role: 'user', content: text }]
    // Append an empty assistant placeholder that fills in as chunks stream in.
    setMessages((prev) => ({ ...prev, [mode]: [...conversation, { role: 'assistant', content: '' }] }))
    setInputs((prev) => ({ ...prev, [mode]: '' }))
    setErrors((prev) => ({ ...prev, [mode]: null }))
    setLoadingMode(mode)
    /** Grow the trailing assistant message with the next streamed chunk. */
    const appendDelta = (delta: string) => {
      setMessages((prev) => {
        const list = prev[mode]
        const last = list[list.length - 1]
        if (last === undefined || last.role !== 'assistant') return prev
        const next = [...list]
        next[next.length - 1] = { ...last, content: last.content + delta }
        return { ...prev, [mode]: next }
      })
    }
    try {
      const reply = await api.askAiChatStream(
        {
          messages: conversation,
          ...gridContext,
          mode,
          sql: mode === 'sql' ? snapshotNow.sqlText || undefined : undefined,
        },
        appendDelta,
      )
      if (!reply.trim()) {
        throw new Error('The AI returned an empty response. Please try again.')
      }
      setMessages((prev) => ({
        ...prev,
        [mode]: [...conversation, { role: 'assistant', content: reply }],
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI request failed'
      setErrors((prev) => ({
        ...prev,
        [mode]: message.includes('not configured')
          ? 'AI is not configured — set it up in the AI Setting tab.'
          : message,
      }))
      // Drop the placeholder when nothing streamed; keep partial output otherwise.
      setMessages((prev) => {
        const list = prev[mode]
        const last = list[list.length - 1]
        if (last && last.role === 'assistant' && !last.content.trim()) {
          return { ...prev, [mode]: list.slice(0, -1) }
        }
        return prev
      })
    } finally {
      setLoadingMode(null)
    }
  }

  const handleApply = (content: string) => {
    const code = extractCodeBlock(content)
    if (!code) return
    const snapshotNow = getWorkspaceSnapshot()
    if (mode === 'sql') {
      emit({ type: 'load-sql', sql: code, connectionId: snapshotNow.connectionId || undefined })
      showNotice('SQL applied to the SQL editor.')
      onOpenEditor?.()
    } else if (mode === 'script') {
      const builder = snapshotNow.builderQuery
      const source: 'builder' | 'sql' | 'none' = builder
        ? 'builder'
        : snapshotNow.sqlText.trim()
          ? 'sql'
          : 'none'
      emit({
        type: 'load-script',
        script: {
          language: 'python',
          script: code,
          connection_id: null,
          query: null,
          sql: null,
        },
        source,
      })
      showNotice('Script inserted into the Analyze editor.')
      onOpenScript?.()
    } else if (mode === 'chart') {
      try {
        const option = parseEchartScript(code, snapshotNow.rows)
        const toBi = chartTarget === 'bi'
        emit({ type: 'apply-chart', option, target: toBi ? 'bi' : 'script' })
        showNotice(toBi ? 'Chart applied to the Dashboard chart builder.' : 'Chart applied to the Analyze tab.')
        if (toBi) onOpenBi?.()
        else onOpenScript?.()
      } catch (err) {
        setErrors((prev) => ({
          ...prev,
          chart: err instanceof Error ? err.message : 'Failed to parse the chart script',
        }))
      }
    }
  }

  const clearConversation = () => {
    setMessages((prev) => ({ ...prev, [mode]: [] }))
    setInputs((prev) => ({ ...prev, [mode]: '' }))
    setErrors((prev) => ({ ...prev, [mode]: null }))
  }

  const currentMessages = messages[mode]
  const currentInput = inputs[mode]
  const currentError = errors[mode]
  const lastMessage = currentMessages[currentMessages.length - 1]
  /** Waiting for the first streamed chunk (assistant placeholder still empty). */
  const waitingForFirstChunk =
    loadingMode !== null && lastMessage?.role === 'assistant' && lastMessage.content === ''

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: { xs: '100%', sm: drawerWidth },
            minWidth: { xs: '100%', sm: 320 },
            maxWidth: '100%',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      {/* Drag handle to resize the drawer (desktop/tablet). */}
      <Box
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
        sx={{
          display: { xs: 'none', sm: 'block' },
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          zIndex: 2,
          '&:hover, &:active': { bgcolor: 'primary.main', opacity: 0.6 },
        }}
      />
      {/* Header + mode tabs */}
      <Box sx={{ p: 1.5, pb: 0.5, flexShrink: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <AutoAwesomeIcon color="primary" />
            <Typography variant="h6">AI Assistant</Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Button size="small" onClick={clearConversation} disabled={currentMessages.length === 0}>
              Clear
            </Button>
            <IconButton onClick={onClose} aria-label="Close AI assistant" size="small">
              <CloseIcon />
            </IconButton>
          </Stack>
        </Stack>
        <Tabs
          value={mode}
          onChange={(_event, value: AiMode) => onModeChange(value)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ minHeight: 44, mt: 0.5 }}
        >
          {MODES.map((m) => (
            <Tab
              key={m.value}
              value={m.value}
              icon={m.icon}
              iconPosition="start"
              label={m.label}
              sx={{ minHeight: 44 }}
            />
          ))}
        </Tabs>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pt: 0.5 }}>
          {currentMode.hint}
        </Typography>
      </Box>

      {/* Context banner */}
      <Box sx={{ px: 1.5, pb: 1, flexShrink: 0 }}>
        <Paper variant="outlined" sx={{ px: 1.25, py: 0.75, bgcolor: 'action.hover' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Grid data: {snapshot.columns.length > 0 ? `${snapshot.columns.length} column${snapshot.columns.length === 1 ? '' : 's'}` : 'no columns'}
            {snapshot.rows.length > 0
              ? ` · ${snapshot.rows.length.toLocaleString()} row${snapshot.rows.length === 1 ? '' : 's'}`
              : ' · no rows'}
            {snapshot.connectionId ? ' · connection connected' : ''}
          </Typography>
        </Paper>
      </Box>

      {/* Conversation */}
      <Box
        ref={scrollRef}
        sx={{
          flexGrow: 1,
          minHeight: 0,
          overflow: 'auto',
          px: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {currentMessages.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {mode === 'chat' &&
              'Ask anything — e.g. “What does this app do?”, “Explain standard deviation”, or “Summarize this data in plain words”.'}
            {mode === 'sql' &&
              'e.g. “Explain what this SQL does”, “Fix the error: …”, or “Write a query for …”.'}
            {mode === 'script' &&
              'e.g. “Write a Python script that groups rows by region and prints the total amount per region.”'}
            {mode === 'chart' &&
              'e.g. “A bar chart of total amount per region, title “Sales by region”, blue bars.” — or just ask, e.g. “What chart type fits this data?”'}
          </Typography>
        )}
        {currentMessages.map((message, index) =>
          // Skip the in-flight placeholder (empty assistant bubble) while it
          // has no content yet — the "Thinking…" row covers that state.
          message.role === 'assistant' && !message.content.trim() && loadingMode !== null ? null : (
            <Paper
              key={index}
              variant={message.role === 'user' ? 'elevation' : 'outlined'}
              elevation={message.role === 'user' ? 1 : 0}
              sx={{
                p: 1.5,
                position: 'relative',
                bgcolor: message.role === 'user' ? 'primary.main' : 'action.hover',
                color: message.role === 'user' ? 'primary.contrastText' : 'text.primary',
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '95%',
              }}
            >
            {message.role === 'assistant' ? (
              <Box
                sx={{
                  fontSize: '0.875rem',
                  lineHeight: 1.75,
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word',
                  color: 'text.primary',
                  '& > :first-of-type': { mt: 0 },
                  '& > :last-of-type': { mb: 0 },
                  '& p': { my: 0.875 },
                  '& ul, & ol': { my: 0.875, pl: 1.75 },
                  '& li': { my: 0.25 },
                  '& li > p': { my: 0 },
                  '& h1, & h2, & h3, & h4': { fontWeight: 600, lineHeight: 1.25, color: 'text.primary' },
                  '& h1': { fontSize: '1.2rem', mt: 1.5, mb: 0.75 },
                  '& h2': { fontSize: '1.075rem', mt: 1.5, mb: 0.625 },
                  '& h3': { fontSize: '1rem', mt: 1.25, mb: 0.5 },
                  '& h4': { fontSize: '0.9375rem', mt: 1.25, mb: 0.5 },
                  '& a': { color: 'primary.main', fontWeight: 500 },
                  '& strong': { fontWeight: 600 },
                  '& blockquote': {
                    borderLeft: 4,
                    borderColor: 'divider',
                    pl: 1.25,
                    my: 1,
                    color: 'text.secondary',
                    fontStyle: 'italic',
                  },
                  '& table': { borderCollapse: 'collapse', my: 1, width: '100%', fontSize: '0.8125rem' },
                  '& th, & td': { border: 1, borderColor: 'divider', p: 0.5, textAlign: 'left' },
                  '& hr': { my: 1.5, borderColor: 'divider' },
                }}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre: ({ children }) => (
                      <Box
                        component="pre"
                        sx={{
                          my: 1,
                          p: 1.25,
                          bgcolor: 'rgba(0,0,0,0.06)',
                          borderRadius: 1,
                          overflowX: 'auto',
                          fontFamily: 'Consolas, monospace',
                          fontSize: '0.8125rem',
                          lineHeight: 1.6,
                        }}
                      >
                        {children}
                      </Box>
                    ),
                    code: ({ children, className }) => {
                      const text = children
                      const isBlock =
                        /language-/.test(className || '') ||
                        String(text).includes('\n')
                      return (
                        <code
                          style={
                            isBlock
                              ? {
                                  fontFamily: 'Consolas, monospace',
                                  fontSize: '0.875em',
                                  whiteSpace: 'pre-wrap',
                                }
                              : {
                                  fontFamily: 'Consolas, monospace',
                                  fontSize: '0.875em',
                                  backgroundColor: 'rgba(0,0,0,0.05)',
                                  padding: '0.125em 0.375em',
                                  borderRadius: 4,
                                  whiteSpace: 'pre-wrap',
                                }
                          }
                        >
                          {children}
                        </code>
                      )
                    },
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              </Box>
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
            {/* The Chat tab is context-free, so its code blocks are not applied
                anywhere — the Apply button only belongs to the SQL/script/chart tabs. */}
            {mode !== 'chat' && message.role === 'assistant' && extractCodeBlock(message.content) && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<AutoAwesomeIcon />}
                onClick={() => handleApply(message.content)}
                sx={{ mt: 1, minHeight: 40 }}
              >
                {mode === 'sql' && 'Apply to SQL editor'}
                {mode === 'script' && 'Insert into script editor'}
                {mode === 'chart' && 'Apply chart'}
              </Button>
            )}
            </Paper>
          )
        )}
        {waitingForFirstChunk && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Thinking…
            </Typography>
          </Stack>
        )}
      </Box>

      {/* Feedback + input */}
      <Box sx={{ p: 1.5, flexShrink: 0 }}>
        {notice && (
          <Alert severity="success" sx={{ mb: 1 }}>
            {notice}
          </Alert>
        )}
        {currentError && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {currentError}
          </Alert>
        )}
        {/* SQL quick actions: explain / optimize the SQL currently in the editor. */}
        {mode === 'sql' && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1, flexWrap: 'wrap' }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<LightbulbIcon />}
              onClick={() => void handleSend(EXPLAIN_SQL_PROMPT)}
              disabled={loadingMode !== null || !snapshot.sqlText.trim()}
              sx={{ minHeight: 48 }}
            >
              Explain
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<SpeedIcon />}
              onClick={() => void handleSend(OPTIMIZE_SQL_PROMPT)}
              disabled={loadingMode !== null || !snapshot.sqlText.trim()}
              sx={{ minHeight: 48 }}
            >
              Optimize
            </Button>
          </Stack>
        )}
        <Stack direction="row" spacing={1} useFlexGap>
          <TextField
            label="Message"
            value={currentInput}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setInputs((prev) => ({ ...prev, [mode]: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleSend()
              }
            }}
            fullWidth
            multiline
            minRows={2}
            placeholder={
              mode === 'chat'
                ? 'Ask anything…'
                : mode === 'chart'
                  ? 'Ask anything, or describe the chart you want…'
                  : 'Ask anything or request SQL / a script…'
            }
          />
          <Button
            variant="contained"
            onClick={() => void handleSend()}
            disabled={loadingMode !== null || !currentInput.trim()}
            startIcon={
              loadingMode !== null ? <CircularProgress size={16} color="inherit" /> : <AutoAwesomeIcon />
            }
            sx={{ minHeight: 48, alignSelf: 'flex-end' }}
          >
            Send
          </Button>
        </Stack>
      </Box>
    </Drawer>
  )
}
