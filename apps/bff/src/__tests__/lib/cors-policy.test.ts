import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertCredentialedCors } from '../../lib/cors-policy'

const repoRoot = resolve(import.meta.dir, '../../../../..')

function envValue(text: string, key: string): string {
  const line = text.split('\n').find((entry) => entry.startsWith(`${key}=`))
  if (!line) throw new Error(`${key} missing`)
  return line.slice(key.length + 1).trim()
}

describe('assertCredentialedCors', () => {
  const off = { 'accounts:login': false, 'billing:credits': false } as const

  it('refuses a wildcard when login or billing is on', () => {
    expect(() => assertCredentialedCors('*', { ...off, 'accounts:login': true })).toThrow(
      'CORS_ALLOWED_ORIGINS=*',
    )
    expect(() => assertCredentialedCors('*', { ...off, 'billing:credits': true })).toThrow(
      'billing:credits',
    )
  })

  it('allows a wildcard only while both capabilities are off, and allows an explicit list', () => {
    expect(() => assertCredentialedCors('*', off)).not.toThrow()
    expect(() =>
      assertCredentialedCors('https://app.example', {
        'accounts:login': true,
        'billing:credits': true,
      }),
    ).not.toThrow()
  })

  it('matches the production example and the test isolation origin list', () => {
    const productionEnv = readFileSync(resolve(repoRoot, 'deploy/app.muvloom.env.example'), 'utf8')
    const productionCors = envValue(productionEnv, 'CORS_ALLOWED_ORIGINS')
    const operator = JSON.parse(
      readFileSync(resolve(repoRoot, 'deploy/operator-config.muvloom.example.json'), 'utf8'),
    ) as { capabilities: { 'accounts:login': boolean; 'billing:credits': boolean } }
    expect(productionCors).not.toBe('*')
    expect(
      operator.capabilities['accounts:login'] || operator.capabilities['billing:credits'],
    ).toBe(true)
    expect(() => assertCredentialedCors(productionCors, operator.capabilities)).not.toThrow()

    const isolation = readFileSync(resolve(repoRoot, 'scripts/check-test-isolation.sh'), 'utf8')
    const testCors = 'https://test.muvloom.online,https://muvloom-test.pages.dev'
    expect(isolation).toContain(`CORS_ALLOWED_ORIGINS)" = ${testCors}`)
    expect(() =>
      assertCredentialedCors(testCors, { 'accounts:login': true, 'billing:credits': true }),
    ).not.toThrow()
  })
})
