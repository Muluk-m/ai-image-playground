import type {
  QueueProvider,
  SubmitRequest,
  TaskBlobRef,
  TaskStatus,
} from '@image-playground/shared'
import {
  bigint,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core'

export type StoredSubmitRequest = Omit<SubmitRequest, 'input_images'> & {
  input_images?: Array<string | TaskBlobRef>
}

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  provider: text('provider').$type<QueueProvider>().notNull(),
  model: text('model').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  request_payload: jsonb('request_payload').$type<StoredSubmitRequest>().notNull(),
  result_payload: jsonb('result_payload'),
  error_message: text('error_message'),
  error_type: text('error_type'),
  upstream_status: integer('upstream_status'),
  upstream_body: text('upstream_body'),
  submitted_at: bigint('submitted_at', { mode: 'number' }).notNull(),
  started_at: bigint('started_at', { mode: 'number' }),
  completed_at: bigint('completed_at', { mode: 'number' }),
  client_request_id: text('client_request_id'),
  attempt_count: integer('attempt_count').notNull().default(0),
  next_retry_at: bigint('next_retry_at', { mode: 'number' }),
})

export const task_blobs = pgTable(
  'task_blobs',
  {
    id: text('id').primaryKey(),
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'input' | 'output'>().notNull(),
    idx: integer('idx').notNull(),
    mime: text('mime').notNull(),
    data: bytea('data').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [unique().on(t.task_id, t.kind, t.idx)],
)

export const daily_quota = pgTable(
  'daily_quota',
  {
    device_id: text('device_id').notNull(),
    date: text('date').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.device_id, t.date] }),
  }),
)
