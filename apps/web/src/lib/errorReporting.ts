/**
 * 应用运行期的错误上报：全局未捕获异常、未处理的 Promise、React 根节点上的渲染崩溃，
 * 合批后用 beacon 发给 BFF，运营后台「前端错误」页按指纹聚合查看。
 *
 * 启动阶段（React 还没渲染出任何界面）的失败不归这里：那时应用 bundle 可能根本没跑起来，
 * 由 index.html 的内联启动守卫自己上报，见 boot/vitePlugin.ts。
 *
 * main.tsx 第一时间装监听，此时还不知道 BFF 在哪；先攒着，等运行时配置加载完再决定发往哪里，
 * 纯静态部署（没有 BFF）直接丢弃。
 */
import {
  CLIENT_ERROR_LIMITS,
  CLIENT_ERRORS_PATH,
  type ClientErrorBatch,
  type ClientErrorKind,
  type ClientErrorRecovery,
  type ClientErrorReport,
} from '@image-playground/shared'
import { BUILD_META_NAME } from '../boot/constants'
import { getDeviceId } from './deviceId'

/** 一次页面会话最多报这么多条，出错循环的页面不该一直往外发。 */
const MAX_REPORTS_PER_PAGE = 30
/** 同一条错误（类型 + 消息）一次会话里最多报几次。 */
const MAX_REPEATS = 3
const FLUSH_DELAY_MS = 2000
/**
 * 单个请求的字节上限，留在服务端 64 KiB 与浏览器 keepalive 总配额（64 KiB，含同时在途的请求）之内。
 * 按 UTF-8 字节算：中文内容一个字三字节。
 */
const MAX_BATCH_BYTES = 24 * 1024
/** beacon 发出后无法等它完成；一次 flush 只发这么多，剩下的等下一拍，免得同时在途的超出配额。 */
const MAX_FLUSH_BYTES = 48 * 1024
const encoder = new TextEncoder()

/** 浏览器自己产生、与代码无关的噪声。 */
const IGNORED_MESSAGES = [/ResizeObserver loop/]

let endpoint: string | null | undefined
const pending: ClientErrorReport[] = []
const recoveries: ClientErrorRecovery[] = []
let reportedErrors = new WeakSet<Error>()
const repeats = new Map<string, number>()
let accepted = 0
let flushTimer: ReturnType<typeof setTimeout> | undefined

function clip(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined
}

function errorField(error: unknown, key: string): unknown {
  try {
    return error && typeof error === 'object' ? Reflect.get(error, key) : undefined
  } catch {
    return undefined
  }
}

function describe(error: unknown): Pick<ClientErrorReport, 'name' | 'message' | 'stack'> {
  // DOMException and cross-realm errors need not inherit this realm's Error.
  const message = errorField(error, 'message')
  const name = errorField(error, 'name')
  if (typeof message === 'string') {
    return {
      name: clip(name, CLIENT_ERROR_LIMITS.name),
      message: message || String(name ?? 'Error'),
      stack: clip(errorField(error, 'stack'), CLIENT_ERROR_LIMITS.stack),
    }
  }
  if (error !== null && (typeof error === 'object' || typeof error === 'function'))
    return { message: 'Non-error rejection' }
  return { message: String(error) }
}

/** Only diagnostic fields, bounded and cycle-safe; never serialize arbitrary error objects. */
function errorCauses(error: unknown): Record<string, unknown>[] {
  const causes: Record<string, unknown>[] = []
  const seen = new Set<unknown>([error])
  let current = errorField(error, 'cause')
  while (current !== undefined && !seen.has(current) && causes.length < 4) {
    seen.add(current)
    const detail =
      current && (typeof current === 'object' || typeof current === 'function')
        ? {
            name: clip(errorField(current, 'name'), 200),
            message: clip(errorField(current, 'message'), 1000) ?? 'Non-error cause',
            stack: clip(errorField(current, 'stack'), 1500),
          }
        : describe(current)
    const status = errorField(current, 'status')
    const code = errorField(current, 'code')
    causes.push({
      name: clip(detail.name, 200),
      message: clip(detail.message, 1000),
      stack: clip(detail.stack, 1500),
      ...(typeof status === 'number' ? { status } : {}),
      ...(typeof code === 'string' ? { code: clip(code, 200) } : {}),
    })
    current = errorField(current, 'cause')
  }
  return causes
}

