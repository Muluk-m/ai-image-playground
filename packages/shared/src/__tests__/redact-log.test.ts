import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isPrivateLogField, redactLogText, sanitizeLogValue } from '../redact-log'

const PRIVATE_KEYS = [
  'body',
  'requestBody',
  'response_body',
  'error_body',
  'ERROR-BODY',
  'payload',
  'request_payload',
  'payloadPreview',
  'payload_preview',
  'prompt',
  'userPrompt',
  'system_prompt',
  'input',
  'rawInput',
  'inputText',
  'input_text',
  'outputText',
  'messageText',
  'output',
  'modelOutput',
  'content',
  'contents',
  'messageContent',
  'messages',
  'parts',
  'image',
  'images',
  'data',
  'headers',
  'authorization',
  'proxyAuthorization',
  'cookie',
  'set-cookie',
  'password',
  'clientSecret',
  'access_token',
  'apiKey',
  'api_key',
  '_data',
  '-headers',
  '__messages',
  '_input_text',
  'requestBody_',
  'data_',
]

const PUBLIC_KEYS = [
  'status',
  'code',
  'taskId',
  'model',
  'contentType',
  'content_length',
  'outputFormat',
  'inputTokens',
  'output_tokens',
  'maxTokens',
  'bodySize',
  'metadata',
  'throughput',
  'message',
  'elapsed_ms',
  '_status',
  'my_metadata',
]

describe('private log fields', () => {
  it('matches private names at any case or separator, including suffixed variants', () => {
    for (const key of PRIVATE_KEYS) expect([key, isPrivateLogField(key)]).toEqual([key, true])
  })

  it('keeps diagnostic fields that merely start with a private word', () => {
    for (const key of PUBLIC_KEYS) expect([key, isPrivateLogField(key)]).toEqual([key, false])
  })

  it('redacts suffixed variants in objects and in labelled text', () => {
    const value = sanitizeLogValue({
      requestBody: 'private request',
      error_body: 'private error',
      nested: { inputText: 'private input', status: 502 },
    })
    expect(JSON.stringify(value)).not.toContain('private')
    expect(JSON.stringify(value)).toContain('502')
    expect(redactLogText('upstream failed requestBody= private text')).toBe(
      'upstream failed [REDACTED PAYLOAD]',
    )
  })
})

describe('malformed fragments', () => {
  it('keeps a bare JS-style object without private keys and the text after it', () => {
    expect(redactLogText('upstream returned {status: timeout}; retrying')).toBe(
      'upstream returned {status: timeout}; retrying',
    )
    expect(redactLogText('state {code: 502, phase: read} then {"prompt":"x"} tail')).toBe(
      'state {code: 502, phase: read} then {"prompt":"[REDACTED]"} tail',
    )
  })

  it('still fails closed for bare objects with private keys, quotes or nesting', () => {
    for (const fragment of [
      '{prompt: hello there}',
      '{userInput: hello}',
      "{status: 'private value'}",
      '{status: {inner: private}}',
      '{status: [private]}',
      '{err: prompt=what is my balance}',
      '{x: a=1&input=hello world}',
    ])
      expect(redactLogText(`upstream ${fragment} private remainder`)).toBe(
        'upstream [REDACTED PAYLOAD]',
      )
  })

  it('rejects a long bare object that does not match without backtracking', () => {
    const pairs = Array.from({ length: 150 }, (_, i) => `f${i}:    v${i}   `).join(',')
    for (const value of [
      `upstream {${pairs}, note: 'x'} retrying`,
      `{${'a:      ,'.repeat(40)}1}`,
    ]) {
      const started = performance.now()
      redactLogText(value)
      expect(performance.now() - started).toBeLessThan(200)
    }
  })

  it('scans a long line of openers without copying the rest of the line', () => {
    const value = `${'{x '.repeat(5000)}tail`
    const started = performance.now()
    redactLogText(value)
    expect(performance.now() - started).toBeLessThan(200)
  })
})

/**
 * The Collector repeats these rules in OTTL (Go RE2); this keeps the two from drifting apart.
 * It runs the patterns on the JS engine, which only answers whether they match: it cannot see a
 * construct RE2 rejects at load time (hence the syntax check below) or how RE2 picks captures.
 */
describe('Collector redaction rules', () => {
  const compose = readFileSync(
    new URL('../../../../deploy/compose.app.yaml', import.meta.url),
    'utf8',
  )
  const yamlRegex = (line: RegExp): RegExp => {
    const quoted = compose.match(line)?.[1]
    if (!quoted) throw new Error(`rule not found: ${line}`)
    const source = quoted.replace(/\\(["\\])/g, '$1').replace(/\$\$/g, '$')
    const flags = source.match(/^\(\?([a-z]+)\)/)?.[1] ?? ''
    return new RegExp(source.replace(/^\(\?[a-z]+\)/, ''), flags)
  }
  const keyRule = yamlRegex(/delete_matching_keys\(attributes, "((?:[^"\\]|\\.)*)"\)/)
  const labelRule = yamlRegex(/replace_pattern\(body, "(\(\?is\)(?:[^"\\]|\\.)*)", "\$\$1/)

  it('uses only syntax RE2 accepts', () => {
    for (const rule of [keyRule, labelRule]) expect(rule.source).not.toMatch(/\(\?[=!<]|\\[1-9]/)
  })

  it('deletes exactly the attribute keys isPrivateLogField marks', () => {
    for (const key of [...PRIVATE_KEYS, ...PUBLIC_KEYS]) {
      expect([key, keyRule.test(key)]).toEqual([key, isPrivateLogField(key)])
      expect([key, keyRule.test(`err.${key}`)]).toEqual([key, isPrivateLogField(key)])
    }
  })

  it('cuts labelled text at the same keys as redactLogText', () => {
    for (const key of [...PRIVATE_KEYS, ...PUBLIC_KEYS]) {
      const text = `upstream failed ${key}: private remainder`
      expect([key, labelRule.test(text)]).toEqual([
        key,
        !redactLogText(text).includes('private remainder'),
      ])
    }
  })
})
