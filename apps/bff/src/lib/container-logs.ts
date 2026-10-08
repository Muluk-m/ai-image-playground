import { createHash } from 'node:crypto'
import {
  SERVER_LOG_SERVICES,
  type ServerLogEntry,
  type ServerLogLevel,
  type ServerLogService,
} from '@image-playground/shared'
import { parseServerLog, redactLogText } from './server-log-buffer'

/**
 * One record of the Docker fluentd log driver, as the deployment's Fluent Bit forwards it
 * (deploy/compose.app.yaml, docs/deploy/server-logs.md).
 */
export interface ContainerLogRecord {
  container_id?: unknown
  date?: unknown
  container_name?: unknown
  source?: unknown
  log?: unknown
}

const COMPOSE_SERVICE = new RegExp(
  `-(${[...SERVER_LOG_SERVICES.filter((one) => one !== 'router' && one !== 'other'), 'dependency-check'].join('|')})-\\d+$`,
)

/** Release-managed executors are `<project>-r<release>-<role>`; Compose ones `<project>-<service>-<n>`. */
export function containerService(name: string): ServerLogService {
  const bare = name.replace(/^\//, '')
  if (/-release-router(?:-retiring)?$/.test(bare)) return 'router'
  const role = /-r\d{14}-\d+-(bff|worker|migrate)$/.exec(bare)?.[1]
  if (role) return role as ServerLogService
  const service = COMPOSE_SERVICE.exec(bare)?.[1]
  if (service === 'dependency-check') return 'migrate'
  return (service as ServerLogService | undefined) ?? 'other'
}

/** Text lines carry their level as a word (cloudflared `ERR`, postgres `ERROR:`, `[warn]`). */
function textLevel(line: string, stream: string): ServerLogLevel {
  if (/\b(?:FATAL|PANIC|CRIT(?:ICAL)?)\b/i.test(line)) return 'fatal'
  if (/\b(?:ERR|ERROR|EXCEPTION)\b|^\s*at\s|Error:/i.test(line)) return 'error'
  if (/\b(?:WRN|WARN|WARNING)\b/i.test(line)) return 'warn'
  if (/\b(?:DBG|DEBUG)\b/i.test(line)) return 'debug'
  if (/\b(?:INF|INFO|LOG|NOTICE)\b/i.test(line)) return 'info'
  return stream === 'stderr' ? 'warn' : 'info'
}

export function parseContainerLog(record: unknown): ServerLogEntry | null {
  if (!record || typeof record !== 'object') return null
  const input = record as ContainerLogRecord
  if (typeof input.log !== 'string' || typeof input.container_name !== 'string') return null
  const line = input.log.replace(/\s+$/, '')
  if (!line) return null
  const instance = input.container_name
    .replace(/^\//, '')
    .replace(/\u0000/g, '')
    .slice(0, 200)
  const service = containerService(instance)
  const stream = input.source === 'stderr' ? 'stderr' : 'stdout'
  const seconds = Number(input.date)
  const at = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : Date.now()
  if (!Number.isSafeInteger(at) || at < 0 || at > Date.now() + 60_000) return null
  // The collector can retry after a partially committed batch. Use the driver's original
  // timestamp and container identity rather than application time (often only milliseconds).
  const id = createHash('sha256')
    .update(JSON.stringify([input.container_id ?? instance, input.date, stream, input.log]))
    .digest('hex')
  if (line.startsWith('{')) {
    let version = ''
    try {
      const value = (JSON.parse(line) as { version?: unknown }).version
      if (typeof value === 'string') version = redactLogText(value).slice(0, 200)
    } catch {
      /* Not JSON after all: kept below as text. */
    }
    const entry = parseServerLog(line, { service, instance, version })
    if (entry) return { ...entry, id, at, fields: { ...entry.fields, stream } }
  }
  const message = redactLogText(line)
  return {
    id,
    at,
    service,
    instance,
    version: '',
    level: textLevel(line, stream),
    event: null,
    group_key: message
      .replace(/^\S*\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s*/, '')
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
      .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
      .replace(/(?<![\w.])\d+(?:\.\d+)*/g, '<n>')
      .slice(0, 400),
    message,
    request_id: null,
    task_id: null,
    fields: { stream },
  }
}
