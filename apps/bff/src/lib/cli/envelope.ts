/**
 * 对外 CLI API 的响应信封与错误码。stdout 上的每一条 CLI 输出都直接转写这里的形状，
 * 所以字段与错误码是对外契约：改名要当成破坏性变更处理。
 */
export const CLI_API_SCHEMA_VERSION = 1 as const

export interface CliSuccess<T> {
  readonly schema_version: typeof CLI_API_SCHEMA_VERSION
  readonly ok: true
  readonly data: T
}

export interface CliFailure {
  readonly schema_version: typeof CLI_API_SCHEMA_VERSION
  readonly ok: false
  readonly error: {
    readonly code: CliErrorCode
    readonly message: string
    readonly details?: unknown
  }
}

const CLI_ERRORS = {
  INVALID_REQUEST: { status: 400, message: 'The request is invalid' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication is required' },
  INSUFFICIENT_CREDITS: { status: 402, message: 'Insufficient credits' },
  MAX_CREDITS_EXCEEDED: { status: 402, message: 'The request exceeds max_credits' },
  FORBIDDEN: { status: 403, message: 'The token does not grant this permission' },
  PLAN_REQUIRED: { status: 403, message: 'An active subscription is required for this request' },
  NOT_FOUND: { status: 404, message: 'The requested resource was not found' },
  CAPABILITY_UNAVAILABLE: { status: 404, message: 'The CLI API is unavailable' },
  CONFLICT: { status: 409, message: 'The request conflicts with existing state' },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'The idempotency key was already used with different parameters',
  },
  JOB_NOT_CANCELLABLE: { status: 409, message: 'The job cannot be canceled in its current state' },
  MODEL_UNAVAILABLE: { status: 409, message: 'The model is not available right now' },
  MEDIA_NOT_READY: { status: 409, message: 'The media is not ready' },
  REQUEST_TOO_LARGE: { status: 413, message: 'The upload is too large' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  INTERNAL_ERROR: { status: 500, message: 'The request could not be completed' },
  TEMPORARILY_UNAVAILABLE: { status: 503, message: 'The service is temporarily unavailable' },
} as const satisfies Record<string, { status: number; message: string }>

export type CliErrorCode = keyof typeof CLI_ERRORS

export function cliSuccess<T>(data: T): CliSuccess<T> {
  return { schema_version: CLI_API_SCHEMA_VERSION, ok: true, data }
}

export function cliError(
  code: CliErrorCode,
  options: { message?: string; details?: unknown; headers?: Record<string, string> } = {},
): Response {
  const { status, message } = CLI_ERRORS[code]
  const body: CliFailure = {
    schema_version: CLI_API_SCHEMA_VERSION,
    ok: false,
    error: {
      code,
      message: options.message ?? message,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  }
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...options.headers },
  })
}

/** 处理器里抛出它，由边界插件的 onError 转成信封，免得每层都要把 Response 往上传。 */
export class CliRequestError extends Error {
  /**
   * Elysia 把抛出对象的 `code` 当成错误类别。固定成一个非 UNKNOWN 的值，全局的
   * apiErrorHandler 才不会抢先把它改写成 500，留给 CLI 边界转成信封。
   */
  readonly code = 'CLI_REQUEST'
  constructor(
    readonly cliCode: CliErrorCode,
    readonly options: { message?: string; details?: unknown } = {},
  ) {
    super(cliCode)
  }
}
