import { redactCredentialFragments, redactLogText } from '@image-playground/shared'

const SECRET_FIELD =
  /(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|credential)/i
/** 这些键的值只会是图片或字节，不论类型和长短一律替换。 */
const BINARY_FIELD = /^(?:data|bytes|b64(?:_json)?|base64|inline_?data|image_?data|mask)$/i
const BASE64_RUN = /^[A-Za-z0-9+/_-]{128,}={0,2}$/
const MAX_DEPTH = 12
const ERROR_MESSAGE_MAX = 2000
const BINARY = '[BINARY REDACTED]'

function isByteArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 8 &&
    value.every((one) => typeof one === 'number' && one >= 0 && one <= 255)
  )
}

/** 不看键名也能认出的字节：data URL、长 base64、`Buffer` 的 JSON 形态、字节数组。 */
function looksBinary(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('data:') || BASE64_RUN.test(value)
  if (isByteArray(value)) return true
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return record.type === 'Buffer' && Array.isArray(record.data)
  }
  return false
}

/**
 * 任务详情还给浏览器之前去掉图片数据和凭据字段。提示词、尺寸、模型、错误码留着排障。
 * 不写回数据库。
 */
export function redactTaskRequestPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]'
  if (looksBinary(value)) return BINARY
  if (typeof value === 'string') return redactCredentialFragments(value)
  if (Array.isArray(value)) return value.map((one) => redactTaskRequestPayload(one, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, one]) => {
      if (SECRET_FIELD.test(key)) return [key, '[REDACTED]']
      if (BINARY_FIELD.test(key) && one != null) return [key, BINARY]
      return [key, redactTaskRequestPayload(one, depth + 1)]
    }),
  )
}

/** 上游错误体再过一遍日志脱敏，错误码和 message 还在，凭据形态去掉。 */
export function redactUpstreamBody(value: string | null): string | null {
  if (value == null) return null
  return redactLogText(value)
}

/** 页面上直接展示的错误原文：去掉凭据和内嵌图片，限长；不按字段名丢正文，排障要看它。 */
export function redactTaskErrorMessage(value: string | null): string | null {
  if (value == null) return null
  const cleaned = redactCredentialFragments(value)
  return cleaned.length > ERROR_MESSAGE_MAX ? `${cleaned.slice(0, ERROR_MESSAGE_MAX)}…` : cleaned
}
