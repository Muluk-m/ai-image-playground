import {
  generationTasksCsv,
  exportGenerationTasks as readExportGenerationTasks,
  getGenerationOverview as readGenerationOverview,
  getGenerationTasks as readGenerationTasks,
  getGenerationUsers as readGenerationUsers,
  getOverviewActivity as readOverviewActivity,
  getTodayOverview as readTodayOverview,
  TaskQueryError,
} from '@image-playground/read-models'
import { sql } from 'drizzle-orm'
import type {
  GenerationTaskFilters,
  GenerationTaskItem,
  GenerationTasksResult,
  GenerationUsersOverview,
  OverviewActivityResult,
  TimeWindow,
  TodayOverviewResult,
} from '../../contracts'
import { getDbHandle } from './db'
import { serverLogSource, serverLogsCte } from './server-log-source'
import { effectiveLogLevel } from './server-logs'

type Row = Record<string, unknown>
const epoch = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value))
const nullableText = (value: unknown) => (value == null ? null : String(value))

export { generationTasksCsv, TaskQueryError }

export function getTodayOverview(now = Date.now()): Promise<TodayOverviewResult> {
  return readTodayOverview(getDbHandle(), now)
}

export function getGenerationOverview(window: TimeWindow): Promise<TodayOverviewResult> {
  return readGenerationOverview(getDbHandle(), window)
}

export function getGenerationUsers(window: TimeWindow): Promise<GenerationUsersOverview> {
  return readGenerationUsers(getDbHandle(), window)
}

async function readOverviewServerErrors(
  window: TimeWindow,
): Promise<OverviewActivityResult['server']> {
  const from = new Date(window.from)
  const to = new Date(window.to)
  const { db } = getDbHandle()
  // 这里只列最新几条错误和总数，用不上隧道与原因行。
  const { rows: logs, availability } = await serverLogSource().logs(window.from, window.to, {
    errorsOnly: true,
  })
  const serverRows = (await db.execute(sql`
    WITH ${serverLogsCte(logs)}
    SELECT id, at, service, message, task_id, request_id, instance,
      COALESCE(fields->>'stack', fields->'err'->>'stack') AS stack,
      COUNT(*) OVER() AS total
    FROM server_logs
    WHERE at >= ${from} AND at <= ${to}
      AND ${effectiveLogLevel} IN ('error', 'fatal')
    ORDER BY at DESC, id DESC LIMIT 5
  `)) as unknown as Row[]
  return {
    availability,
    total: Number(serverRows[0]?.total ?? 0),
    entries: serverRows.map((row) => ({
      id: String(row.id),
      at: epoch(row.at),
      message: String(row.message),
      stack: nullableText(row.stack),
      service: String(row.service),
      task_id: nullableText(row.task_id),
      request_id: nullableText(row.request_id),
      instance: nullableText(row.instance),
    })),
  }
}

export function getOverviewActivity(window: TimeWindow): Promise<OverviewActivityResult> {
  return readOverviewActivity(getDbHandle(), window, {
    readServerErrors: readOverviewServerErrors,
  })
}

export function getGenerationTasks(
  filters: GenerationTaskFilters,
  cursor?: string,
): Promise<GenerationTasksResult> {
  return readGenerationTasks(getDbHandle(), filters, cursor)
}

export function exportGenerationTasks(filters: GenerationTaskFilters): Promise<{
  window: TimeWindow
  tasks: GenerationTaskItem[]
  truncated: boolean
}> {
  return readExportGenerationTasks(getDbHandle(), filters)
}