/** Match the server's JSON character limit before queueing, not only the HTTP byte budget. */
function boundedContext(
  context: Record<string, unknown> | undefined,
  causes: Record<string, unknown>[],
  compactOnly = false,
): Record<string, unknown> | undefined {
  if (!context && !causes.length) return undefined
  const fits = (candidate: Record<string, unknown>) => {
    try {
      return JSON.stringify(candidate).length <= CLIENT_ERROR_LIMITS.context
    } catch {
      return false
    }
  }
  try {
    if (!compactOnly) {
      const full = causes.length ? { ...context, causes } : { ...context }
      if (fits(full)) return full
      const withoutStacks = causes.map(({ stack: _stack, ...cause }) => cause)
      const compact = { ...context, ...(causes.length ? { causes: withoutStacks } : {}) }
      if (fits(compact)) return compact
    }
  } catch {
    // Enumerable accessors may throw while copying context, before JSON serialization.
  }
  // Arbitrary caller context may itself be too large or cyclic. Preserve bounded identity
  // and the diagnostic allowlist rather than letting the server discard everything.
  const essential = {
    operation: clip(errorField(context, 'operation'), 80),
    stage: clip(errorField(context, 'stage'), 80),
    incidentId: clip(errorField(context, 'incidentId'), 64),
    ...(typeof errorField(context, 'online') === 'boolean'
      ? { online: errorField(context, 'online') }
      : {}),
    ...(causes.length
      ? {
          causes: (compactOnly ? causes.slice(-1) : causes).map((cause) => ({
            name: clip(errorField(cause, 'name'), 200),
            message: clip(errorField(cause, 'message'), 250),
            code: clip(errorField(cause, 'code'), 200),
            ...(typeof errorField(cause, 'status') === 'number'
              ? { status: errorField(cause, 'status') }
              : {}),
          })),
        }
      : {}),
  }
  return fits(essential) ? essential : undefined
}

function currentRelease(): string | undefined {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META_NAME}"]`)
  return meta?.content.slice(0, 12) || undefined
}

/** query 里可能带一次性凭据（OAuth 回跳的 code 等），不上报。 */
function currentUrl(): string {
  return `${location.origin}${location.pathname}${location.hash}`
}

export function reportClientError(
  kind: ClientErrorKind,
  error: unknown,
  context?: Record<string, unknown>,
): boolean {
  if (endpoint === null || accepted >= MAX_REPORTS_PER_PAGE) return false
  if (error instanceof Error && reportedErrors.has(error)) return false
  const described = describe(error)
  if (IGNORED_MESSAGES.some((pattern) => pattern.test(described.message))) return false
  const causes = errorCauses(error)
  const key = `${kind}\u0000${described.name ?? ''}\u0000${described.message}\u0000${clip(errorField(context, 'stage'), 80) ?? ''}\u0000${causes.map((cause) => cause.name).join(':')}`
  const seen = repeats.get(key) ?? 0
  if (seen >= MAX_REPEATS) return false
  const diagnosticContext = boundedContext(context, causes)
  repeats.set(key, seen + 1)
  accepted += 1
  if (error instanceof Error) reportedErrors.add(error)
  pending.push({
    kind,
    name: clip(described.name, CLIENT_ERROR_LIMITS.name),
    message: clip(described.message, CLIENT_ERROR_LIMITS.message) ?? 'Unknown error',
    stack: clip(described.stack, CLIENT_ERROR_LIMITS.stack),
    url: clip(currentUrl(), CLIENT_ERROR_LIMITS.url),
    release: currentRelease(),
    context: diagnosticContext,
  })
  scheduleFlush()
  return true
}

/** Caller invokes the returned closure only after this same operation really succeeds. */
export function reportRecoverableClientError(
  error: Error,
  context: Record<string, unknown> & { operation: ClientErrorRecovery['operation'] },
): () => void {
  const incidentId = crypto.randomUUID()
  const operation = errorField(context, 'operation')
  const recorded = reportClientError('error', error, { ...boundedContext(context, []), incidentId })
  let recovered = false
  return () => {
    if (!recorded || recovered || endpoint === null || operation !== 'project.catalog') return
    recovered = true
    recoveries.push({ incidentId, operation })
    scheduleFlush()
  }
}

