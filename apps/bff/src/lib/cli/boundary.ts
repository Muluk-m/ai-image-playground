import { Elysia } from 'elysia'
import { isCapabilityEnabled } from '../capabilities'
import { log } from '../logger'
import { MediaInputError } from '../mediaInputs'
import { MediaError } from '../projectMedia'
import { type CliConnection, type CliScope, hashCliSecret, resolveCliConnection } from './auth'
import { type CliErrorCode, CliRequestError, cliError } from './envelope'

/**
 * CLI 依赖账号同步：产物要落到账号的媒体库里才有 artifact_id。两个能力都开才算可用。
 * OAuth 端点和 Bearer 接口共用这一个判断。
 */
export function cliApiEnabled(): boolean {
  return isCapabilityEnabled('cli:api') && isCapabilityEnabled('accounts:sync')
}

export interface CliRateLimiter {
  check(
    key: string,
    now?: number,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number }
}

/** 进程内固定窗口；Map 的插入顺序当 LRU，条目数有界。 */
export function createCliRateLimiter(options: {
  readonly maxRequests: number
  readonly windowMs: number
  readonly maxEntries?: number
}): CliRateLimiter {
  const entries = new Map<string, { count: number; start: number }>()
  const maxEntries = options.maxEntries ?? 4096
  return {
    check(key, now = Date.now()) {
      const current = entries.get(key)
      const entry =
        !current || now - current.start >= options.windowMs ? { count: 0, start: now } : current
      entries.delete(key)
      entries.set(key, entry)
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!)
      if (entry.count >= options.maxRequests)
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((entry.start + options.windowMs - now) / 1000)),
        }
      entry.count += 1
      return { allowed: true }
    },
  }
}

/** 一个连接令牌在所有 /v1 资源上共用一份额度。 */
const tokenLimiter = createCliRateLimiter({ maxRequests: 120, windowMs: 60_000 })

export function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')
  return match?.[1] ?? null
}

const MEDIA_ERROR_CODES: Partial<Record<number, CliErrorCode>> = {
  404: 'NOT_FOUND',
  409: 'MEDIA_NOT_READY',
  413: 'REQUEST_TOO_LARGE',
  422: 'INVALID_REQUEST',
  503: 'TEMPORARILY_UNAVAILABLE',
}

export interface CliBoundaryOptions {
  readonly resolveConnection?: (token: string) => Promise<CliConnection | null>
  readonly enabled?: () => boolean
  readonly limiter?: CliRateLimiter
}

/**
 * 外部 CLI 接口的边界：能力门禁 → 令牌限流 → 查一次连接 → 校验路由声明的权限。
 * 处理器拿到非空的 `cli`，开头用 `requireScope` 声明它需要的权限。
 * 所有钩子都是 scoped，只作用于用了这个插件的那一组路由，不会漏到 app 上。
 */
export function cliBoundary(options: CliBoundaryOptions = {}) {
  const resolveConnection = options.resolveConnection ?? resolveCliConnection
  const enabled = options.enabled ?? cliApiEnabled
  const limiter = options.limiter ?? tokenLimiter
  return new Elysia({ name: 'cli-boundary', seed: options })
    .onBeforeHandle({ as: 'scoped' }, ({ request }) => {
      if (!enabled()) return cliError('CAPABILITY_UNAVAILABLE')
      const supplied = bearerToken(request)
      if (!supplied) return cliError('UNAUTHENTICATED')
      const result = limiter.check(hashCliSecret(supplied))
      if (!result.allowed)
        return cliError('RATE_LIMITED', {
          headers: { 'retry-after': String(result.retryAfterSeconds) },
        })
    })
    .resolve({ as: 'scoped' }, async ({ request }) => {
      const cli = await resolveConnection(bearerToken(request) ?? '')
      if (!cli) throw new CliRequestError('UNAUTHENTICATED')
      return { cli }
    })
    .onError({ as: 'scoped' }, ({ code, error, set }) => {
      const response = errorResponse(code, error)
      // 访问日志按 set.status 记账，不同步的话显式拒绝会被记成 500。
      set.status = response.status
      return response
    })
}

function errorResponse(code: string | number, error: unknown): Response {
  if (error instanceof CliRequestError) return cliError(error.cliCode, error.options)
  if (code === 'VALIDATION') return cliError('INVALID_REQUEST')
  if (code === 'NOT_FOUND') return cliError('NOT_FOUND')
  if (error instanceof MediaInputError)
    return cliError('INVALID_REQUEST', { message: error.message })
  if (error instanceof MediaError)
    return cliError(MEDIA_ERROR_CODES[error.status] ?? 'INTERNAL_ERROR')
  log.error({ event: 'cli.unhandled_error', err: error }, 'unhandled CLI API error')
  return cliError('INTERNAL_ERROR')
}

/**
 * 媒体层抛的是网站用的 MediaError / MediaInputError，它们到不了 CLI 边界的 onError
 * （全局处理器先接走）。在调用处换成 CLI 错误。
 */
export async function withMediaErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof MediaInputError)
      throw new CliRequestError('INVALID_REQUEST', { message: error.message })
    if (error instanceof MediaError)
      throw new CliRequestError(MEDIA_ERROR_CODES[error.status] ?? 'INTERNAL_ERROR')
    throw error
  }
}

export function requireScope(cli: CliConnection, scope: CliScope): void {
  if (!cli.scopes.includes(scope)) throw new CliRequestError('FORBIDDEN')
}
