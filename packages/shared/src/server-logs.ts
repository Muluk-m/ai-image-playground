export const SERVER_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type ServerLogLevel = (typeof SERVER_LOG_LEVELS)[number]
/** Every container of a deployment that forwards its stdout/stderr (docs/deploy/server-logs.md). */
export const SERVER_LOG_SERVICES = [
  'bff',
  'worker',
  'admin',
  'router',
  'cloudflared',
  'host-collector',
  'pg-backup',
  'migrate',
  'web',
  'other',
] as const
export type ServerLogService = (typeof SERVER_LOG_SERVICES)[number]

export interface ServerLogEntry {
  id: string
  at: number
  service: ServerLogService
  instance: string
  version: string
  level: ServerLogLevel
  event: string | null
  group_key: string
  message: string
  request_id: string | null
  task_id: string | null
  fields: Record<string, unknown>
}

export interface ServerLogFilters {
  from: number
  to: number
  deployment?: 'paid' | 'internal' | 'test'
  stream?: 'stdout' | 'stderr'
  service?: ServerLogService
  level?: ServerLogLevel
  q?: string
  requestId?: string
  taskId?: string
  userId?: string
  mediaId?: string
  instance?: string
  version?: string
  group?: string
}

export interface ServerLogGroup {
  service: ServerLogService
  level: ServerLogLevel
  key: string
  count: number
  first_at: number
  last_at: number
}

export interface ServerLogPage {
  entries: ServerLogEntry[]
  nextCursor: string | null
}

export interface ServerLogsResult extends ServerLogPage {
  coverage?: { first_at: number | null; last_at: number | null }
  levelCounts?: Partial<Record<ServerLogLevel, number>>
  summary: { total: number; errors: number; warnings: number }
  groups: ServerLogGroup[]
  trend: Array<{ at: number; count: number; errors: number; warnings?: number }>
  bucket_ms: number
  collectors: Array<{
    service: ServerLogService
    instance: string
    last_seen_at: number
    pending: number
    dropped: number
    failures: number
    last_written_at: number | null
  }>
}
