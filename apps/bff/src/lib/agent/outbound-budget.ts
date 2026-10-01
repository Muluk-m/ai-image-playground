import { Buffer } from 'node:buffer'
import { config } from '../../config'
import type { AgentFetch } from './model'

export type AgentRequestRejection = 'body_too_large' | 'unsupported_body' | 'invalid_limit'

/** Only sizes and a closed reason are safe to expose; never include the serialized payload. */
export class AgentRequestBudgetError extends Error {
  constructor(
    readonly reason: AgentRequestRejection,
    readonly requestBytes: number | null,
    readonly limit: number,
  ) {
    super(
      reason === 'body_too_large'
        ? `Model request is ${requestBytes} UTF-8 bytes; the local limit is ${limit} bytes. Reduce reference images or text, or split the request.`
        : reason === 'unsupported_body'
          ? 'Model request body cannot be measured safely and was not sent. Contact the operator.'
          : 'Model request byte limit is invalid and the request was not sent. Contact the operator.',
    )
    this.name = 'AgentRequestBudgetError'
  }
}

export interface AgentDispatchObserver {
  readonly onDispatch?: (requestBytes: number) => Promise<void>
  readonly onRejected?: (error: AgentRequestBudgetError) => Promise<void>
}

/** Serialized fetch bodies only: streams and multipart encodings must not bypass the limit. */
export function assertOutboundBody(body: unknown, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new AgentRequestBudgetError('invalid_limit', null, limit)
  }
  const requestBytes =
    typeof body === 'string'
      ? Buffer.byteLength(body, 'utf8')
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
        ? body.byteLength
        : body instanceof Blob
          ? body.size
          : body instanceof URLSearchParams
            ? Buffer.byteLength(body.toString(), 'utf8')
            : body === null || body === undefined
              ? 0
              : null
  if (requestBytes === null) {
    throw new AgentRequestBudgetError('unsupported_body', null, limit)
  }
  if (requestBytes > limit) {
    throw new AgentRequestBudgetError('body_too_large', requestBytes, limit)
  }
  return requestBytes
}

/** One observer belongs to one logical call, even when the SDK replaces thrown errors. */
export function guardedAgentFetch(
  fetch: AgentFetch,
  observer: AgentDispatchObserver = {},
): AgentFetch {
  const limit = config.operator.quotas['agent:request-max-bytes']
  return async (input, init) => {
    let requestBytes: number
    try {
      // A Request hides its original serialized representation behind a stream. Do not buffer it.
      const body = init?.body ?? (input instanceof Request ? input.body : undefined)
      requestBytes = assertOutboundBody(body, limit)
    } catch (error) {
      if (error instanceof AgentRequestBudgetError) await observer.onRejected?.(error)
      throw error
    }
    await observer.onDispatch?.(requestBytes)
    return fetch(input, init)
  }
}
