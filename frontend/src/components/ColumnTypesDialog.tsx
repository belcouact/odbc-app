import Box from '@mui/material/Box'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import type { QueryResult } from '../types'
import {
  COLUMN_KIND_OPTIONS,
  detectColumnKind,
  type ColumnKind,
} from '../utils/columns'

interface ColumnTypesPanelProps {
  columns: QueryResult['columns']
  rows: QueryResult['rows']
  /** User-chosen kinds keyed by column name (overrides auto-detection). */
  kinds: Record<string, ColumnKind>
  onKindChange: (name: string, kind: ColumnKind) => void
}

/** Compact per-column kind select (small font, square corners). */
const kindSelectSx = {
  width: 104,
  fontSize: '0.8125rem',
  borderRadius: 1,
  bgcolor: 'background.paper',
  flexShrink: 0,
  '& .MuiSelect-select': { py: 0.625 },
  '& .MuiSvgIcon-root': { fontSize: '1rem' },
} as const

/**
 * Review / override how each result column is treated (Number / Text /
 * Boolean / Date) — affecting numeric sorting, filters and cell formatting.
 * Rendered as the "Data types" tab of GridToolsDialog.
 */
export default function ColumnTypesPanel({
  columns,
  rows,
  kinds,
  onKindChange,
}: ColumnTypesPanelProps) {
  const { t } = useTranslation('dialogs')
  return (
    <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
        {t('columnTypes.intro')}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 0.75,
        }}
      >
        {columns.map((column) => {
          const inferred = detectColumnKind(column.name, column.type, rows)
          const overridden = kinds[column.name] !== undefined
          const current = kinds[column.name] ?? inferred
          return (
            <Box
              key={column.name}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                minWidth: 0,
                pl: 1.25,
                pr: 0.75,
                py: 0.5,
                minHeight: 48,
                bgcolor: 'action.hover',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
              }}
            >
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Typography
                  noWrap
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.8125rem',
                    lineHeight: 1.3,
                  }}
                >
                  {column.name}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ display: 'block', lineHeight: 1.2 }}
                >
                  {column.type || t('columnTypes.unknownType')} ·{' '}
                  {overridden ? t('columnTypes.custom') : t('columnTypes.auto')}
                </Typography>
              </Box>
              <Select
                size="small"
                value={current}
                onChange={(event) => onKindChange(column.name, event.target.value as ColumnKind)}
                sx={kindSelectSx}
              >
                {COLUMN_KIND_OPTIONS.map((option) => (
                  <MenuItem
                    key={option.value}
                    value={option.value}
                    sx={{ fontSize: '0.8125rem' }}
                  >
                    {t(`columnTypes.kinds.${option.value}`)}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          )
        })}
      </Box>
      {columns.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {t('columnTypes.empty')}
        </Typography>
      )}
    </Box>
  )
}
