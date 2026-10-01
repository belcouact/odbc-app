/**
 * Cross-page event bus used to push content into the Query workspace.
 * Pre-defined pages emit these actions; the workspace subscribes and reacts.
 */
import type { EChartsOption } from 'echarts'
import type { GridDrillFilter } from './types'

export type EditorAction =
  | { type: 'load-builder'; query: Record<string, unknown>; connectionId?: string }
  | { type: 'load-sql'; sql: string; connectionId?: string }
  | {
      type: 'load-script'
      script: {
        language: string
        script: string
        connection_id?: string | null
        query?: Record<string, unknown> | null
        sql?: string | null
      }
      /** Preferred data source for the script editor; falls back to query/sql/none. */
      source?: 'builder' | 'sql' | 'none'
    }
  | { type: 'request-run' }
  /** Apply an AI-generated ECharts option to a page's Chart tab. */
  | { type: 'apply-chart'; option: EChartsOption; /** Destination page; defaults to the Analyze page. */ target?: 'script' | 'bi' }
  /** Bring the Analyze page to a specific tab (Chart / Script / Summary). */
  | { type: 'show-analyze-tab'; tab: 'chart' | 'script' | 'summary' }
  /** Apply drill-through filters (empty array clears them) to the Query grid. */
  | { type: 'drill-grid'; filters: GridDrillFilter[] }

type Listener = (action: EditorAction) => void

const listeners = new Set<Listener>()

/** Subscribe to editor actions. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Publish an editor action to all subscribers. */
export function emit(action: EditorAction): void {
  listeners.forEach((listener) => {
    try {
      listener(action)
    } catch (error) {
      console.error('editorBus listener failed:', error)
    }
  })
}
