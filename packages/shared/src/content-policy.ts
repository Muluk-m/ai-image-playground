import type { QueueProvider } from './queue-protocol'

/**
 * 上游「内容安全拒绝」的识别。两端都要用：BFF worker 给任务分类，浏览器直连（BYOK）时
 * 没有 worker，前端自己判。判据必须一致，否则同一次拒绝在两条路上出两种文案。
 *
 * 识别靠上游给的错误码优先、文案兜底。文案匹配不理想，但各家网关的码互不相同、且经常只在
 * message 里说人话（Grok 网关就只有一句 `Request blocked by upstream content policy`），
 * 没有码可依。宁可漏判也不要误判：漏判退回 `upstream_error`，行为和今天一样；误判会把一次
 * 瞬时故障说成用户违规，并且撤掉重试入口。
 */

/** 各家在 `error.code` / `error.type` 上给出的内容安全码。 */
const POLICY_ERROR_CODES: Record<string, true> = {
  content_policy_violation: true,
  content_filter: true,
  moderation_blocked: true,
  image_generation_user_error: true,
  safety_violation: true,
  prohibited_content: true,
}

/**
 * 文案判据。全部小写后做子串匹配，短语选得足够长以避免误伤——单独一个 `safety` 或
 * `blocked` 太容易撞上无关故障。
 */
const POLICY_MESSAGE_PHRASES = [
  'safety system',
  'content policy',
  'content_policy',
  'content filter',
  'content_filter',
  'content moderation',
  'moderation blocked',
  'moderation_blocked',
  'safety filter',
  'prompt blocked',
  'blocked by safety',
  'rejected by the safety',
  'violates our',
  'flagged as sensitive',
]

/**
 * Gemini 的显式拒绝：整段提示词被拦（`promptFeedback.blockReason`），或候选项以这些
 * finishReason 收场。与 `shouldRetryEmptyResult` 用的是同一份判据——「不该重试」和
 * 「是内容安全拒绝」在 Gemini 这里就是同一件事。
 */
const GEMINI_BLOCK_FINISH_REASONS: Record<string, true> = {
  SAFETY: true,
  IMAGE_SAFETY: true,
  RECITATION: true,
  PROHIBITED_CONTENT: true,
  BLOCKLIST: true,
  SPII: true,
}

/** 三处判据共用同一份短语表，改一处就得一起改，保留成函数。 */
function matchesPhrase(text: string | null | undefined): boolean {
  if (!text) return false
  const lowered = text.toLowerCase()
  return POLICY_MESSAGE_PHRASES.some((phrase) => lowered.includes(phrase))
}

/** 上游错误 envelope 里的码与人话。各家形状略有出入，按 `in` 逐层收窄，不假设结构。 */
function readErrorEnvelope(payload: unknown): { code: string | null; message: string | null } {
  if (!payload || typeof payload !== 'object' || !('error' in payload))
    return { code: null, message: null }
  const error = payload.error
  if (typeof error === 'string') return { code: null, message: error }
  if (!error || typeof error !== 'object') return { code: null, message: null }
  const raw =
    'code' in error && typeof error.code === 'string'
      ? error.code
      : 'type' in error && typeof error.type === 'string'
        ? error.type
        : null
  return {
    code: raw ? raw.toLowerCase() : null,
    message: 'message' in error && typeof error.message === 'string' ? error.message : null,
  }
}

export interface ContentPolicyEvidence {
  /** 上游 HTTP 状态码；有就用来排除 5xx，那一类是故障不是违规。 */
  readonly status?: number | null
  /** 抛出来的那句话，通常已经是上游 `error.message`。 */
  readonly message?: string | null
  /** 上游响应体（已解析的对象，或原样文本）。 */
  readonly payload?: unknown
}

/**
 * 这次失败是不是上游按内容安全策略拒绝的。
 *
 * 5xx 一律不算：上游自己挂了，和提示词无关。没有状态码（异步任务终态、流式 error 事件）
 * 时照常按码和文案判。
 */
export function isContentPolicyRejection(evidence: ContentPolicyEvidence): boolean {
  const { status, message, payload } = evidence
  if (typeof status === 'number' && status >= 500) return false
  const envelope = readErrorEnvelope(payload)
  if (envelope.code && POLICY_ERROR_CODES[envelope.code]) return true
  if (matchesPhrase(message) || matchesPhrase(envelope.message)) return true
  return typeof payload === 'string' && matchesPhrase(payload)
}

/**
 * 上游回了 200 但没有图时，这是不是内容安全拒绝。Gemini 把拒绝理由放在正常响应体里，
 * 所以走一条单独的判据。
 */
export function isContentPolicyEmptyResult(provider: QueueProvider, payload: unknown): boolean {
  if (provider !== 'gemini') return isContentPolicyRejection({ payload })
  if (!payload || typeof payload !== 'object') return false
  if ('promptFeedback' in payload) {
    const feedback = payload.promptFeedback
    if (
      feedback &&
      typeof feedback === 'object' &&
      'blockReason' in feedback &&
      typeof feedback.blockReason === 'string' &&
      feedback.blockReason.length > 0
    )
      return true
  }
  if (!('candidates' in payload) || !Array.isArray(payload.candidates)) return false
  const first: unknown = payload.candidates[0]
  if (!first || typeof first !== 'object' || !('finishReason' in first)) return false
  return typeof first.finishReason === 'string' && GEMINI_BLOCK_FINISH_REASONS[first.finishReason]
    ? true
    : false
}
