import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import ErrorIcon from '@mui/icons-material/Error'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import InputLabel from '@mui/material/InputLabel'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Slider from '@mui/material/Slider'
import { api } from '../api/client'
import type { AiSettings, AiSettingsProfile } from '../types'

type Notice = { severity: 'success' | 'error'; message: string } | null

/** Common LLM presets. Selecting one fills provider / endpoint / model.
 *  API keys are left blank on purpose — the user fills them in when needed.
 *  `key_url` opens the provider's API-key application page (new window);
 *  a null `key_url` means the preset needs no key (e.g. local Ollama). */
const LLM_PRESETS: {
  id: string
  label: string
  brand: string
  provider: string
  base_url: string
  model: string
  key_url: string | null
}[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    brand: 'OpenAI',
    provider: 'openai',
    base_url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5.6-luna',
    key_url: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba · DashScope)',
    brand: 'Qwen (DashScope)',
    provider: 'openai',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3.8-flash',
    key_url: 'https://platform.qianwenai.com/home/api-keys',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot · CN)',
    brand: 'Moonshot Kimi',
    provider: 'openai',
    base_url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k3',
    key_url: 'https://platform.kimi.com/console/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    brand: 'DeepSeek',
    provider: 'openai',
    base_url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
    key_url: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'glm',
    label: 'GLM (Zhipu)',
    brand: 'Zhipu GLM',
    provider: 'openai',
    base_url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-5.3-flash',
    key_url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'volcengine',
    label: 'Volcengine (Doubao · ARK)',
    brand: 'Volcengine (Doubao)',
    provider: 'openai',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: 'doubao-seed-2-1-turbo-260628',
    key_url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
  },
  {
    id: 'mimo',
    label: 'MiMo (Xiaomi)',
    brand: 'MiMo (Xiaomi)',
    provider: 'openai',
    base_url: 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2-flash',
    key_url: 'https://platform.xiaomimimo.com/#/console/api-keys',
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    brand: 'Anthropic Claude',
    provider: 'anthropic',
    base_url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-5',
    key_url: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local, no API key)',
    brand: 'Ollama',
    provider: 'openai',
    base_url: 'http://localhost:11434/v1/chat/completions',
    model: 'llama3.1',
    key_url: null,
  },
]

