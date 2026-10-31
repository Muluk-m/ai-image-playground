import type { AuthUserView } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { isCapabilityEnabled } from './capabilities'
import { type CliConnection, resolveCliConnection } from './cli-auth'
import { MediaInputError } from './mediaInputs'
import { MediaError } from './projectMedia'

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

/** Stable external codes; unknown upper-case codes fall back to 400 and a generic message. */
const CLI_ERRORS: Record<string, { status: number; message: string }> = {
  UNAUTHENTICATED: { status: 401, message: 'Authentication is required' },
  FORBIDDEN: { status: 403, message: 'The request is not allowed' },
  INVALID_REQUEST: { status: 400, message: 'The request is invalid' },
  CAPABILITY_UNAVAILABLE: { status: 404, message: 'The CLI API is unavailable' },
  NOT_FOUND: { status: 404, message: 'The requested resource was not found' },
  CONFLICT: { status: 409, message: 'The request conflicts with existing state' },
  JOB_NOT_CANCELLABLE: {
    status: 409,
    message: 'The job cannot be canceled in its current state',
  },
  REQUEST_TOO_LARGE: { status: 413, message: 'The request is too large' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  INTERNAL_ERROR: { status: 500, message: 'The request could not be completed' },
}
const FALLBACK_ERROR = { status: 400, message: 'The request could not be completed' }

/** Internal/public error names that map onto a stable CLI code. */
const INTERNAL_ERROR_ALIASES: Record<string, string> = {
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

const MEDIA_STATUS_CODES: Record<number, string> = {
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'REQUEST_TOO_LARGE',
  422: 'INVALID_REQUEST',
}

export function cliError(
  code: string,
  message = (CLI_ERRORS[code] ?? FALLBACK_ERROR).message,
  details?: unknown,
  httpStatus = (CLI_ERRORS[code] ?? FALLBACK_ERROR).status,
  headers: Record<string, string> = {},
): Response {
  const error: CliError['error'] = { code, message, ...(details === undefined ? {} : { details }) }
  return Response.json(
    { schema_version: CLI_API_SCHEMA_VERSION, ok: false, error } satisfies CliError,
    {
      status: httpStatus,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    },
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
  const canonical =
    INTERNAL_ERROR_ALIASES[code] ?? (code === code.toUpperCase() ? code : 'REQUEST_REJECTED')
  return { code: canonical, ...(CLI_ERRORS[canonical] ?? FALLBACK_ERROR) }
}

/** Thrown from the boundary or handlers to answer with a CLI error envelope. */
export class CliRequestError extends Error {
  constructor(readonly code: string) {
    super(code)
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

/** One budget per token across every CLI resource group. */
const sharedLimiter = createCliTokenRateLimiter({ maxRequests: 60, windowMs: 60_000 })

export interface CliApiOptions {
  readonly resolveConnection?: (token: string) => Promise<CliConnection | null>
  readonly capabilityCheck?: () => boolean
  readonly limiter?: CliTokenRateLimiter
}

function requiredScope(request: Request): string | undefined {
  const { pathname } = new URL(request.url)
  if (pathname === '/v1/image-jobs' || pathname === '/v1/image-jobs/validate') return 'images:write'
  if (pathname.startsWith('/v1/jobs/') && pathname.endsWith('/cancel')) return 'images:write'
  if (pathname.startsWith('/v1/media') && request.method !== 'GET') return 'media:write'
  if (pathname.startsWith('/v1/artifacts') || pathname.startsWith('/v1/media')) return 'media:read'
  if (pathname.startsWith('/v1/jobs')) return 'images:read'
  return undefined
}

/**
 * Route boundary for externally-consumed CLI endpoints: capability gate, per-token rate limit,
 * a single connection lookup and scope check. Handlers receive a non-null `cliUser`.
 */
export function cliApiRoutes(options: CliApiOptions = {}) {
  const limiter = options.limiter ?? sharedLimiter
  const capabilityCheck = options.capabilityCheck ?? (() => isCapabilityEnabled('cli:api'))
  const resolveConnection = options.resolveConnection ?? resolveCliConnection
  return new Elysia({ name: 'cli-api-boundary' })
    .onBeforeHandle({ as: 'scoped' }, ({ request }) => {
      if (!capabilityCheck()) return cliError('CAPABILITY_UNAVAILABLE')
      const supplied = bearerToken(request)
      if (!supplied) return cliError('UNAUTHENTICATED')
      const result = limiter.check(supplied)
      if (!result.allowed)
        return cliError('RATE_LIMITED', undefined, undefined, undefined, {
          'retry-after': String(result.retryAfterSeconds),
        })
    })
    .resolve({ as: 'scoped' }, async ({ request }): Promise<{ cliUser: AuthUserView }> => {
      const connection = await resolveConnection(bearerToken(request) ?? '')
      if (!connection) throw new CliRequestError('UNAUTHENTICATED')
      const scope = requiredScope(request)
      if (scope && !connection.scopes.includes(scope)) throw new CliRequestError('FORBIDDEN')
      return { cliUser: connection.user }
    })
    .onError({ as: 'scoped' }, ({ code, error }) => {
      if (code === 'VALIDATION') return cliError('INVALID_REQUEST')
      if (error instanceof CliRequestError) return cliError(error.code)
      if (error instanceof MediaInputError) return cliError('INVALID_REQUEST', error.message)
      if (error instanceof MediaError)
        return cliError(
          MEDIA_STATUS_CODES[error.status] ?? 'INTERNAL_ERROR',
          'The media request could not be completed',
          undefined,
          error.status,
        )
      return cliError('INTERNAL_ERROR')
    })
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization')
  if (!value || !/^Bearer\s+/i.test(value)) return null
  const token = value.slice(value.indexOf(' ') + 1).trim()
  return token || null
}
