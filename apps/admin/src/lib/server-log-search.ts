import {
  SERVER_LOG_LEVELS,
  SERVER_LOG_SERVICES,
  type ServerLogFilters,
} from '@image-playground/shared'

export const LOG_RANGES = { '15m': 900_000, '1h': 3600_000, '24h': 86400_000, '7d': 604800_000 }
export const LOG_FILTER_KEYS = [
  'deployment',
  'stream',
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
  if (['paid', 'internal', 'test'].includes(String(input.deployment)))
    out.deployment = input.deployment as ServerLogFilters['deployment']
  if (input.stream === 'stdout' || input.stream === 'stderr') out.stream = input.stream
  if (SERVER_LOG_SERVICES.includes(input.service as never))
    out.service = input.service as ServerLogFilters['service']
  if (SERVER_LOG_LEVELS.some((level) => level === input.level))
    out.level = input.level as ServerLogFilters['level']
  for (const key of LOG_FILTER_KEYS) {
    if (key === 'service' || key === 'level' || key === 'deployment' || key === 'stream') continue
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

/** Recognized field tokens become exact filters; everything else remains literal text. */
export function parseLogExpression(input: string): Partial<ServerLogFilters> {
  const filters: Partial<ServerLogFilters> = {}
  const text: string[] = []
  const aliases: Record<string, string> = { container: 'instance', event: 'group' }
  for (const token of input.matchAll(
    /(\w+):(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))|(\S+)/g,
  )) {
    const key = aliases[token[1] ?? ''] ?? token[1]
    if (!key || !LOG_FILTER_KEYS.includes(key as never)) {
      text.push(token[0])
      continue
    }
    const value =
      token[2] !== undefined
        ? (JSON.parse('\"' + token[2] + '\"') as string)
        : (token[3]?.replace(/\\([\\'"])/g, '$1') ?? token[4] ?? '')
    if (key === 'q') {
      text.push(value)
      continue
    }
    if (!value || value.length > 400) throw new Error('查询字段不能为空或超过 400 个字符')
    if (key === 'service' && !SERVER_LOG_SERVICES.includes(value as never))
      throw new Error('服务名称无效')
    if (key === 'level' && !SERVER_LOG_LEVELS.includes(value as never))
      throw new Error('日志级别无效')
    if (key === 'stream' && value !== 'stdout' && value !== 'stderr')
      throw new Error('输出流须为 stdout 或 stderr')
    if (key === 'deployment' && !['paid', 'internal', 'test'].includes(value))
      throw new Error('部署须为 paid、internal 或 test')
    Object.assign(filters, { [key]: value })
  }
  const q = text.join(' ')
  if (q.length > 400) throw new Error('关键词不能超过 400 个字符')
  filters.q = q || undefined
  return filters
}

export function logTrendSelection(
  from: number,
  to: number,
  first: number,
  last: number,
  bucket: number,
) {
  const range = { from: Math.max(from, first), to: Math.min(to, last + bucket) }
  return range.to > range.from ? range : null
}

export function formatLogExpression(filters: Partial<ServerLogFilters>) {
  const tokens = Object.entries(filters)
    .filter(([key, value]) => key !== 'q' && value !== undefined)
    .map(([key, value]) => `${key}:${JSON.stringify(value)}`)
  if (filters.q) tokens.push(`q:${JSON.stringify(filters.q)}`)
  return tokens.join(' ')
}
