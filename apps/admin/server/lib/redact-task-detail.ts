import { redactCredentialFragments, redactLogText } from '@image-playground/shared'

const SECRET_FIELD =
  /(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|credential)/i
const BINARY_FIELD = /^(?:data|bytes|b64|base64|image|inlineData)$/i
const MAX_DEPTH = 12

/**
 * 任务详情还给浏览器之前去掉图片数据和凭据字段。提示词、尺寸、模型、错误码留着排障。
 * 不写回数据库。
 */
export function redactTaskRequestPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]'
  if (typeof value === 'string') return redactCredentialFragments(value)
  if (Array.isArray(value)) return value.map((one) => redactTaskRequestPayload(one, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, one]) => {
      if (SECRET_FIELD.test(key)) return [key, '[REDACTED]']
      if (typeof one === 'string' && BINARY_FIELD.test(key) && one.length > 128)
        return [key, '[BINARY REDACTED]']
      return [key, redactTaskRequestPayload(one, depth + 1)]
    }),
  )
}

/** 上游错误体再过一遍日志脱敏，错误码和 message 还在，凭据形态去掉。 */
export function redactUpstreamBody(value: string | null): string | null {
  if (value == null) return null
  return redactLogText(value)
}
