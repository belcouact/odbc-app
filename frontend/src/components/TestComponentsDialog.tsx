import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import SaveIcon from '@mui/icons-material/Save'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import type { ComponentSet, TestComponent } from '../api/client'

/**
 * Split the RESULT_NAME field's separator-delimited text into distinct names.
 * Values are ';'-separated because RESULT_NAME may contain ','; legacy values
 * saved with ',' still split correctly when no ';' is present.
 */
function parseComponentValue(text: string): string[] {
  const parts = new Set<string>()
  const separator = (text || '').includes(';') ? ';' : ','
  for (const raw of (text || '').split(separator)) {
    const part = raw.trim()
    if (part) parts.add(part)
  }
  return Array.from(parts)
}

interface TestComponentsDialogProps {
  open: boolean
  onClose: () => void
  /** Display name of the active connection (used for the component lookup). */
  connectionName: string
  /** Pushes the picked RESULT_NAME list into the query field (semicolon-joined). */
  onApply: (resultNames: string) => void
  /** Called after a set is saved/updated/deleted so the parent can refresh. */
  onSaved?: () => void
  /** Success message shown by the parent (e.g. inside the page Snackbar). */
  onNotice?: (message: string) => void
}

/**
 * "Test Components" picker for the Tautona quick-search.
 *
 * Left panel lists the analyses (pick one); the right panel lists the
 * RESULT_NAMEs produced by the picked analysis, which can be ticked into the
 * editable selection field. Like the "Select Channels" picker, named sets can
 * be saved, updated and deleted, and an existing set can be loaded back.
 */
