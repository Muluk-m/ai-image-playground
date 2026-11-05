import { afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../authenticated-operator-config.json')
process.env.AUTH_PUBLIC_ORIGIN = 'https://api.example.com'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.GPT_DIRECT_ENABLED = 'false'
process.env.DATABASE_URL = 'postgres://localhost/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { config } = await import('../../config')

const ENV_KEYS = [
  'INTERNAL_API_TOKEN',
  'EMAIL_CODE_SECRET',
  'UPSTREAM_SECRETS_MASTER_KEY',
  'OPENAI_API_KEY',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY_BUDGETS_USD',
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
  process.env.GPT_DIRECT_ENABLED = 'false'
})

describe('config.assertValid with OpenAI direct keys', () => {
  it('does not block startup when direct is off, even with unusable key settings', () => {
    process.env.OPENAI_API_KEY = 'sk-single'
    expect(() => config.assertValid()).not.toThrow()
    process.env.OPENAI_API_KEYS = 'sk-a,sk-b'
    process.env.OPENAI_API_KEY_BUDGETS_USD = 'nope'
    expect(() => config.assertValid()).not.toThrow()
  })

  it('still rejects a malformed key list when direct is on', () => {
    process.env.GPT_DIRECT_ENABLED = 'true'
    process.env.OPENAI_API_KEYS = 'sk-a,sk-b'
    process.env.OPENAI_API_KEY_BUDGETS_USD = 'nope'
    expect(() => config.assertValid()).toThrow()
  })
})
