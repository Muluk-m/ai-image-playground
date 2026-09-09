export interface MatteFailureLog {
  /** 试的是哪一环：服务端、浏览器回落链上的某个后端。 */
  backend: string
  reason: string
  elapsedMs: number
  /** 只有占比判定这一路有。 */
  coverage?: number
  error?: unknown
}

const MAX_MESSAGE = 200

/** 抠图失败只在控制台留痕：用户报「抠图失败」时，开发者靠 `[matte]` 这个前缀 grep。 */
export function logMatteFailure(log: MatteFailureLog): void {
  const parts = [`backend=${log.backend}`, `reason=${log.reason}`, `elapsed=${log.elapsedMs}ms`]
  if (log.coverage !== undefined) parts.push(`coverage=${log.coverage.toFixed(4)}`)
  const message = scrub(log.error)
  if (message) parts.push(`message=${message}`)
  console.warn(`[matte] ${parts.join(' ')}`)
}

/** 上游报错常把整条 data URL 抄进 message，图不能进日志。 */
function scrub(error: unknown): string {
  if (error === undefined || error === null) return ''
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/data:[^\s'"]*/g, 'data:…').slice(0, MAX_MESSAGE)
}
