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
  const secrets = [
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'INTERNAL_API_TOKEN',
    'ADMIN_COOKIE_SECRET',
    'EMAIL_CODE_SECRET',
  ] as const

  function writeRuntime(options: {
    reused?: boolean
    appExtra?: string
    productionExtra?: string
    appLines?: string[]
  } = {}) {
    const target = join(dir, 'image-playground-test')
    mkdirSync(target)
    const reused = options.reused ?? false
    const config =
      options.appLines ??
      [
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
    writeFileSync(join(target, 'app.env'), `${config.join('\n')}\n${options.appExtra ?? ''}`)
    writeFileSync(
      join(target, 'migrate.env'),
      'MIGRATOR_DATABASE_URL=postgresql://aip_test_migrator:owner@postgres:5432/aip_test',
    )
    writeFileSync(join(target, 'operator-config.json'), '{}')
    for (const name of ['image-playground-paid', 'image-playground-internal']) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(
        join(dir, name, 'app.env'),
        [
          'EMAIL_FROM=Muvloom <login@example.com>',
          ...secrets.map((key) => `${key}=production-secret`),
          options.productionExtra ?? '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    return spawnSync('sh', [guard, 'runtime', target], { encoding: 'utf8', timeout: 5000 })
  }

  it('accepts independent resources and reads Docker env data without executing it', () => {
    expect(writeRuntime().status).toBe(0)
  })

  it('checks the effective last value of a repeated setting', () => {
    const result = writeRuntime({
      appExtra: 'APP_DATABASE_URL=postgresql://production:secret@postgres:5432/production',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dedicated test role/database')
  })

  it('refuses credentials shared with production', () => {
    const result = writeRuntime({ reused: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('reuses a production credential')
  })

  it('keeps surrounding quotes in values, matching docker --env-file', () => {
    // Old checker stripped quotes and treated these as the same secret (false reuse).
    // Docker keeps the quotes, so the runtime values differ and isolation may pass.
    const result = writeRuntime({
      appExtra: 'INTERNAL_API_TOKEN="production-secret"',
    })
    expect(result.status).toBe(0)
  })

  it('rejects a quoted database URL that would only pass after quote stripping', () => {
    const result = writeRuntime({
      appExtra:
        'APP_DATABASE_URL="postgresql://aip_test_app:writer@postgres:5432/aip_test"',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dedicated test role/database')
  })

  it('does not expand shell-like variables in values', () => {
    const result = writeRuntime({
      appExtra: 'S3_BUCKET=${S3_BUCKET}',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dedicated test bucket required')
  })

  it('ignores blank lines, # comments, and leading whitespace like docker --env-file', () => {
    const result = writeRuntime({
      appExtra: [
        '',
        '# S3_BUCKET=muvloom-online',
        '  # ignored comment',
        '  S3_BUCKET=muvloom-test',
      ].join('\n'),
    })
    expect(result.status).toBe(0)
  })

  it('treats empty OPS_ALERT_WEBHOOK_URL as unset', () => {
    const result = writeRuntime({
      appExtra: 'OPS_ALERT_WEBHOOK_URL=',
    })
    expect(result.status).toBe(0)
  })

  it('still refuses when both sides keep the same quoted credential', () => {
    const result = writeRuntime({
      appExtra: 'INTERNAL_API_TOKEN="shared-token"',
      productionExtra: 'INTERNAL_API_TOKEN="shared-token"',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('reuses a production credential')
  })
})
