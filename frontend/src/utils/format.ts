/**
 * Cell value formatting per the app's data rule:
 * - any numeric -> thousand separators, no unit (10000 -> "10,000", 0.05 -> "0.05"),
 *   decimals kept up to 4 places with trailing zeros trimmed
 * - null / undefined -> ""
 * - dates -> locale string
 * - booleans -> "Yes" / "No"
 * - everything else -> String(value)
 *
 * Numbers are never rewritten as percentages: a small value like 0.05 is shown
 * as-is rather than "5%".
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return ''

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No'

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toLocaleString()
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    // Date-only string -> parse as local time to avoid the UTC shift, then locale-date.
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('-').map(Number)
      const parsed = new Date(y, m - 1, d)
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleDateString()
    }
    // ISO datetime string -> locale string.
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
      const parsed = new Date(trimmed)
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString()
    }
    return value
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  return String(value)
}
