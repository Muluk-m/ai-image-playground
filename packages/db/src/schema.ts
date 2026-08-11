import type {
  QueueProvider,
  SubmitRequest,
  TaskBlobRef,
  TaskStatus,
} from '@image-playground/shared'
import { blob, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

export type StoredSubmitRequest = Omit<SubmitRequest, 'input_images'> & {
  input_images?: Array<string | TaskBlobRef>
}

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  provider: text('provider').$type<QueueProvider>().notNull(),
  model: text('model').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  request_payload: text('request_payload', { mode: 'json' }).$type<StoredSubmitRequest>().notNull(),
  result_payload: text('result_payload', { mode: 'json' }),
  error_message: text('error_message'),
  error_type: text('error_type'),
  submitted_at: integer('submitted_at').notNull(),
  started_at: integer('started_at'),
  completed_at: integer('completed_at'),
  /** 客户端幂等键。NULL 表示老任务或客户端没传；前端新提交一律会带。 */
  client_request_id: text('client_request_id'),
  /**
   * 已尝试次数（含首次）。新任务=0；worker 失败决定重试时在已 in_progress
   * 行上 +1（即将变成第 N 次重试时写 N，然后 status 回退到 'queued'）。
   */
  attempt_count: integer('attempt_count').notNull().default(0),
  /**
   * 下次允许重试的时间戳。仅在 status='queued' 且 attempt_count>0 时有值——
   * 表示这条 queued 是「等待重试」状态而非「初次未起跑」。worker claim 必须
   * `next_retry_at IS NULL OR next_retry_at <= now`，避免未到时被错误启动。
   */
  next_retry_at: integer('next_retry_at'),
})

export const task_blobs = sqliteTable(
  'task_blobs',
  {
    id: text('id').primaryKey(),
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'input' | 'output'>().notNull(),
    idx: integer('idx').notNull(),
    mime: text('mime').notNull(),
    data: blob('data', { mode: 'buffer' }).notNull(),
    created_at: integer('created_at').notNull(),
  },
  (t) => [unique().on(t.task_id, t.kind, t.idx)],
)

export const daily_quota = sqliteTable(
  'daily_quota',
  {
    device_id: text('device_id').notNull(),
    date: text('date').notNull(), // 'YYYY-MM-DD' UTC
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.device_id, t.date] }),
  }),
)

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
export type TaskBlob = typeof task_blobs.$inferSelect
export type NewTaskBlob = typeof task_blobs.$inferInsert
