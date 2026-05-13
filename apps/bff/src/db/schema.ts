import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import type { TaskStatus, QueueProvider, SubmitRequest } from '@image-playground/shared'

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  provider: text('provider').$type<QueueProvider>().notNull(),
  model: text('model').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  request_payload: text('request_payload', { mode: 'json' }).$type<SubmitRequest>().notNull(),
  result_payload: text('result_payload', { mode: 'json' }),
  error_message: text('error_message'),
  error_type: text('error_type'),
  submitted_at: integer('submitted_at').notNull(),
  started_at: integer('started_at'),
  completed_at: integer('completed_at'),
  /** 客户端幂等键。NULL 表示老任务或客户端没传；前端新提交一律会带。 */
  client_request_id: text('client_request_id'),
})

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
