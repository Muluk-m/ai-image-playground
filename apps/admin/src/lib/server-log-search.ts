import { SERVER_LOG_LEVELS, type ServerLogFilters } from '@image-playground/shared'

export const LOG_RANGES = { '15m': 900_000, '1h': 3600_000, '24h': 86400_000, '7d': 604800_000 }
export const LOG_FILTER_KEYS = [
  'service',
  'level',
  'q',
  'requestId',
  'taskId',
  'userId',
  'mediaId',
  'instance',
  'version',
  'group',
] as const
export type ServerLogSearch = Partial<ServerLogFilters> & { range?: keyof typeof LOG_RANGES }

export function parseServerLogSearch(input: Record<string, unknown>): ServerLogSearch {
  const out: ServerLogSearch = {}
  if (
    typeof input.range === 'string' &&
    Object.prototype.hasOwnProperty.call(LOG_RANGES, input.range)
  )
    out.range = input.range as keyof typeof LOG_RANGES
  if (input.service === 'bff' || input.service === 'worker') out.service = input.service
  if (SERVER_LOG_LEVELS.some((level) => level === input.level))
    out.level = input.level as ServerLogFilters['level']
  for (const key of LOG_FILTER_KEYS) {
    if (key === 'service' || key === 'level') continue
    const value = input[key]
    if (typeof value !== 'string') continue
    const text = key === 'q' ? value.trim() : value
    if (text) out[key] = text.slice(0, 400)
  }
  const from = input.from === undefined ? NaN : Number(input.from)
  const to = input.to === undefined ? NaN : Number(input.to)
  if (
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    to > from &&
    to - from <= LOG_RANGES['7d'] &&
    to <= Date.now() + 60_000
  ) {
    out.from = from
    out.to = to
  }
  return out
}

export function serverLogFilters(search: ServerLogSearch): Partial<ServerLogFilters> {
  return Object.fromEntries(
    LOG_FILTER_KEYS.filter((key) => search[key]).map((key) => [key, search[key]]),
  )
}
