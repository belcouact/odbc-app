/**
 * Cell value formatting per the app's data rule:
 * - numeric with |value| < 1  -> percentage string (0.05 -> "5%", 0.0567 -> "5.67%")
 * - numeric with |value| >= 1 -> thousand separators, no unit (10000 -> "10,000"),
 *   decimals kept up to 4 places with trailing zeros trimmed
 * - null / undefined -> ""
 * - dates -> locale string
 * - booleans -> "Yes" / "No"
 * - everything else -> String(value)
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return ''

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    if (Math.abs(value) < 1) {
      // 0.05 * 100 = 5.000000000000001 in some engines -> round before trimming zeros.
      const pct = Number.parseFloat((value * 100).toFixed(6))
      return `${pct}%`
    }
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
