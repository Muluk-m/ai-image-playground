import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.MATTE_TRANSFORM_ORIGIN = 'https://bff.example.com'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../matte-operator-config.json')

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { mintSourceToken, verifySourceToken } = await import('../../lib/matte')

const KEY = `matte/${'a1b2c3d4'.repeat(8)}/source.png`

function repack(token: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${token.split('.')[1]}`
}

describe('matte source tokens', () => {
  it('round-trips the key it was minted for', () => {
    expect(verifySourceToken(mintSourceToken(KEY))).toBe(KEY)
  })

  it('rejects an expired token', () => {
    expect(verifySourceToken(mintSourceToken(KEY, Date.now() - 10 * 60 * 1000))).toBeNull()
  })

  it('rejects a payload swapped under a valid signature', () => {
    const token = mintSourceToken(KEY)
    const forged = repack(token, { key: 'task-1/in/0', exp: Date.now() + 60_000 })
    expect(verifySourceToken(forged)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const [payload, signature] = mintSourceToken(KEY).split('.')
    expect(verifySourceToken(`${payload}.${'A'.repeat(signature!.length)}`)).toBeNull()
  })

  it('rejects keys outside the matte cache layout', () => {
    const outside = [
      `matte/${'z'.repeat(64)}/source.png`,
      `matte/${'a1b2c3d4'.repeat(8)}/alpha.png`,
      'task-1/in/0',
    ]
    for (const key of outside) {
      expect(verifySourceToken(mintSourceToken(key))).toBeNull()
    }
  })

  it('rejects a token that is not payload.signature', () => {
    for (const token of ['', 'not-a-token', `${mintSourceToken(KEY)}.extra`]) {
      expect(verifySourceToken(token)).toBeNull()
    }
  })
})