export default function TestComponentsDialog({
  open,
  onClose,
  connectionName,
  onApply,
  onSaved,
  onNotice,
}: TestComponentsDialogProps) {
  const { t } = useTranslation('dialogs')
  const [analyses, setAnalyses] = useState<TestComponent[]>([])
  const [analysesLoading, setAnalysesLoading] = useState(false)
  const [analysesError, setAnalysesError] = useState<string | null>(null)
  /** Connection name the cached analyses were loaded for. */
  const [analysesFor, setAnalysesFor] = useState('')

  /** Name of the analysis picked on the left (single-select). */
  const [selectedAnalysis, setSelectedAnalysis] = useState('')
  /** Editable content of the RESULT_NAME selection field. */
  const [componentValue, setComponentValue] = useState('')

  const [existingSets, setExistingSets] = useState<ComponentSet[]>([])
  const [existingSetsLoading, setExistingSetsLoading] = useState(false)
  const [selectedSetName, setSelectedSetName] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reset + (re)load the analyses and saved sets whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setSelectedAnalysis('')
    setComponentValue('')
    setSaveError(null)
    setSelectedSetName('')
    setName('')
    setExistingSets([])
    setExistingSetsLoading(true)
    api
      .getComponentSets()
      .then((response) => setExistingSets(response.sets))
      .catch(() => setExistingSets([]))
      .finally(() => setExistingSetsLoading(false))
    const target = connectionName || 'FabLIMS'
    if (analysesFor !== target && !analysesLoading) {
      setAnalysesLoading(true)
      setAnalysesError(null)
      api
        .getTestComponents(target)
        .then((response) => {
          setAnalyses(response.components)
          setAnalysesFor(target)
        })
        .catch((err) =>
          setAnalysesError(err instanceof Error ? err.message : t('testComponents.loadFailed')),
        )
        .finally(() => setAnalysesLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionName])

  const refreshExistingSets = () => {
    setExistingSetsLoading(true)
    api
      .getComponentSets()
      .then((response) => {
        setExistingSets(response.sets)
        // Drop the selection if the set no longer exists after the fetch.
        setSelectedSetName((current) =>
          response.sets.some((set) => set.name === current) ? current : '',
        )
      })
      .catch(() => {
        // Leave the current list untouched on a transient failure.
      })
      .finally(() => setExistingSetsLoading(false))
  }

  /** Analyses shown on the left panel, sorted by analysis name. */
  const sortedAnalyses = useMemo(
    () =>
      [...analyses].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [analyses],
  )

  /** Components currently in the selection field (i.e. ticked on the right). */
  const selectedResultNames = useMemo(() => parseComponentValue(componentValue), [componentValue])

  /** Candidate components of the picked analysis, listed on the right. */
  const candidateComponents = useMemo(() => {
    const picked = analyses.find((component) => component.name === selectedAnalysis)
    if (!picked) return []
    return Array.from(new Set(picked.result_names)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )
  }, [selectedAnalysis, analyses])

  /** Check/uncheck a component on the right — only these go into the field. */
  const toggleRightComponent = (resultName: string) => {
    setComponentValue((currentValue) => {
      const parts = parseComponentValue(currentValue)
      const next = parts.includes(resultName)
        ? parts.filter((part) => part !== resultName)
        : [...parts, resultName]
      return next.join('; ')
    })
  }

  /** Load an existing set: name it, fill the field and pick the analysis that
   *  supplies most of its components. */
  const handleExistingChange = (existingName: string) => {
    setSelectedSetName(existingName)
    const foundSet = existingSets.find((s) => s.name === existingName)
    if (foundSet) {
      const names = (foundSet.result_names ?? []).map((n) => String(n).trim()).filter(Boolean)
      setName(foundSet.name)
      setComponentValue(names.join('; '))
      // Only one analysis can be picked on the left, so pick the best match.
      const wanted = new Set(names)
      let best = ''
      let bestCount = 0
      for (const component of analyses) {
        const count = component.result_names.filter((n) => wanted.has(n)).length
        if (count > bestCount) {
          best = component.name
          bestCount = count
        }
      }
      setSelectedAnalysis(best)
    }
  }

  const canSave = name.trim() !== '' && selectedResultNames.length > 0 && !busy
  const canUpdate = selectedSetName.trim() !== '' && selectedResultNames.length > 0 && !busy
  const canDelete = selectedSetName.trim() !== '' && !busy

  const handleSave = async () => {
    if (!canSave) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.saveComponentSet({ name: name.trim(), result_names: selectedResultNames })
      onSaved?.()
      onNotice?.(t('testComponents.savedNotice', { name: name.trim() }))
      refreshExistingSets()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('testComponents.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleUpdate = async () => {
    if (!canUpdate) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.saveComponentSet({ name: selectedSetName, result_names: selectedResultNames })
      onSaved?.()
      onNotice?.(t('testComponents.updatedNotice', { name: selectedSetName }))
      refreshExistingSets()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('testComponents.updateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!canDelete) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.deleteComponentSet(selectedSetName)
      onSaved?.()
      onNotice?.(t('testComponents.deletedNotice', { name: selectedSetName }))
      setSelectedSetName('')
      setName('')
      refreshExistingSets()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('testComponents.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** Push the current selection into the RESULT_NAME query field. */
  const handleLoad = () => {
    onApply(componentValue.trim())
    onClose()
  }

  const emptyAnalyses = !analysesLoading && !analysesError && analyses.length === 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      slotProps={{ paper: { sx: { borderRadius: 0 } } }}
    >
      <DialogTitle>
        {t('testComponents.title')}
        <IconButton
          aria-label={t('testComponents.ariaClose')}
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {analysesError ? (
          <Alert severity="error">{analysesError}</Alert>
        ) : analysesLoading && analyses.length === 0 ? (
          <Stack sx={{ alignItems: 'center', py: 4 }}>
            <CircularProgress size={28} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {t('testComponents.loading')}
            </Typography>
          </Stack>
        ) : emptyAnalyses ? (
          <Alert severity="info">{t('testComponents.none')}</Alert>
        ) : (
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  {t('testComponents.analysesHeading')}
                </Typography>
                <Box
                  sx={{
                    height: { xs: '42vh', md: 'calc(100vh - 350px)' },
                    minHeight: 220,
                    overflowY: 'auto',
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                  }}
                >
                  <List dense disablePadding>
                    {sortedAnalyses.map((component) => {
                      const checked = selectedAnalysis === component.name
                      return (
                        <ListItemButton
                          key={component.name}
                          dense
                          onClick={() => setSelectedAnalysis(component.name)}
                          selected={checked}
                          // Keep a comfortable touch target on phones.
                          sx={{ minHeight: { xs: 48, md: 'auto' } }}
                        >
                          <Radio
                            size="small"
                            edge="start"
                            checked={checked}
                            tabIndex={-1}
                            disableRipple
                            sx={{ py: 0.5 }}
                          />
                          <ListItemText
                            primary={
                              <Typography variant="body2" noWrap>
                                {[component.name, component.description].filter(Boolean).join(' - ')}
                              </Typography>
                            }
                          />
                        </ListItemButton>
                      )
                    })}
                  </List>
                </Box>
              </Box>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  {t('testComponents.componentsHeading', { count: selectedResultNames.length })}
                </Typography>
                <Box
                  sx={{
                    height: { xs: '42vh', md: 'calc(100vh - 350px)' },
                    minHeight: 220,
                    overflowY: 'auto',
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                  }}
                >
                  <List dense disablePadding>
                    {candidateComponents.length === 0 ? (
                      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                        {t('testComponents.pickAnalysis')}
                      </Typography>
                    ) : (
                      candidateComponents.map((resultName) => {
                        const checked = selectedResultNames.includes(resultName)
                        return (
                          <ListItemButton
                            key={resultName}
                            dense
                            onClick={() => toggleRightComponent(resultName)}
                            selected={checked}
                            // Keep a comfortable touch target on phones.
                            sx={{ minHeight: { xs: 48, md: 'auto' } }}
                          >
                            <Checkbox
                              size="small"
                              edge="start"
                              checked={checked}
                              tabIndex={-1}
                              disableRipple
                              sx={{ py: 0.5 }}
                            />
                            <ListItemText
                              primary={<Typography variant="body2">{resultName}</Typography>}
                            />
                          </ListItemButton>
                        )
                      })
                    )}
                  </List>
                </Box>
              </Box>
            </Stack>

            {/* Existing pre-defined sets + save / update / delete actions */}
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              useFlexGap
              sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
            >
              <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 240 }, flexGrow: 1 }}>
                <InputLabel id="existing-component-set-label">{t('testComponents.existingSet')}</InputLabel>
                <Select
                  labelId="existing-component-set-label"
                  label={t('testComponents.existingSet')}
                  value={selectedSetName}
                  onChange={(event: SelectChangeEvent) => handleExistingChange(event.target.value)}
                  disabled={existingSetsLoading || existingSets.length === 0}
                >
                  <MenuItem value="">{t('testComponents.loadSavedSet')}</MenuItem>
                  {existingSets.map((set) => (
                    <MenuItem key={set.name} value={set.name}>
                      {set.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                size="small"
                fullWidth
                label={t('testComponents.setName')}
                placeholder={t('testComponents.setNamePlaceholder')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                sx={{ flexGrow: 1 }}
              />
              <Stack direction="row" spacing={1} useFlexGap>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  onClick={() => void handleDelete()}
                  disabled={!canDelete}
                  sx={{ minHeight: 40 }}
                >
                  {t('actions.delete')}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => void handleUpdate()}
                  disabled={!canUpdate}
                  sx={{ minHeight: 40 }}
                >
                  {t('actions.update')}
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<SaveIcon />}
                  onClick={() => void handleSave()}
                  disabled={!canSave}
                  sx={{ minHeight: 40 }}
                >
                  {t('actions.save')}
                </Button>
              </Stack>
            </Stack>

            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              maxRows={4}
              placeholder={t('testComponents.selectionPlaceholder')}
              value={componentValue}
              onChange={(event) => setComponentValue(event.target.value)}
            />

            {saveError && <Alert severity="error">{saveError}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" variant="outlined" onClick={onClose} sx={{ minHeight: 40 }} disabled={busy}>
          {t('actions.close')}
        </Button>
        <Button
          size="small"
          variant="contained"
          startIcon={<PlayArrowIcon />}
          onClick={handleLoad}
          disabled={busy || selectedResultNames.length === 0}
          sx={{ minHeight: 40 }}
        >
          {t('testComponents.loadToResultName')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
