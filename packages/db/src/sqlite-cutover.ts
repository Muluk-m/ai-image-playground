import { Database } from 'bun:sqlite'
import { chmodSync, writeFileSync } from 'node:fs'

export interface SqliteCutoverResult {
  backupPath: string
  totalTasks: number
  unfinishedTasks: number
}

/**
 * Verifies that a stopped legacy deployment has no unfinished work, then serializes a
 * consistent read-only SQLite backup. PostgreSQL starts empty by design; no rows are imported.
 */
export function prepareSqliteCutover(sqlitePath: string, backupPath: string): SqliteCutoverResult {
  const source = new Database(sqlitePath, { readonly: true, strict: true })
  try {
    const counts = source
      .query<{ total_tasks: number; unfinished_tasks: number }, []>(`
        SELECT
          COUNT(*) AS total_tasks,
          COUNT(*) FILTER (WHERE status IN ('queued', 'in_progress')) AS unfinished_tasks
        FROM tasks
      `)
      .get()
    const totalTasks = Number(counts?.total_tasks ?? 0)
    const unfinishedTasks = Number(counts?.unfinished_tasks ?? 0)
    if (unfinishedTasks > 0) {
      throw new Error(
        `SQLite cutover blocked by ${unfinishedTasks} unfinished task${unfinishedTasks === 1 ? '' : 's'}`,
      )
    }

    writeFileSync(backupPath, source.serialize(), { flag: 'wx', mode: 0o400 })
    chmodSync(backupPath, 0o400)
    return { backupPath, totalTasks, unfinishedTasks }
  } finally {
    source.close()
  }
}
