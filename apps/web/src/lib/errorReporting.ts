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
const repeats = new Map<string, number>()
let accepted = 0
let flushTimer: ReturnType<typeof setTimeout> | undefined

function clip(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined
}

function describe(error: unknown): Pick<ClientErrorReport, 'name' | 'message' | 'stack'> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message || error.name, stack: error.stack }
  }
  if (typeof error === 'string') return { message: error }
  try {
    return { message: JSON.stringify(error) ?? String(error) }
  } catch {
    return { message: String(error) }
  }
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
): void {
  if (endpoint === null || accepted >= MAX_REPORTS_PER_PAGE) return
  const described = describe(error)
  if (IGNORED_MESSAGES.some((pattern) => pattern.test(described.message))) return
  const key = `${kind}\u0000${described.name ?? ''}\u0000${described.message}`
  const seen = repeats.get(key) ?? 0
  if (seen >= MAX_REPEATS) return
  repeats.set(key, seen + 1)
  accepted += 1
  pending.push({
    kind,
    name: clip(described.name, CLIENT_ERROR_LIMITS.name),
    message: clip(described.message, CLIENT_ERROR_LIMITS.message) ?? 'Unknown error',
    stack: clip(described.stack, CLIENT_ERROR_LIMITS.stack),
    url: clip(currentUrl(), CLIENT_ERROR_LIMITS.url),
    release: currentRelease(),
    context,
  })
  scheduleFlush()
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
    // 单条就超限（超长的 context、满是中文的栈）：依次去掉 context、缩短栈，保住错误本身。
    const slimmed = [
      report,
      { ...report, context: undefined },
      { ...report, context: undefined, stack: report.stack?.slice(0, 2000) },
    ].find((candidate) => fits(encode([candidate])))
    if (slimmed) batch = [slimmed]
  }
  if (batch.length > 0 && !sendBatch(batch)) {
    pending.unshift(...batch)
    scheduleFlush()
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
    return
  }
  endpoint = `${baseUrl.replace(/\/+$/, '')}${CLIENT_ERRORS_PATH}`
  if (pending.length > 0) scheduleFlush()
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
  repeats.clear()
  accepted = 0
  if (flushTimer !== undefined) clearTimeout(flushTimer)
  flushTimer = undefined
}
