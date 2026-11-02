import { readErrorEnvelope } from './content-policy'

/**
 * 上游说「这个模型现在没有可用账号或渠道」。和瞬时故障不同，原样重试大概率还是这句，
 * 界面要请用户换模型。宁可漏判：漏判退回 `upstream_error`，误判会把一次抖动说成模型下线。
 */

const UNAVAILABLE_ERROR_CODES: Record<string, true> = {
  model_not_found: true,
  model_not_available: true,
  model_unavailable: true,
}

const UNAVAILABLE_MESSAGE_PATTERNS = [
  /no eligible .*accounts?/i,
  // sub2api 账号池耗尽时说 `No available compatible accounts`（2026-10-29 flare 事故），中间可以夹一两个修饰词。
  /no available (?:[a-z-]+ ){0,2}(?:accounts?|channels?)\b/i,
  /does not exist or you do not have access/i,
  /(?:无|没有)可用(?:的)?(?:渠道|账号|账户)/,
]

function matchesPattern(text: string | null | undefined): boolean {
  return !!text && UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))
}

export interface ModelAvailabilityEvidence {
  readonly message?: string | null
  /** 上游响应体（已解析的对象，或原样文本）。 */
  readonly payload?: unknown
}

export function isModelUnavailableRejection(evidence: ModelAvailabilityEvidence): boolean {
  const { message, payload } = evidence
  const envelope = readErrorEnvelope(payload)
  if (envelope.code && UNAVAILABLE_ERROR_CODES[envelope.code]) return true
  if (matchesPattern(message) || matchesPattern(envelope.message)) return true
  return typeof payload === 'string' && matchesPattern(payload)
}
