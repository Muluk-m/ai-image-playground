// Exclude raw user content and credentials, including nested error/request objects.
const PRIVATE_FIELD =
  /^(?:authorization|cookie|set-cookie|headers|.*(?:password|secret|token|api[_-]?key)|body|payload|payloadPreview|responseBody|errorBody|request_payload|prompt|content|contents|parts|messages|image|images|data|input|output)$/i

function looksStructured(value: string, cursor: number, arrayPayload: Uint8Array): boolean {
  const opener = value[cursor]
  let next = cursor + 1
  while (next < value.length && /\s/.test(value[next]!)) next++
  const char = value[next]
  if (char === '"' || char === "'") return true
  if (opener === '{') {
    return char === '}' || /^[a-z0-9_$][\w$.-]*\s*:/i.test(value.slice(next))
  }
  return (
    arrayPayload[cursor + 1] === 1 ||
    char === ']' ||
    char === '{' ||
    char === '[' ||
    (char !== undefined && /[0-9-]/.test(char)) ||
    /^(?:true|false|null|undefined|NaN|[+-]?Infinity)(?=[\s,\]])/i.test(value.slice(next))
  )
}

/** A plain diagnostic can still carry a labeled secret, outside any JSON fragment. */
function privateAssignment(value: string): number | null {
  const keys = /\b([a-z_$][\w$-]*)["']?\s*[:=]/gi
  for (const match of value.matchAll(keys)) {
    if (PRIVATE_FIELD.test(match[1]!)) return match.index
  }
  return null
}

/** Credential-shaped fragments. Does not truncate and does not drop prompt text. */
export function redactCredentialFragments(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-[a-z0-9_-]{8,}|AIza[a-z0-9_-]{15,})\b/gi, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|token|password|secret|signature|credential)["']?\s*[:=]\s*["']?)[^\s&#"',}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/data:[^;\s]+;base64,[a-z0-9+/=]+/gi, '[BINARY REDACTED]')
}

/** Single pass, quote-aware JSON fragment scanning; malformed fragments fail closed. */
function redactStructuredText(value: string, depth: number): string {
  // Detect list separators/quoted values before the next closing bracket in linear time.
  // This also catches non-JSON arrays without mistaking [worker] or [as run] for payloads.
  const arrayPayload = new Uint8Array(value.length + 1)
  let evidence = 0
  for (let index = value.length - 1; index >= 0; index--) {
    const char = value[index]
    if (char === ']') evidence = 0
    else if (char === ',' || char === '"' || char === "'") evidence = 1
    arrayPayload[index] = evidence
  }
  const chunks: string[] = []
  let plainStart = 0
  let cursor = 0
  while (cursor < value.length) {
    const opener = value[cursor]
    if ((opener !== '{' && opener !== '[') || !looksStructured(value, cursor, arrayPayload)) {
      cursor++
      continue
    }
    const plain = value.slice(plainStart, cursor)
    const sensitive = privateAssignment(plain)
    if (sensitive !== null)
      return chunks.join('') + plain.slice(0, sensitive) + '[REDACTED PAYLOAD]'
    chunks.push(plain)
    const start = cursor++
    const stack = [opener]
    let quote: string | null = null
    let escaped = false
    while (cursor < value.length && stack.length) {
      const char = value[cursor++]
      if (quote !== null) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = null
      } else if (char === '"' || char === "'") quote = char
      else if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const opening = stack.pop()
        if ((opening === '{' && char !== '}') || (opening === '[' && char !== ']')) {
          // A broken fragment has no trustworthy end boundary; hide its entire remainder.
          cursor = value.length
          stack.push('{')
        }
      }
    }
    if (stack.length) chunks.push('[REDACTED PAYLOAD]')
    else {
      try {
        chunks.push(
          JSON.stringify(sanitizeLogValue(JSON.parse(value.slice(start, cursor)), depth + 1)),
        )
      } catch {
        chunks.push('[REDACTED PAYLOAD]')
        cursor = value.length
      }
    }
    plainStart = cursor
  }
  const plain = value.slice(plainStart)
  const sensitive = privateAssignment(plain)
  chunks.push(sensitive === null ? plain : plain.slice(0, sensitive) + '[REDACTED PAYLOAD]')
  return chunks.join('')
}

export function redactLogText(value: string, depth = 0, maxLength = 4000): string {
  if (depth > 5 || value.length > 16_000) return '[TRUNCATED LOG TEXT]'
  const withoutNul = value
    .replace(/\u0000/g, '')
    .replace(/data:[^;\s]+;base64,[a-z0-9+/=]+/gi, '[BINARY REDACTED]')
  const structured = redactStructuredText(withoutNul, depth)
  return redactCredentialFragments(structured).slice(0, maxLength)
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]'
  if (typeof value === 'string') return redactLogText(value, depth)
  if (Array.isArray(value)) return value.slice(0, 30).map((one) => sanitizeLogValue(one, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([key, one]) => {
          const cleanedKey = key.replace(/\u0000/g, '')
          return [
            cleanedKey.slice(0, 200),
            PRIVATE_FIELD.test(cleanedKey) ? '[REDACTED]' : sanitizeLogValue(one, depth + 1),
          ]
        }),
    )
  }
  return value
}
