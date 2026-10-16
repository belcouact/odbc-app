import { useCallback, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import CloseIcon from '@mui/icons-material/Close'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import type {
  Schedule,
  ScheduleCreatePayload,
  ScheduleOutput,
  ScheduleSources,
  ScheduleTarget,
  ScheduleTrigger,
  ScheduleTriggerType,
} from '../api/client'

interface ScheduleEditorDialogProps {
  open: boolean
  /** When set the dialog edits this schedule; otherwise it creates a new one. */
  schedule: Schedule | null
  onClose: () => void
  /** Called with the saved schedule so the board can refresh. */
  onSaved: (schedule: Schedule) => void
}

/** Interval units the picker offers, with their length in seconds. */
const INTERVAL_UNITS = [
  { unit: 'seconds', seconds: 1 },
  { unit: 'minutes', seconds: 60 },
  { unit: 'hours', seconds: 3600 },
] as const

type IntervalUnit = (typeof INTERVAL_UNITS)[number]['unit']

/**
 * The two ways a schedule can be pointed at something runnable: a raw SQL
 * statement the user saved, or a script — either an app-published template
 * (resolved by name at run time) or one of the user's own saved scripts.
 */
type RunMode = 'sql_saved' | 'script'

const RUN_MODES: RunMode[] = ['sql_saved', 'script']
/** Namespaced value for the merged template/script picker. */
const TEMPLATE_PREFIX = 'template:'
const SCRIPT_PREFIX = 'script:'

const TRIGGER_TYPES: ScheduleTriggerType[] = ['interval', 'daily', 'weekly', 'monthly']
/** Weekday buttons, Monday-first, matching the backend's 0=Monday convention. */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

function toIntervalParts(seconds: number): { value: number; unit: IntervalUnit } {
  if (seconds % 3600 === 0 && seconds >= 3600) return { value: seconds / 3600, unit: 'hours' }
  if (seconds % 60 === 0 && seconds >= 60) return { value: seconds / 60, unit: 'minutes' }
  return { value: seconds, unit: 'seconds' }
}

function intervalSeconds(value: number, unit: IntervalUnit): number {
  return value * (INTERVAL_UNITS.find((entry) => entry.unit === unit)?.seconds ?? 1)
}

/**
 * Create or edit one schedule. The same dialog serves both modes so a schedule
 * can be edited at any time after it was created. "What to run" is a two-way
 * choice — a saved SQL statement (with an optional connection override) or a
 * script (an app template or one of the user's saved scripts).
 */
export default function ScheduleEditorDialog({
  open,
  schedule,
  onClose,
  onSaved,
}: ScheduleEditorDialogProps) {
  const { t } = useTranslation('schedules')
  const fullScreen = useMediaQuery((theme) => theme.breakpoints.down('sm'))

  const [sources, setSources] = useState<ScheduleSources | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [enabled, setEnabled] = useState(true)

  const [kind, setKind] = useState<RunMode>('sql_saved')
  const [sqlQueryId, setSqlQueryId] = useState('')
  /** Merged picker value: '', 'template:<name>' or 'script:<id>'. */
  const [scriptRef, setScriptRef] = useState('')
  const [connectionId, setConnectionId] = useState('')

  const [triggerType, setTriggerType] = useState<ScheduleTriggerType>('daily')
  const [intervalValue, setIntervalValue] = useState(30)
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('minutes')
  const [atTime, setAtTime] = useState('06:30')
  const [weekdays, setWeekdays] = useState<number[]>([0])
  const [dayOfMonth, setDayOfMonth] = useState(1)

  const [outputMode, setOutputMode] = useState<'none' | 'snapshot'>('none')
  const [snapshotName, setSnapshotName] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isEdit = Boolean(schedule)

  /** Load the pickers and seed the form each time the dialog opens. */
  useEffect(() => {
    if (!open) return
    setError('')
    setSources(null)
    void api
      .scheduleSources()
      .then(setSources)
      .catch(() =>
        setSources({
          connections: [],
          saved_queries: [],
          sql_queries: [],
          scripts: [],
          templates: [],
        }),
      )

    if (schedule) {
      setName(schedule.name)
      setDescription(schedule.description || '')
      setEnabled(schedule.enabled)
      const target = schedule.target
      const isScript = target.kind === 'script' || target.kind === 'script_template'
      setKind(isScript ? 'script' : 'sql_saved')
      setSqlQueryId(target.sql_query_id || '')
      setScriptRef(
        target.kind === 'script_template' && target.template_name
          ? `${TEMPLATE_PREFIX}${target.template_name}`
          : target.kind === 'script' && target.script_id
            ? `${SCRIPT_PREFIX}${target.script_id}`
            : '',
      )
      setConnectionId(target.connection_id || '')
      setTriggerType(schedule.trigger.type)
      const parts = toIntervalParts(schedule.trigger.interval_seconds || 1800)
      setIntervalValue(parts.value)
      setIntervalUnit(parts.unit)
      setAtTime(schedule.trigger.at_time || '06:30')
      setWeekdays(schedule.trigger.weekdays?.length ? schedule.trigger.weekdays : [0])
      setDayOfMonth(schedule.trigger.day_of_month || 1)
      setOutputMode(schedule.output.mode)
      setSnapshotName(schedule.output.snapshot_name || '')
    } else {
      setName('')
      setDescription('')
      setEnabled(true)
      setKind('sql_saved')
      setSqlQueryId('')
      setScriptRef('')
      setConnectionId('')
      setTriggerType('daily')
      setIntervalValue(30)
      setIntervalUnit('minutes')
      setAtTime('06:30')
      setWeekdays([0])
      setDayOfMonth(1)
      setOutputMode('none')
      setSnapshotName('')
    }
  }, [open, schedule])

  const hasAnySource = useMemo(() => {
    if (!sources) return false
    return (
      sources.sql_queries.length > 0 ||
      sources.scripts.length > 0 ||
      (sources.templates?.length ?? 0) > 0
    )
  }, [sources])

  /** App templates first, then the user's saved scripts, as one picker list. */
  const scriptOptions = useMemo(
    () => [
      ...(sources?.templates ?? []).map((item) => ({
        id: `${TEMPLATE_PREFIX}${item.name}`,
        name: `${t('source.template')}: ${item.title}`,
      })),
      ...(sources?.scripts ?? []).map((item) => ({
        id: `${SCRIPT_PREFIX}${item.id}`,
        name: `${t('source.script')}: ${item.name}`,
      })),
    ],
    [sources, t],
  )

  const buildTarget = useCallback((): ScheduleTarget => {
    const isTemplate = scriptRef.startsWith(TEMPLATE_PREFIX)
    const isScript = scriptRef.startsWith(SCRIPT_PREFIX)
    return {
      kind: isTemplate ? 'script_template' : isScript ? 'script' : 'sql_saved',
      query_id: null,
      sql: null,
      sql_query_id: kind === 'sql_saved' ? sqlQueryId || null : null,
      script_id: isScript ? scriptRef.slice(SCRIPT_PREFIX.length) : null,
      template_name: isTemplate ? scriptRef.slice(TEMPLATE_PREFIX.length) : null,
      // The connection is an override for the saved SQL; scripts use the default.
      connection_id: kind === 'sql_saved' ? connectionId || null : null,
      timeout_seconds: 600,
    }
  }, [kind, sqlQueryId, scriptRef, connectionId])

  const buildTrigger = useCallback((): ScheduleTrigger => {
    const trigger: ScheduleTrigger = {
      type: triggerType,
      interval_seconds: null,
      at_time: null,
      weekdays: null,
      day_of_month: null,
      timezone: 'local',
    }
    if (triggerType === 'interval') {
      trigger.interval_seconds = intervalSeconds(intervalValue, intervalUnit)
    } else {
      trigger.at_time = atTime
      if (triggerType === 'weekly') trigger.weekdays = weekdays
      if (triggerType === 'monthly') trigger.day_of_month = dayOfMonth
    }
    return trigger
  }, [triggerType, intervalValue, intervalUnit, atTime, weekdays, dayOfMonth])

  const validationError = useMemo(() => {
    if (!name.trim()) return 'nameRequired'
    if (kind === 'sql_saved' && !sqlQueryId) return 'sourceRequired'
    if (kind === 'script' && !scriptRef) return 'sourceRequired'
    if (triggerType === 'interval' && intervalSeconds(intervalValue, intervalUnit) < 30)
      return 'trigger.invalidInterval'
    if (triggerType !== 'interval' && !/^\d{2}:\d{2}$/.test(atTime)) return 'trigger.invalidTime'
    if (triggerType === 'weekly' && weekdays.length === 0) return 'sourceRequired'
    return ''
  }, [name, kind, sqlQueryId, scriptRef, triggerType, intervalValue, intervalUnit, atTime, weekdays])

  const handleSave = useCallback(async () => {
    if (validationError) {
      setError(t(validationError))
      return
    }
    setSaving(true)
    setError('')
    const output: ScheduleOutput = {
      mode: outputMode,
      snapshot_name: outputMode === 'snapshot' ? snapshotName.trim() || null : null,
      row_cap: schedule?.output.row_cap ?? 5000,
    }
    const payload: ScheduleCreatePayload = {
      name: name.trim(),
      description: description.trim(),
      enabled,
      target: buildTarget(),
      trigger: buildTrigger(),
      output,
    }
    try {
      const saved = schedule
        ? await api.updateSchedule(schedule.id, payload)
        : await api.createSchedule(payload)
      onSaved(saved)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [
    validationError,
    t,
    name,
    description,
    enabled,
    outputMode,
    snapshotName,
    schedule,
    buildTarget,
    buildTrigger,
    onSaved,
    onClose,
  ])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      aria-label={isEdit ? t('editSchedule') : t('newSchedule')}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Box sx={{ flexGrow: 1, fontWeight: 700 }}>
          {isEdit ? t('editSchedule') : t('newSchedule')}
        </Box>
        <IconButton aria-label={t('cancel')} onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        {!hasAnySource && !sources && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={22} />
          </Box>
        )}

        <TextField
          label={t('title')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          size="small"
          fullWidth
          required
          autoFocus
        />
        <TextField
          label={t('description')}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          size="small"
          fullWidth
          multiline
          minRows={1}
        />

        <Divider textAlign="left">
          <Typography variant="caption" color="text.secondary">
            {t('source.label')}
          </Typography>
        </Divider>

        <ToggleButtonGroup
          exclusive
          size="small"
          value={kind}
          onChange={(_event, next: RunMode | null) => next && setKind(next)}
          sx={{ flexWrap: 'wrap', gap: 0.5, '& .MuiToggleButton-root': { minHeight: 40, textTransform: 'none' } }}
        >
          {RUN_MODES.map((value) => (
            <ToggleButton key={value} value={value}>
              {value === 'sql_saved' ? t('source.sqlSaved') : t('source.templateOrScript')}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {kind === 'sql_saved' && (
          <>
            <SourcePicker
              label={t('source.pickSqlSaved')}
              value={sqlQueryId}
              options={sources?.sql_queries ?? []}
              emptyLabel={t('source.noOptions')}
              onChange={setSqlQueryId}
            />
            <SourcePicker
              label={t('source.connection')}
              value={connectionId}
              options={sources?.connections ?? []}
              emptyLabel={t('source.noOptions')}
              onChange={setConnectionId}
              allowEmpty
              emptyOptionLabel={t('source.useDefaultConnection')}
            />
          </>
        )}
        {kind === 'script' && (
          <SourcePicker
            label={t('source.pickTemplateOrScript')}
            value={scriptRef}
            options={scriptOptions}
            emptyLabel={t('source.noOptions')}
            onChange={setScriptRef}
          />
        )}

        <Divider textAlign="left">
          <Typography variant="caption" color="text.secondary">
            {t('trigger.label')}
          </Typography>
        </Divider>

        <ToggleButtonGroup
          exclusive
          size="small"
          value={triggerType}
          onChange={(_event, next: ScheduleTriggerType | null) => next && setTriggerType(next)}
          sx={{ flexWrap: 'wrap', gap: 0.5, '& .MuiToggleButton-root': { minHeight: 40, textTransform: 'none' } }}
        >
          {TRIGGER_TYPES.map((value) => (
            <ToggleButton key={value} value={value}>
              {t(`trigger.${value}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {triggerType === 'interval' && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="body2">{t('trigger.intervalEvery')}</Typography>
            <TextField
              type="number"
              size="small"
              value={intervalValue}
              onChange={(event) => setIntervalValue(Math.max(1, Number(event.target.value) || 1))}
              sx={{ width: 110 }}
              slotProps={{ htmlInput: { min: 1 } }}
            />
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <Select
                value={intervalUnit}
                onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}
              >
                {INTERVAL_UNITS.map((entry) => (
                  <MenuItem key={entry.unit} value={entry.unit}>
                    {t(`trigger.${entry.unit}`)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        )}

        {triggerType !== 'interval' && (
          <TextField
            label={t('trigger.atTime')}
            type="time"
            size="small"
            value={atTime}
            onChange={(event) => setAtTime(event.target.value)}
            sx={{ maxWidth: 180 }}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}

        {triggerType === 'weekly' && (
          <Box>
            <ToggleButtonGroup
              size="small"
              value={weekdays}
              onChange={(_event, next: number[]) => setWeekdays(next)}
              sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}
            >
              {WEEKDAYS.map((day) => (
                <ToggleButton key={day} value={day} sx={{ minWidth: 52, minHeight: 44 }}>
                  {t(`dow.${day}`)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
        )}

        {triggerType === 'monthly' && (
          <TextField
            label={t('trigger.dayOfMonth')}
            type="number"
            size="small"
            value={dayOfMonth}
            onChange={(event) =>
              setDayOfMonth(Math.min(31, Math.max(1, Number(event.target.value) || 1)))
            }
            sx={{ maxWidth: 180 }}
            slotProps={{ htmlInput: { min: 1, max: 31 } }}
          />
        )}

        {kind !== 'script' && (
          <>
            <Divider textAlign="left">
              <Typography variant="caption" color="text.secondary">
                {t('output.label')}
              </Typography>
            </Divider>
            <FormControlLabel
              control={
                <Checkbox
                  checked={outputMode === 'snapshot'}
                  onChange={(event) => setOutputMode(event.target.checked ? 'snapshot' : 'none')}
                />
              }
              label={t('output.snapshot')}
            />
            <Typography variant="caption" color="text.secondary">
              {outputMode === 'none' ? t('output.noneHint') : t('output.snapshotNameHint')}
            </Typography>
            {outputMode === 'snapshot' && (
              <TextField
                label={t('output.snapshotName')}
                size="small"
                value={snapshotName}
                onChange={(event) => setSnapshotName(event.target.value)}
                fullWidth
              />
            )}
          </>
        )}

        <FormControlLabel
          control={<Switch checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />}
          label={enabled ? t('enabled') : t('disabled')}
        />
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving} sx={{ minHeight: 44 }}>
          {t('cancel')}
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={saving || Boolean(validationError)}
          sx={{ minHeight: 44 }}
        >
          {saving ? <CircularProgress size={18} color="inherit" /> : isEdit ? t('save') : t('create')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** A labelled Select over one source list, tolerant of an empty list. */
function SourcePicker({
  label,
  value,
  options,
  emptyLabel,
  onChange,
  allowEmpty = false,
  emptyOptionLabel,
}: {
  label: string
  value: string
  options: { id: string; name: string }[]
  emptyLabel: string
  onChange: (value: string) => void
  allowEmpty?: boolean
  emptyOptionLabel?: string
}) {
  return (
    <FormControl size="small" fullWidth>
      {/* The label must float whenever the field already shows text — with
          displayEmpty that is always, and with a picked value it is from the
          first selection on. Leaving it unset otherwise keeps MUI's automatic
          float-on-focus for the empty field; passing an explicit `false`
          (as `shrink={allowEmpty}` did) freezes the label in place and draws
          it over the selected value. */}
      <InputLabel shrink={allowEmpty || Boolean(value) || undefined}>{label}</InputLabel>
      <Select
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        displayEmpty={allowEmpty}
        sx={{ minHeight: 44 }}
      >
        {allowEmpty && <MenuItem value="">{emptyOptionLabel}</MenuItem>}
        {options.length === 0 && (
          <MenuItem value="" disabled>
            {emptyLabel}
          </MenuItem>
        )}
        {options.map((option) => (
          <MenuItem key={option.id} value={option.id}>
            {option.name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}