function scheduleFlush(): void {
  if (!endpoint || flushTimer !== undefined) return
  flushTimer = setTimeout(flushClientErrors, FLUSH_DELAY_MS)
}

export function flushClientErrors(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer)
  flushTimer = undefined
  if (!endpoint) return
  const deviceId = getDeviceId()
  const encode = (errors: ClientErrorReport[]) =>
    JSON.stringify({ deviceId, errors } satisfies ClientErrorBatch)
  const fits = (body: string) => encoder.encode(body).byteLength <= MAX_BATCH_BYTES
  let budget = MAX_FLUSH_BYTES
  const sendBatch = (reports: ClientErrorReport[]): boolean => {
    const body = encode(reports)
    const size = encoder.encode(body).byteLength
    if (size > budget) return false
    budget -= size
    send(endpoint!, body)
    return true
  }
  let batch: ClientErrorReport[] = []
  const queue = pending.splice(0)
  while (queue.length > 0) {
    const report = queue[0]!
    const next = [...batch, report]
    if (next.length <= CLIENT_ERROR_LIMITS.batch && fits(encode(next))) {
      batch = next
      queue.shift()
      continue
    }
    if (batch.length > 0 && !sendBatch(batch)) {
      pending.unshift(...batch, ...queue)
      scheduleFlush()
      return
    }
    batch = []
    queue.shift()
    // 单条超限先缩短栈，尽量保住原始原因与恢复标识；context 自身过大时才丢弃。
    const slimmed = [
      report,
      { ...report, stack: report.stack?.slice(0, 2000) },
      {
        ...report,
        stack: report.stack?.slice(0, 500),
        context: boundedContext(
          report.context,
          Array.isArray(report.context?.causes) ? report.context.causes : [],
          true,
        ),
      },
      { ...report, context: undefined, stack: report.stack?.slice(0, 2000) },
    ].find((candidate) => fits(encode([candidate])))
    if (slimmed) batch = [slimmed]
  }
  if (batch.length > 0 && !sendBatch(batch)) {
    pending.unshift(...batch)
    scheduleFlush()
    return
  }
  // Use the same keepalive budget as errors; a recovery can arrive before its error on the wire.
  while (recoveries.length) {
    const next = recoveries.slice(0, CLIENT_ERROR_LIMITS.batch)
    const body = JSON.stringify({
      deviceId,
      errors: [],
      recoveries: next,
    } satisfies ClientErrorBatch)
    const size = encoder.encode(body).byteLength
    if (size > budget) {
      scheduleFlush()
      return
    }
    budget -= size
    recoveries.splice(0, next.length)
    send(endpoint, body)
  }
}

/** `text/plain` 是 CORS 安全类型，跨域发往 API 时不触发预检；页面关闭途中也能送达。 */
function send(url: string, body: string): void {
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return
  } catch {
    // 落到下面的 fetch。
  }
  void fetch(url, {
    method: 'POST',
    body,
    keepalive: true,
    credentials: 'include',
    headers: { 'content-type': 'text/plain' },
  }).catch(() => {})
}

/**
 * 运行时配置就绪后调用。`baseUrl` 为 null 表示这套部署没有 BFF：此前攒下的全部丢弃，此后不再收集。
 */
export function configureErrorReporting(baseUrl: string | null): void {
  if (baseUrl === null) {
    endpoint = null
    pending.length = 0
    recoveries.length = 0
    return
  }
  endpoint = `${baseUrl.replace(/\/+$/, '')}${CLIENT_ERRORS_PATH}`
  if (pending.length > 0 || recoveries.length > 0) scheduleFlush()
}

export function installErrorReporting(target: Window = window): void {
  // 资源加载失败不冒泡，冒泡阶段收到的只有脚本运行时异常。
  target.addEventListener('error', (event) => {
    reportClientError('error', event.error ?? event.message, {
      source: clip(event.filename, 300),
      line: event.lineno || undefined,
    })
  })
  target.addEventListener('unhandledrejection', (event) => {
    reportClientError('rejection', event.reason)
  })
  target.addEventListener('pagehide', flushClientErrors)
}

/** 仅供测试。 */
export function _resetErrorReportingForTesting(): void {
  endpoint = undefined
  pending.length = 0
  recoveries.length = 0
  reportedErrors = new WeakSet()
  repeats.clear()
  accepted = 0
  if (flushTimer !== undefined) clearTimeout(flushTimer)
  flushTimer = undefined
}
