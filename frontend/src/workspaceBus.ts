/**
 * Shared snapshot of the Query workspace state.
 *
 * All pages stay mounted, so the Analyze tab can read the current builder
 * query / custom SQL directly from here instead of duplicating that state.
 */

import type { QueryDef } from './types'

export interface WorkspaceSnapshot {
  connectionId: string
  /** Current builder query definition, or null when incomplete. */
  builderQuery: QueryDef | null
  /** Current raw SQL text (may be empty). */
  sqlText: string
  /** Currently selected table name in the builder ('' when none). */
  table: string
  /** Column names of the last query result loaded in the grid (empty when none). */
  columns: string[]
  /** Column types keyed by name (DB type or canonical kind strings) — lets the
   *  chart builders honor grid type edits without re-sampling rows. */
  columnTypes: Record<string, string>
  /** Rows currently loaded in the grid (empty when none). */
  rows: Record<string, unknown>[]
}

let current: WorkspaceSnapshot = {
  connectionId: '',
  builderQuery: null,
  sqlText: '',
  table: '',
  columns: [],
  columnTypes: {},
  rows: [],
}

/** Publish the latest workspace state (called by the Query page). */
export function publishWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
  current = snapshot
}

/** Read the latest workspace state (called by the Analyze page). */
export function getWorkspaceSnapshot(): WorkspaceSnapshot {
  return current
}
