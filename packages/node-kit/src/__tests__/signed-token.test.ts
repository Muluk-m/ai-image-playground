import { describe, expect, it } from 'bun:test'
import { signPayload, signToken, verifyPayload, verifyToken } from '../signed-token'

const SECRET = 'unit-test-secret-32-bytes-minimum!!'
const NOW = 1_700_000_000_000

function repack(token: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${token.split('.')[1]}`
}

describe('signPayload / verifyPayload', () => {
  it('round-trips the payload it signed', () => {
    const token = signPayload(SECRET, { key: 'value' }, { ttlMs: 60_000, now: NOW })
    expect(verifyPayload(SECRET, token, { now: NOW })).toEqual({ key: 'value', exp: NOW + 60_000 })
  })

  it('accepts the token right up to its expiry and rejects it after', () => {
    const token = signPayload(SECRET, {}, { ttlMs: 60_000, now: NOW })
    expect(verifyPayload(SECRET, token, { now: NOW + 60_000 })).not.toBeNull()
    expect(verifyPayload(SECRET, token, { now: NOW + 60_001 })).toBeNull()
  })

  it('rejects a payload swapped under a valid signature', () => {
    const token = signPayload(SECRET, { key: 'value' }, { ttlMs: 60_000, now: NOW })
    expect(verifyPayload(SECRET, repack(token, { key: 'other', exp: NOW + 60_000 }))).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const [payload, signature] = signPayload(SECRET, {}, { ttlMs: 60_000, now: NOW }).split('.')
    expect(verifyPayload(SECRET, `${payload}.${'A'.repeat(signature!.length)}`)).toBeNull()
  })

  it('rejects a token signed with another secret', () => {
    const token = signPayload('another-secret-32-bytes-minimum!!!', {}, { ttlMs: 60_000, now: NOW })
    expect(verifyPayload(SECRET, token, { now: NOW })).toBeNull()
  })

  it('rejects malformed tokens', () => {
    const valid = signPayload(SECRET, {}, { ttlMs: 60_000, now: NOW })
    const [payload, signature] = valid.split('.')
    const malformed = ['', '.', 'no-dot', `${valid}.extra`, `.${signature}`, `${payload}.`]
    for (const token of malformed) {
      expect(verifyPayload(SECRET, token, { now: NOW })).toBeNull()
    }
  })

  it('rejects a signed payload that is not an object with a numeric exp', () => {
    for (const payload of ['"text"', '[]', 'null', '{}', '{"exp":"soon"}']) {
      expect(verifyPayload(SECRET, signToken(SECRET, payload), { now: NOW })).toBeNull()
    }
  })
})

describe('signToken / verifyToken', () => {
  it('keeps a text payload verbatim in the token', () => {
    const iso = new Date(NOW).toISOString()
    const token = signToken(SECRET, iso, 'text')
    expect(token.slice(0, token.lastIndexOf('.'))).toBe(iso)
    expect(verifyToken(SECRET, token, 'text')).toBe(iso)
  })

  it('rejects a text payload tampered under its signature', () => {
    const token = signToken(SECRET, new Date(NOW).toISOString(), 'text')
    const signature = token.slice(token.lastIndexOf('.') + 1)
    expect(verifyToken(SECRET, `2099-01-01T00:00:00.000Z.${signature}`, 'text')).toBeNull()
  })

  it('does not verify a base64url token as text, or the reverse', () => {
    expect(verifyToken(SECRET, signToken(SECRET, 'payload'), 'text')).toBeNull()
    expect(verifyToken(SECRET, signToken(SECRET, 'payload', 'text'))).toBeNull()
  })
})