/** Fallback guesses when the user edited the URL into a custom form. */
const API_KEY_HINTS: { contains: string; brand: string; url: string }[] = [
  { contains: 'api.openai.com', brand: 'OpenAI', url: 'https://platform.openai.com/api-keys' },
  { contains: 'moonshot', brand: 'Moonshot Kimi', url: 'https://platform.kimi.com/console/api-keys' },
  { contains: 'api.deepseek.com', brand: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys' },
  { contains: 'volces.com', brand: 'Volcengine (Doubao)', url: 'https://console.volcengine.com/ark' },
  { contains: 'xiaomimimo', brand: 'MiMo (Xiaomi)', url: 'https://platform.xiaomimimo.com/#/console/api-keys' },
  { contains: 'bigmodel.cn', brand: 'Zhipu GLM', url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  { contains: 'z.ai', brand: 'Zhipu GLM', url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  { contains: 'dashscope', brand: 'Qwen (DashScope)', url: 'https://platform.qianwenai.com/home/api-keys' },
  { contains: 'qianwenai', brand: 'Qwen (DashScope)', url: 'https://platform.qianwenai.com/home/api-keys' },
  { contains: 'anthropic', brand: 'Anthropic Claude', url: 'https://console.anthropic.com/settings/keys' },
]

/** Endpoint identity an API key belongs to: a known preset brand, else a URL
 *  hint, else the host itself, so two custom endpoints don't share one key. */
function brandOf(settings: Pick<AiSettings, 'provider' | 'base_url' | 'model'>): string {
  const preset = LLM_PRESETS.find(
    (p) =>
      p.provider === settings.provider &&
      p.base_url === settings.base_url &&
      p.model === settings.model,
  )
  if (preset) return preset.brand
  const lower = settings.base_url.toLowerCase()
  const hint = API_KEY_HINTS.find((h) => lower.includes(h.contains))
  if (hint) return hint.brand
  try {
    return new URL(settings.base_url).host || 'Custom endpoint'
  } catch {
    return 'Custom endpoint'
  }
}

/** The label a saved key is filed under: the brand and model it was used for. */
function savedKeyLabel(settings: Pick<AiSettings, 'provider' | 'base_url' | 'model'>): string {
  const model = settings.model.trim() || 'unknown model'
  return `${brandOf(settings)} · ${model}`
}

export default function AiSettingsPage() {
  const [form, setForm] = useState<AiSettings>({
    enabled: true,
    provider: 'openai',
    base_url: 'https://api.openai.com/v1/chat/completions',
    api_key: '',
    model: 'gpt-5.6-luna',
    temperature: 0.2,
  })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Keys already on file, keyed by "brand · model", so the key offered back is
   *  the one that belongs to the selected brand and model. */
  const [savedKeys, setSavedKeys] = useState<Record<string, string>>({})
  /** Snapshots of previously saved configurations, listable in the dropdown. */
  const [savedProfiles, setSavedProfiles] = useState<AiSettingsProfile[]>([])
  /** Label picked in the "Saved settings" dropdown ('' = nothing picked). */
  const [pickedProfile, setPickedProfile] = useState('')
  /** Saved setting queued for deletion, confirmed via a dialog before removal. */
  const [pendingDelete, setPendingDelete] = useState<AiSettingsProfile | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const settings = await api.getAiSettings()
      const loaded: AiSettings = {
        enabled: settings.enabled ?? true,
        provider: settings.provider ?? 'openai',
        base_url: settings.base_url ?? 'https://api.openai.com/v1/chat/completions',
        api_key: settings.api_key ?? '',
        model: settings.model ?? 'gpt-5.6-luna',
        temperature: settings.temperature ?? 0.2,
      }
      setForm(loaded)
      // A key saved before keys were filed by label still belongs to whatever
      // brand/model it was saved for, so it is filed under that label now.
      const keys = { ...(settings.saved_keys ?? {}) }
      const label = savedKeyLabel(loaded)
      if (loaded.api_key && !keys[label]) keys[label] = loaded.api_key
      setSavedKeys(keys)
      setSavedProfiles(settings.saved_profiles ?? [])
      setShowApiKey(false)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load AI settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  /** Id of the matching preset, or '' when the fields were customized. */
  const activePreset = LLM_PRESETS.find(
    (p) => p.provider === form.provider && p.base_url === form.base_url && p.model === form.model,
  )?.id ?? ''

  /** Link to the key-application page for the current provider, or null when
   *  none is known (e.g. a fully custom endpoint or local Ollama). */
  const apiKeyApply = useMemo(() => {
    if (activePreset) {
      const preset = LLM_PRESETS.find((p) => p.id === activePreset)
      if (preset && preset.key_url) return { url: preset.key_url, brand: preset.brand }
      return null
    }
    const lower = form.base_url.toLowerCase()
    const hint = API_KEY_HINTS.find((h) => lower.includes(h.contains))
    return hint ? { url: hint.url, brand: hint.brand } : null
  }, [activePreset, form.base_url])

  const applyPreset = (event: SelectChangeEvent) => {
    const preset = LLM_PRESETS.find((p) => p.id === event.target.value)
    if (!preset) return
    setForm((current) => ({
      ...current,
      provider: preset.provider,
      base_url: preset.base_url,
      model: preset.model,
      // Selecting a different model means a different provider/endpoint, so the
      // previous key no longer applies. If this brand/model already has a key on
      // file it is restored right away, so switching back keeps working without
      // having to hunt for the key again.
      api_key: savedKeys[savedKeyLabel(preset)] ?? '',
    }))
    setShowApiKey(false)
    setTestResult(null)
  }

  /** Re-fill every field from a previously saved configuration snapshot. The
   *  dropdown is an action rather than a persistent selection, so it resets to
   *  the placeholder right after applying. */
  const applySavedProfile = (event: SelectChangeEvent) => {
    const picked = event.target.value
    setPickedProfile('')
    const profile = savedProfiles.find((p) => p.label === picked)
    if (!profile) return
    setForm({
      enabled: profile.enabled,
      provider: profile.provider || 'openai',
      base_url: profile.base_url,
      api_key: profile.api_key || '',
      model: profile.model,
      temperature:
        typeof profile.temperature === 'number' ? profile.temperature : 0.2,
    })
    setShowApiKey(false)
    setTestResult(null)
  }

  /** Deletes the confirmed saved setting. The keyring entry stays on file so
   *  re-creating the same endpoint configuration restores its key. */
  const handleDeleteConfirmed = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const saved = await api.deleteAiSettingsProfile(pendingDelete.label)
      setSavedProfiles(saved?.saved_profiles ?? [])
      setNotice({ severity: 'success', message: `Saved setting "${pendingDelete.label}" deleted.` })
    } catch (err) {
      setNotice({
        severity: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete saved setting',
      })
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  const updateField =
    (field: keyof AiSettings) => (event: ChangeEvent<HTMLInputElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }))
      setTestResult(null)
    }

  const updateProvider = (event: SelectChangeEvent) => {
    setForm((current) => ({ ...current, provider: event.target.value }))
    setTestResult(null)
  }

  /** The saved key filed under the selected brand and model, if there is one. */
  const savedKey = savedKeys[savedKeyLabel(form)] ?? ''
  const canRestoreSavedKey = savedKey !== '' && form.api_key !== savedKey

  const restoreSavedKey = () => {
    setForm((current) => ({ ...current, api_key: savedKey }))
    setShowApiKey(true)
    setTestResult(null)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // The label says which brand/model this key is for, so it is filed under
      // that pair rather than replacing whatever key was last saved. The same
      // label also names the configuration snapshot the dropdown can re-load.
      const saved = await api.saveAiSettings({
        ...form,
        key_label: savedKeyLabel(form),
        profile_label: savedKeyLabel(form),
      })
      setSavedKeys(saved?.saved_keys ?? {})
      setSavedProfiles(saved?.saved_profiles ?? savedProfiles)
      setNotice({ severity: 'success', message: 'AI settings saved — the assistant uses them on your next message.' })
    } catch (err) {
      setNotice({
        severity: 'error',
        message: err instanceof Error ? err.message : 'Failed to save AI settings',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.testAi(form)
      setTestResult(result)
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Connection test failed',
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', width: '100%' }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h5">AI Setting</Typography>
          <Typography variant="body2" color="text.secondary">
            Configure an OpenAI-compatible LLM endpoint used for NL-to-SQL and AI summaries.
          </Typography>
        </Box>

        {loading && (
          <Box sx={{ py: 4, textAlign: 'center' }}>
            <CircularProgress size={26} />
          </Box>
        )}

        {loadError && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void loadSettings()}>
                Retry
              </Button>
            }
          >
            {loadError}
          </Alert>
        )}

        {!loading && (
          <Paper data-tour="ai-settings" variant="outlined" sx={{ p: { xs: 1.5, sm: 3 } }}>
            <Stack spacing={2.5}>
              <FormControlLabel
                control={
                  <Switch
                    checked={form.enabled}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      setForm((current) => ({ ...current, enabled: event.target.checked }))
                      setTestResult(null)
                    }}
                  />
                }
                label="Enable AI (LLM)"
              />

              <FormControl fullWidth>
                <InputLabel id="llm-saved-label">Saved settings</InputLabel>
                <Select
                  labelId="llm-saved-label"
                  label="Saved settings"
                  value={pickedProfile}
                  onChange={applySavedProfile}
                  sx={{ minHeight: 48 }}
                >
                  <MenuItem value="">
                    <em>
                      {savedProfiles.length
                        ? 'Load a saved setting…'
                        : 'No saved settings yet — they appear after you click Save'}
                    </em>
                  </MenuItem>
                  {savedProfiles.map((profile) => (
                    <MenuItem
                      key={profile.label}
                      value={profile.label}
                      sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                    >
                      <Box sx={{ py: 0.25, minWidth: 0, flexGrow: 1 }}>
                        <Typography variant="body2" component="div">
                          {profile.label}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          component="div"
                          sx={{
                            maxWidth: { xs: '60vw', sm: 360 },
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {profile.model}
                          {profile.saved_at
                            ? ` · saved ${new Date(profile.saved_at).toLocaleDateString()}`
                            : ''}
                        </Typography>
                      </Box>
                      <IconButton
                        aria-label={`Delete saved setting ${profile.label}`}
                        title={`Delete saved setting "${profile.label}"`}
                        onClick={(event) => {
                          // Stop the click so the Select does not treat it as
                          // picking this profile, and the menu stays open.
                          event.stopPropagation()
                          setPendingDelete(profile)
                        }}
                        size="small"
                        sx={{ flexShrink: 0, width: 48, height: 48, mr: -1.5 }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel id="llm-preset-label">Quick setup preset</InputLabel>
                <Select
                  labelId="llm-preset-label"
                  label="Quick setup preset"
                  value={activePreset}
                  onChange={applyPreset}
                  sx={{ minHeight: 48 }}
                >
                  <MenuItem value="">
                    <em>Custom (edit fields below)</em>
                  </MenuItem>
                  {LLM_PRESETS.map((preset) => (
                    <MenuItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel id="llm-provider-label">Provider protocol</InputLabel>
                <Select
                  labelId="llm-provider-label"
                  label="Provider protocol"
                  value={form.provider}
                  onChange={updateProvider}
                  sx={{ minHeight: 48 }}
                >
                  <MenuItem value="openai">OpenAI-compatible (chat/completions)</MenuItem>
                  <MenuItem value="anthropic">Anthropic (Messages API)</MenuItem>
                </Select>
              </FormControl>

              <TextField
                label="API Base URL (full endpoint)"
                value={form.base_url}
                onChange={updateField('base_url')}
                fullWidth
                placeholder="https://api.openai.com/v1/chat/completions"
                helperText="Used exactly as entered — nothing is appended. Stored locally in %APPDATA%."
              />

              <Box>
                {apiKeyApply && (
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
                    <Link
                      href={apiKeyApply.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      underline="hover"
                      variant="body2"
                      onClick={() => setTestResult(null)}
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minHeight: 32 }}
                    >
                      {`Apply for a ${apiKeyApply.brand} API key`}
                      <OpenInNewIcon sx={{ fontSize: 14 }} />
                    </Link>
                  </Box>
                )}
                <TextField
                  label="API Key"
                  type={showApiKey ? 'text' : 'password'}
                  value={form.api_key}
                  onChange={updateField('api_key')}
                  fullWidth
                  autoComplete="off"
                  placeholder="sk-… (optional)"
                  helperText={
                    canRestoreSavedKey
                      ? `Cleared after the model change — the key saved for ${savedKeyLabel(form)} is still on file.`
                      : 'Optional — leave blank for keyless endpoints such as local Ollama.'
                  }
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            onClick={() => setShowApiKey((visible) => !visible)}
                            onMouseDown={(event) => event.preventDefault()}
                            edge="end"
                            aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                            aria-pressed={showApiKey}
                            title={showApiKey ? 'Hide API key' : 'Show API key'}
                            sx={{ width: 48, height: 48, mr: -1 }}
                          >
                            {showApiKey ? (
                              <VisibilityOffIcon fontSize="small" />
                            ) : (
                              <VisibilityIcon fontSize="small" />
                            )}
                          </IconButton>
                        </InputAdornment>
                      ),
                    },
                  }}
                />
                {canRestoreSavedKey && (
                  <Button
                    size="small"
                    variant="text"
                    onClick={restoreSavedKey}
                    sx={{ mt: 0.5, minHeight: 48, textAlign: 'left' }}
                  >
                    {`Use saved API key — ${savedKeyLabel(form)}`}
                  </Button>
                )}
              </Box>

              <TextField
                label="Model"
                value={form.model}
                onChange={updateField('model')}
                fullWidth
                placeholder="gpt-5.6-luna"
                helperText="Free text — type any model name, including models not listed in the presets."
              />

              <Box>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  Temperature
                </Typography>
                <Slider
                  value={form.temperature}
                  min={0}
                  max={1}
                  step={0.05}
                  valueLabelDisplay="auto"
                  onChange={(_event, value) => {
                    setForm((current) => ({ ...current, temperature: value as number }))
                    setTestResult(null)
                  }}
                  sx={{ maxWidth: 420 }}
                />
              </Box>

              {!form.enabled && (
                <Alert severity="info" icon={<AutoAwesomeIcon fontSize="small" />}>
                  AI is disabled — NL-to-SQL (“Ask AI”) and AI summaries are off until you enable it
                  and save.
                </Alert>
              )}

              {testResult && (
                <Alert severity={testResult.ok ? 'success' : 'error'} icon={testResult.ok ? <CheckCircleIcon /> : <ErrorIcon />}>
                  {testResult.ok ? `Connected — model replied: ${testResult.message}` : testResult.message}
                </Alert>
              )}

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                useFlexGap
                sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
              >
                <Button
                  variant="contained"
                  onClick={() => void handleSave()}
                  disabled={saving || testing}
                  startIcon={saving ? <CircularProgress size={18} color="inherit" /> : undefined}
                  sx={{ minHeight: 48 }}
                >
                  Save
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => void handleTest()}
                  disabled={testing || saving}
                  startIcon={testing ? <CircularProgress size={18} /> : <CheckCircleIcon />}
                  sx={{ minHeight: 48 }}
                >
                  Test connection
                </Button>
              </Stack>
            </Stack>
          </Paper>
        )}
      </Stack>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => (deleting ? undefined : setPendingDelete(null))}
        aria-labelledby="ai-profile-delete-title"
      >
        <DialogTitle id="ai-profile-delete-title">Delete saved setting?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <strong>{pendingDelete?.label}</strong> will be removed from the
            "Saved settings" dropdown. Its API key stays on file, so re-saving
            the same endpoint configuration restores it.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            startIcon={deleting ? <CircularProgress size={18} color="inherit" /> : undefined}
            disabled={deleting}
            onClick={() => void handleDeleteConfirmed()}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={notice?.severity ?? 'info'}
          variant="filled"
          onClose={() => setNotice(null)}
        >
          {notice?.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}
