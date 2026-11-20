/**
 * `scripts/obs.ts` 的查询拼装与输出格式（ADR 0033）。只做纯函数：SQL 怎么拼、结果怎么排版，
 * 网络请求留在 CLI 里。
 *
 * OpenObserve 里的字段名都是小写、点换成下划线：日志的 `taskId` 存成 `taskid`，span 属性
 * `task.id` 存成 `task_id`，`upstream.model` 存成 `upstream_model`。
 */

/** 日志流和 trace 流的名字：Collector 的 `stream-name` 头。 */
export const OBS_STREAM = 'app'

const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const
export type ObsLevel = keyof typeof SEVERITY

export function isObsLevel(value: string): value is ObsLevel {
  return value in SEVERITY
}

/** `15m`、`2h`、`7d` → 毫秒。 */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim())
  if (!match) throw new Error(`时长写成 15m、2h、7d 这样：${value}`)
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ]
  return Number(match[1]) * unit
}

/** SQL 字符串字面量：单引号加倍。只经只读代理执行，转义是为了查询本身不被参数打断。 */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export interface LogFilter {
  readonly taskId?: string
  readonly traceId?: string
  readonly service?: string
  readonly level?: ObsLevel
  readonly grep?: string
  readonly limit: number
}

export function logsSql(filter: LogFilter): string {
  const where: string[] = []
  if (filter.taskId) where.push(`taskid = ${sqlString(filter.taskId)}`)
  if (filter.traceId) where.push(`trace_id = ${sqlString(filter.traceId)}`)
  if (filter.service) where.push(`service = ${sqlString(filter.service)}`)
  if (filter.level) where.push(`severity_number >= ${SEVERITY[filter.level]}`)
  if (filter.grep) where.push(`str_match_ignore_case(body, ${sqlString(filter.grep)})`)
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  return `SELECT * FROM "${OBS_STREAM}"${clause} ORDER BY _timestamp DESC LIMIT ${filter.limit}`
}

export function traceSql(traceId: string): string {
  return `SELECT * FROM "${OBS_STREAM}" WHERE trace_id = ${sqlString(traceId)} ORDER BY start_time`
}

export function taskSpansSql(taskId: string): string {
  return `SELECT trace_id, MIN(start_time) AS started FROM "${OBS_STREAM}" WHERE task_id = ${sqlString(taskId)} GROUP BY trace_id ORDER BY started`
}

type Hit = Record<string, unknown>

/** 日志字段里排版时单独显示、不再列进「其余字段」的那些。 */
const LOG_SHOWN = new Set([
  '_timestamp',
  'body',
  'severity',
  'severity_number',
  'service',
  'event',
  'taskid',
  'trace_id',
  'span_id',
  'container_id',
  'container_name',
  'fluent_tag',
  'source',
  'dropped_attributes_count',
  'deployment_environment_name',
  'flags',
  'time',
])

/** 一条日志一行：北京时间、级别、服务、事件、消息，再跟上其余字段。 */
export function formatLog(hit: Hit, zone = 'Asia/Shanghai'): string {
  const at = formatTime(Number(hit._timestamp) / 1_000, zone)
  const level = String(hit.severity ?? '').padEnd(5)
  const service = String(hit.service ?? '-')
  const event = hit.event ? ` ${hit.event}` : ''
  const extras = Object.entries(hit)
    .filter(([key, value]) => !LOG_SHOWN.has(key) && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  const ids = [
    hit.taskid ? `task=${hit.taskid}` : '',
    hit.trace_id ? `trace=${hit.trace_id}` : '',
  ].filter(Boolean)
  return [
    `${at} ${level} ${service}${event}  ${hit.body ?? ''}`,
    ...[...ids, ...extras].map((x) => `    ${x}`),
  ].join('\n')
}

/** span 里排版时值得一眼看到的属性。 */
const SPAN_ATTRIBUTES = [
  'task_id',
  'task_outcome',
  'task_attempt',
  'upstream_model',
  'upstream_outcome',
  'http_response_status_code',
  'upstream_headers_ms',
  'http_route',
  'object_store_operation',
  'object_store_bytes',
  'outcome',
]

interface SpanNode {
  readonly hit: Hit
  readonly children: SpanNode[]
}

/**
 * 一条 trace 排成缩进树：相对根 span 的起点偏移、耗时、名字、状态和关键属性；span 上的事件
 * （Vertex 退避之类）列在下面。父 span 不在结果里的（别的进程、被采样掉）当根处理。
 */
export function formatTrace(spans: readonly Hit[]): string {
  if (spans.length === 0) return '（没有 span）'
  const byId = new Map<string, SpanNode>()
  for (const hit of spans) byId.set(String(hit.span_id), { hit, children: [] })
  const roots: SpanNode[] = []
  for (const node of byId.values()) {
    const parent = byId.get(String(node.hit.reference_parent_span_id ?? ''))
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const start = (hit: Hit) => Number(hit.start_time)
  const origin = Math.min(...spans.map(start))
  const lines: string[] = []
  const walk = (node: SpanNode, depth: number) => {
    const { hit } = node
    const offset = ((start(hit) - origin) / 1e6).toFixed(0).padStart(7)
    const duration = (Number(hit.duration) / 1_000).toFixed(0).padStart(7)
    const status = hit.span_status === 'ERROR' ? ' ✗' : ''
    const attributes = SPAN_ATTRIBUTES.filter((key) => hit[key] !== undefined && hit[key] !== null)
      .map((key) => `${key}=${hit[key]}`)
      .join(' ')
    lines.push(
      `+${offset}ms ${duration}ms ${'  '.repeat(depth)}${hit.service_name ?? ''} ${hit.operation_name}${status}${attributes ? `  ${attributes}` : ''}`,
    )
    if (hit.status_message)
      lines.push(`${' '.repeat(20)}${'  '.repeat(depth)}  ! ${hit.status_message}`)
    for (const event of parseEvents(hit.events))
      lines.push(`${' '.repeat(20)}${'  '.repeat(depth)}  · ${event}`)
    for (const child of node.children.sort((a, b) => start(a.hit) - start(b.hit)))
      walk(child, depth + 1)
  }
  for (const root of roots.sort((a, b) => start(a.hit) - start(b.hit))) walk(root, 0)
  return lines.join('\n')
}

/** OpenObserve 把 span 事件存成 JSON 字符串。 */
function parseEvents(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '[]') return []
  try {
    const events = JSON.parse(raw) as Array<Record<string, unknown>>
    return events.map((event) => {
      const { name, _timestamp: _ignored, ...rest } = event
      const fields = Object.entries(rest)
        .map(
          ([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join(' ')
      return `${name ?? 'event'}${fields ? ` ${fields}` : ''}`
    })
  } catch {
    return []
  }
}

function formatTime(epochMs: number, zone: string): string {
  const date = new Date(epochMs)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}.${ms}`
}
