export const SERVER_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type ServerLogLevel = (typeof SERVER_LOG_LEVELS)[number]
export type ServerLogService = 'bff' | 'worker'

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
  service?: ServerLogService
  level?: ServerLogLevel
  q?: string
  requestId?: string
  taskId?: string
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
  summary: { total: number; errors: number; warnings: number }
  groups: ServerLogGroup[]
  trend: Array<{ at: number; count: number; errors: number }>
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
