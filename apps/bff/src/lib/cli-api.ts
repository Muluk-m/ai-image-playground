import { timingSafeEqual } from 'node:crypto'
import { Elysia } from 'elysia'
import { isCapabilityEnabled } from './capabilities'
import { resolveCliScopes } from './cli-auth'
/** Versioned response shape consumed by native CLI clients. */
export const CLI_API_SCHEMA_VERSION = 1 as const

export interface CliSuccess<T> {
  readonly schema_version: typeof CLI_API_SCHEMA_VERSION
  readonly ok: true
  readonly data: T
}

export interface CliError {
  readonly schema_version: typeof CLI_API_SCHEMA_VERSION
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details?: unknown
  }
}

export type CliEnvelope<T> = CliSuccess<T> | CliError

export function cliSuccess<T>(data: T): CliSuccess<T> {
  return { schema_version: CLI_API_SCHEMA_VERSION, ok: true, data }
}

export function cliError(
  code: string,
  message: string,
  details?: unknown,
  httpStatus = cliHttpStatus(code),
): Response {
  const error: CliError['error'] = { code, message, ...(details === undefined ? {} : { details }) }
  return Response.json(
    { schema_version: CLI_API_SCHEMA_VERSION, ok: false, error } satisfies CliError,
    { status: httpStatus, headers: { 'content-type': 'application/json; charset=utf-8' } },
  )
}

/** Translate internal/public error names to stable CLI codes. */
export function translateCliError(error: unknown): {
  code: string
  message: string
  status: number
} {
  let source: string | undefined
  if (typeof error === 'string') source = error
  else if (error && typeof error === 'object' && 'error' in error) {
    const value = error.error
    if (typeof value === 'string') source = value
  }
  const code = source ?? 'internal_error'
  const translated: Record<string, string> = {
    unauthorized: 'UNAUTHENTICATED',
    invalid_token: 'UNAUTHENTICATED',
    forbidden: 'FORBIDDEN',
    insufficient_scope: 'FORBIDDEN',
    invalid_request: 'INVALID_REQUEST',
    capability_unavailable: 'CAPABILITY_UNAVAILABLE',
    rate_limited: 'RATE_LIMITED',
    not_found: 'NOT_FOUND',
    conflict: 'CONFLICT',
    job_not_cancellable: 'JOB_NOT_CANCELLABLE',
    internal_error: 'INTERNAL_ERROR',
  }
  const canonical = translated[code] ?? (code === code.toUpperCase() ? code : 'REQUEST_REJECTED')
  return { code: canonical, message: cliErrorMessage(canonical), status: cliHttpStatus(canonical) }
}

function cliErrorMessage(code: string): string {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'Authentication is required'
    case 'FORBIDDEN':
      return 'The request is not allowed'
    case 'INVALID_REQUEST':
      return 'The request is invalid'
    case 'CAPABILITY_UNAVAILABLE':
      return 'The CLI API is unavailable'
    case 'RATE_LIMITED':
      return 'Too many requests'
    case 'NOT_FOUND':
      return 'The requested resource was not found'
    case 'JOB_NOT_CANCELLABLE':
      return 'The job cannot be canceled in its current state'
    case 'CONFLICT':
      return 'The request conflicts with existing state'
    default:
      return 'The request could not be completed'
  }
}

function cliHttpStatus(code: string): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401
    case 'FORBIDDEN':
      return 403
    case 'INVALID_REQUEST':
      return 400
    case 'CAPABILITY_UNAVAILABLE':
    case 'NOT_FOUND':
      return 404
    case 'CONFLICT':
    case 'JOB_NOT_CANCELLABLE':
      return 409
    case 'RATE_LIMITED':
      return 429
    case 'INTERNAL_ERROR':
      return 500
    default:
      return 400
  }
}

export interface CliTokenRateLimiter {
  check(
    token: string,
    now?: number,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number }
}

