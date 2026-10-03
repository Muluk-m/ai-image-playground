import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const guard = resolve(__dirname, '../../../../../scripts/check-test-isolation.sh')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-release-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function check(overrides: Record<string, string> = {}) {
  const values = {
    TEST_PAGES_PROJECT: 'muvloom-test',
    TEST_PUBLIC_ORIGIN: 'https://test.muvloom.online',
    TEST_BFF_BASE_URL: 'https://test-api.muvloom.online',
    ...overrides,
  }
  const file = join(dir, 'pages.env')
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}='${value}'`)
      .join('\n'),
  )
  return spawnSync('sh', [guard, 'pages', file], { encoding: 'utf8', timeout: 5000 })
}

describe('test release refuses production resources', () => {
  it('allows the isolated test frontend and API pair', () => {
    expect(check().status).toBe(0)
  })
  const unsafeConfigs: Record<string, string>[] = [
    { TEST_BFF_BASE_URL: 'https://api.muvloom.online' },
    { TEST_BFF_BASE_URL: '' },
    { TEST_PAGES_PROJECT: 'ai-image-playground' },
    { TEST_PUBLIC_ORIGIN: 'https://muvloom.online' },
    {
      TEST_BFF_BASE_URLS_BY_ORIGIN: '{"https://test.muvloom.online":"https://api.muvloom.online"}',
    },
  ]
  it.each(unsafeConfigs)('refuses unsafe configuration %j before publishing', (values) => {
    const result = check(values)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Test isolation check failed')
  })
})

describe('test backend configuration', () => {
  function runtime(reused = false, extra = '') {
    const target = join(dir, 'image-playground-test')
    mkdirSync(target)
    const secrets = [
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'INTERNAL_API_TOKEN',
      'ADMIN_COOKIE_SECRET',
      'EMAIL_CODE_SECRET',
    ]
    const config = [
      'APP_DATABASE_URL=postgresql://aip_test_app:writer@postgres:5432/aip_test',
      'ADMIN_DATABASE_URL=postgresql://aip_test_admin:reader@postgres:5432/aip_test',
      'S3_BUCKET=muvloom-test',
      'OPERATOR_CONFIG_FILE=/run/operator/operator-config.json',
      'BFF_BASE_URL=https://test-api.muvloom.online',
      'AUTH_PUBLIC_ORIGIN=https://test-api.muvloom.online',
      'AUTH_FRONTEND_ORIGIN=https://test.muvloom.online',
      'CORS_ALLOWED_ORIGINS=https://test.muvloom.online,https://muvloom-test.pages.dev',
      ...secrets.map((key) => `${key}=${reused ? 'production-secret' : 'independent-test-secret'}`),
    ]
    writeFileSync(join(target, 'app.env'), `${config.join('\n')}\n${extra}`)
    writeFileSync(
      join(target, 'migrate.env'),
      'MIGRATOR_DATABASE_URL=postgresql://aip_test_migrator:owner@postgres:5432/aip_test',
    )
    writeFileSync(join(target, 'operator-config.json'), '{}')
    for (const name of ['image-playground-paid', 'image-playground-internal']) {
      mkdirSync(join(dir, name))
      writeFileSync(
        join(dir, name, 'app.env'),
        [
          'EMAIL_FROM=Muvloom <login@example.com>',
          ...secrets.map((key) => `${key}=production-secret`),
        ].join('\n'),
      )
    }
    return spawnSync('sh', [guard, 'runtime', target], { encoding: 'utf8', timeout: 5000 })
  }

  it('accepts independent resources and reads Docker env data without executing it', () => {
    expect(runtime().status).toBe(0)
  })

  it('checks the effective last value of a repeated setting', () => {
    const result = runtime(
      false,
      'APP_DATABASE_URL=postgresql://production:secret@postgres:5432/production',
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dedicated test role/database')
  })

  it('refuses credentials shared with production', () => {
    const result = runtime(true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('reuses a production credential')
  })
})
