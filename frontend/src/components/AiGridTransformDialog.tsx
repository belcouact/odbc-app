import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import DeleteIcon from '@mui/icons-material/Delete'
import ReplayIcon from '@mui/icons-material/Replay'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import { api } from '../api/client'
import type { GridScriptHistoryEntry } from '../api/client'
import type { QueryResult } from '../types'

/** How many rows are sent to the AI as context (the script itself gets all rows). */
const SAMPLE_ROWS = 20

type Step = 'requirement' | 'clarify' | 'script'

interface AiGridTransformDialogProps {
  open: boolean
  result: QueryResult
  onClose: () => void
  /** Called after the transform ran: receives the new rows/columns. */
  onApply: (rows: Record<string, unknown>[], columns: { name: string; type: string }[], log: string) => void
}

/**
 * AI-assisted grid editing: the user describes the modification in plain
 * language, the AI first asks clarifying questions (when the request is
 * ambiguous), then writes a Python script which is previewed and run against
 * the current grid rows.
 */
export default function AiGridTransformDialog({
  open,
  result,
  onClose,
  onApply,
}: AiGridTransformDialogProps) {
  const [step, setStep] = useState<Step>('requirement')
  const [requirement, setRequirement] = useState('')
  const [questions, setQuestions] = useState<string[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [script, setScript] = useState('')
  const [busy, setBusy] = useState<'' | 'clarify' | 'script' | 'run'>('')
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<GridScriptHistoryEntry[]>([])

  // Reset the flow and load the script history whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setStep('requirement')
    setRequirement('')
    setQuestions([])
    setAnswers([])
    setScript('')
    setBusy('')
    setError(null)
    api
      .getGridScriptHistory()
      .then(setHistory)
      .catch(() => setHistory([])) // history is optional; ignore load failures
  }, [open])

  const sampleRows = result.rows.slice(0, SAMPLE_ROWS)

  /** Step 1 -> clarify (or straight to the script when nothing to ask). */
  const handleClarify = async () => {
    if (!requirement.trim()) return
    setBusy('clarify')
    setError(null)
    try {
      const response = await api.aiGridClarify({
        requirement: requirement.trim(),
        columns: result.columns,
        rows_sample: sampleRows,
      })
      if (response.questions.length > 0) {
        setQuestions(response.questions)
        setAnswers(response.questions.map(() => ''))
        setStep('clarify')
      } else {
        await generate([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI request failed')
    } finally {
      setBusy('')
    }
  }

  /** Generate the transform script (optionally with clarified answers). */
  const generate = async (qaAnswers: string[]) => {
    setBusy('script')
    setError(null)
    try {
      const response = await api.aiGridScript({
        requirement: requirement.trim(),
        questions,
        answers: qaAnswers,
        columns: result.columns,
        rows_sample: sampleRows,
      })
      setScript(response.script)
      setStep('script')
      // Keep the generated script for re-use (fire and forget).
      const entry: GridScriptHistoryEntry = {
        id: `local-${Date.now()}`,
        requirement: requirement.trim(),
        script: response.script,
        created_at: new Date().toISOString(),
      }
      setHistory((prev) => [entry, ...prev.filter((e) => e.script !== response.script)])
      void api.addGridScriptHistory({ requirement: entry.requirement, script: response.script })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI request failed')
    } finally {
      setBusy('')
    }
  }

  /** Re-use a stored script: prefill requirement + script, jump to the preview. */
  const reuseEntry = (entry: GridScriptHistoryEntry) => {
    setRequirement(entry.requirement)
    setScript(entry.script)
    setStep('script')
  }

  const deleteEntry = async (id: string) => {
    setHistory((prev) => prev.filter((e) => e.id !== id))
    try {
      await api.deleteGridScriptHistory(id)
    } catch {
      // best effort; the entry is already gone from the UI
    }
  }

  /** Preview accepted -> run the script against ALL grid rows. */
  const handleRun = async () => {
    setBusy('run')
    setError(null)
    try {
      const response = await api.gridTransform({
        script,
        rows: result.rows,
        columns: result.columns,
      })
      onApply(response.rows, response.columns, response.stdout)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transform failed')
    } finally {
      setBusy('')
    }
  }

  const working = busy !== ''

  /** Click a column chip to append its name to the requirement text. */
  const insertColumn = (name: string) => {
    if (step !== 'requirement' || working) return
    setRequirement((prev) => {
      const sep = prev.trim() && !prev.trimEnd().endsWith('\n') ? '\n' : ''
      return prev.trim() ? `${prev.trimEnd()}${sep}Column: ${name}` : `Column: ${name}`
    })
  }

  return (
    <Dialog
      open={open}
      onClose={working ? undefined : onClose}
      fullWidth
      maxWidth="md"
      fullScreen={typeof window !== 'undefined' && window.innerWidth < 600}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoAwesomeIcon color="primary" fontSize="small" />
        Edit grid with AI
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          {error && <Alert severity="error">{error}</Alert>}

          {/* Column reference: click a chip to insert its name */}
          {result.columns.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Grid columns ({result.columns.length}) — click one to insert its name
              </Typography>
              <Stack
                direction="row"
                spacing={0.5}
                useFlexGap
                sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.75, maxHeight: 120, overflowY: 'auto' }}
              >
                {result.columns.map((col) => (
                  <Chip
                    key={col.name}
                    label={col.name}
                    size="small"
                    onClick={() => insertColumn(col.name)}
                    sx={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 12 }}
                  />
                ))}
              </Stack>
            </Box>
          )}

          {/* Step 1: requirement */}
          <TextField
            label="What should be changed in the grid?"
            placeholder="e.g. Normalize the Yield column to percent, and add a flag column for rows below 95%"
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            multiline
            minRows={6}
            fullWidth
            disabled={working || step !== 'requirement'}
            helperText={`A Python script will be generated and run on the current ${result.row_count.toLocaleString()} row(s). The AI sees the column names and the first ${SAMPLE_ROWS} rows only.`}
          />

          {/* Recent scripts for re-use */}
          {step === 'requirement' && history.length > 0 && (
            <Box>
              <Divider sx={{ mb: 1 }} />
              <Typography variant="caption" color="text.secondary">
                Recent scripts ({history.length}) — click "Reuse" to run one again
              </Typography>
              <List dense disablePadding sx={{ maxHeight: 200, overflowY: 'auto', mt: 0.5 }}>
                {history.map((entry) => (
                  <ListItem
                    key={entry.id}
                    disableGutters
                    secondaryAction={
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                        <Button size="small" onClick={() => reuseEntry(entry)} sx={{ minHeight: 36 }}>
                          Reuse
                        </Button>
                        <Tooltip title="Delete from history">
                          <IconButton
                            size="small"
                            aria-label="Delete script"
                            onClick={() => void deleteEntry(entry.id)}
                            sx={{ minHeight: 36, minWidth: 36 }}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    }
                    sx={{ py: 0.75, pr: { xs: 14, sm: 18 } }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        sx={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          wordBreak: 'break-word',
                        }}
                      >
                        {entry.requirement}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {new Date(entry.created_at).toLocaleString()}
                      </Typography>
                    </Box>
                  </ListItem>
                ))}
              </List>
            </Box>
          )}

          {/* Step 2: clarifying questions (kept visible after answering) */}
          {step !== 'requirement' && questions.length > 0 && (
            <Stack spacing={1.5}>
              <Typography variant="subtitle2">A few questions before scripting</Typography>
              {questions.map((question, index) => (
                <TextField
                  key={index}
                  label={question}
                  value={answers[index] ?? ''}
                  onChange={(e) =>
                    setAnswers((prev) => prev.map((a, i) => (i === index ? e.target.value : a)))
                  }
                  size="small"
                  fullWidth
                  disabled={working || step === 'script'}
                />
              ))}
            </Stack>
          )}

          {/* Step 3: generated script preview */}
          {step === 'script' && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Generated script — review before running
              </Typography>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1.5,
                  maxHeight: 260,
                  overflow: 'auto',
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  fontFamily: 'Consolas, Menlo, monospace',
                  bgcolor: (theme) =>
                    theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {script}
              </Box>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.5, flexWrap: 'wrap', gap: 1 }}>
        {step === 'requirement' && (
          <>
            <Button onClick={onClose} disabled={working} sx={{ minHeight: 44 }}>
              Cancel
            </Button>
            <Button
              variant="contained"
              startIcon={
                busy === 'clarify' || busy === 'script' ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <AutoAwesomeIcon />
                )
              }
              onClick={() => void handleClarify()}
              disabled={working || !requirement.trim()}
              sx={{ minHeight: 44 }}
            >
              {busy === 'clarify' || busy === 'script' ? 'Thinking…' : 'Continue'}
            </Button>
          </>
        )}
        {step === 'clarify' && (
          <>
            <Button onClick={() => void generate(answers)} disabled={busy !== ''} sx={{ minHeight: 44 }}>
              {busy === 'script' ? 'Generating…' : 'No answers — continue'}
            </Button>
            <Button
              variant="contained"
              onClick={() => void generate(answers)}
              disabled={busy !== ''}
              startIcon={busy === 'script' ? <CircularProgress size={16} color="inherit" /> : undefined}
              sx={{ minHeight: 44 }}
            >
              Generate script
            </Button>
          </>
        )}
        {step === 'script' && (
          <>
            <Button
              startIcon={<ReplayIcon />}
              onClick={() => void generate(answers)}
              disabled={busy !== ''}
              sx={{ minHeight: 44 }}
            >
              Regenerate
            </Button>
            <Button onClick={onClose} disabled={busy !== ''} sx={{ minHeight: 44 }}>
              Close
            </Button>
            <Button
              variant="contained"
              color="success"
              startIcon={busy === 'run' ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
              onClick={() => void handleRun()}
              disabled={busy !== ''}
              sx={{ minHeight: 44 }}
            >
              {busy === 'run' ? 'Running…' : 'Run on grid'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}