/** Fixed-window limiter keyed by the bearer token, with bounded memory. */
export function createCliTokenRateLimiter(options: {
  readonly maxRequests: number
  readonly windowMs: number
  readonly maxEntries?: number
  readonly clock?: () => number
}): CliTokenRateLimiter {
  const clock = options.clock ?? Date.now
  const entries = new Map<string, { count: number; start: number }>()
  const maxEntries = options.maxEntries ?? 4096
  return {
    check(token, explicitNow) {
      if (options.maxRequests <= 0) return { allowed: true }
      const now = explicitNow ?? clock()
      const current = entries.get(token)
      const entry =
        !current || now - current.start >= options.windowMs ? { count: 0, start: now } : current
      if (entry.count >= options.maxRequests) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((entry.start + options.windowMs - now) / 1000)),
        }
      }
      entry.count += 1
      entries.delete(token)
      entries.set(token, entry)
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!)
      return { allowed: true }
    },
  }
}

export interface CliApiOptions {
  readonly token?: string
  readonly authenticate?: (token: string) => boolean | Promise<boolean>
  readonly scopePolicy?: (request: Request) => string | undefined
  readonly requiredScope?: string
  readonly capabilityCheck?: () => boolean
  readonly maxRequests?: number
  readonly windowMs?: number
  readonly limiter?: CliTokenRateLimiter
}

/**
 * Route boundary for externally-consumed CLI endpoints. It deliberately does not expose website
 * queue handlers: callers compose their own `/v1/*` routes after this authentication/gate plugin.
 */
function defaultScopePolicy(request: Request): string | undefined {
  const url = new URL(request.url)
  if (url.pathname === '/v1/image-jobs' || url.pathname === '/v1/image-jobs/validate')
    return 'images:write'
  if (url.pathname.startsWith('/v1/jobs/') && url.pathname.endsWith('/cancel'))
    return 'images:write'
  if (url.pathname.startsWith('/v1/media') && request.method !== 'GET') return 'media:write'
  if (url.pathname.startsWith('/v1/artifacts') || url.pathname.startsWith('/v1/media'))
    return 'media:read'
  if (url.pathname.startsWith('/v1/jobs')) return 'images:read'
  return undefined
}

export function cliApiRoutes(options: CliApiOptions = {}) {
  const limiter =
    options.limiter ??
    createCliTokenRateLimiter({
      maxRequests: options.maxRequests ?? 60,
      windowMs: options.windowMs ?? 60_000,
    })
  return new Elysia({ name: 'cli-api-boundary' })
    .onBeforeHandle({ as: 'scoped' }, async ({ request }) => {
      if (!(options.capabilityCheck ?? (() => isCapabilityEnabled('cli:api')))())
        return cliError('CAPABILITY_UNAVAILABLE', 'The CLI API is unavailable')
      const supplied = bearerToken(request)
      if (!supplied) return cliError('UNAUTHENTICATED', 'Authentication is required')
      const authenticated = options.authenticate
        ? await options.authenticate(supplied)
        : options.token
          ? safeEqual(supplied, options.token)
          : true
      const requiredScope =
        options.scopePolicy?.(request) ?? defaultScopePolicy(request) ?? options.requiredScope
      if (requiredScope && !(await resolveCliScopes(supplied)).includes(requiredScope))
        return cliError('FORBIDDEN', 'The request is not allowed')
      const result = limiter.check(supplied)

      if (!result.allowed)
        return new Response(JSON.stringify(cliErrorBody('RATE_LIMITED', 'Too many requests')), {
          status: 429,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'retry-after': String(result.retryAfterSeconds),
          },
        })
    })
    .onError({ as: 'scoped' }, ({ error, set }) => {
      const translated = translateCliError(error)
      set.status = translated.status
      return cliErrorBody(translated.code, translated.message)
    })
}

function cliErrorBody(code: string, message: string): CliError {
  return { schema_version: CLI_API_SCHEMA_VERSION, ok: false, error: { code, message } }
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization')
  if (!value || !/^Bearer\s+/i.test(value)) return null
  const token = value.slice(value.indexOf(' ') + 1).trim()
  return token || null
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
