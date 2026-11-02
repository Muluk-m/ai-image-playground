/** Only fixed diagnostic vocabulary may leave the object-store boundary. */
const SAFE_CODES: Record<string, true> = {
  Unauthorized: true,
  AccessDenied: true,
  InvalidAccessKeyId: true,
  SignatureDoesNotMatch: true,
  ExpiredToken: true,
  InvalidToken: true,
  NoSuchBucket: true,
  NoSuchKey: true,
  InternalError: true,
  ServiceUnavailable: true,
  SlowDown: true,
  RequestTimeout: true,
  InvalidArgument: true,
  InvalidRequest: true,
  ECONNRESET: true,
  ECONNREFUSED: true,
  ETIMEDOUT: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EPIPE: true,
  ENETUNREACH: true,
  EHOSTUNREACH: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
  CERT_HAS_EXPIRED: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
}
const SAFE_REASONS: Record<string, string> = {
  'an unexpected error has occurred': 'unexpected_error',
  'We encountered an internal error. Please try again.': 'internal_error',
}

export type OpsStorageStage = 'initialize' | 'list' | 'read'

interface StorageFailure {
  code?: string
  status?: number
  reason: string
  cause?: StorageFailure
}

function field(error: unknown, key: string): unknown {
  try {
    if (typeof error === 'object' && error !== null) return Reflect.get(error, key)
  } catch {
    // Diagnostics must not replace the original failure with a throwing getter.
  }
  return undefined
}

function describeFailure(error: unknown, seen = new Set<unknown>()): StorageFailure {
  seen.add(error)
  const code = field(error, 'code')
  const status = [field(error, 'status'), field(error, 'statusCode')].find(
    (value) => typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599,
  )
  const message = field(error, 'message')
  const cause = field(error, 'cause')
  return {
    ...(typeof code === 'string' && SAFE_CODES[code] ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    reason:
      typeof message === 'string'
        ? (SAFE_REASONS[message] ?? 'details_omitted')
        : 'details_omitted',
    ...(cause !== undefined && cause !== null && !seen.has(cause) && seen.size < 3
      ? { cause: describeFailure(cause, seen) }
      : {}),
  }
}

export class OpsStorageError extends Error {
  readonly storageError: StorageFailure

  constructor(
    readonly stage: OpsStorageStage,
    error: unknown,
  ) {
    super(`Object storage observation failed (${stage})`)
    this.name = 'OpsStorageError'
    this.storageError = describeFailure(error)
  }
}

export async function observeStorage<T>(
  stage: OpsStorageStage,
  read: () => T | Promise<T>,
): Promise<T> {
  try {
    return await read()
  } catch (error) {
    throw new OpsStorageError(stage, error)
  }
}
