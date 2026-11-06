import { sql, type SQLWrapper } from 'drizzle-orm'
import type { TaskSource } from '../../contracts'

export function taskSourceSql(taskId: SQLWrapper, conversationId: SQLWrapper) {
  return sql<TaskSource>`CASE
    WHEN EXISTS (SELECT 1 FROM cli_jobs WHERE cli_jobs.task_id = ${taskId}) THEN 'cli'
    WHEN ${conversationId} IS NOT NULL THEN 'chat'
    ELSE 'manual'
  END`
}
