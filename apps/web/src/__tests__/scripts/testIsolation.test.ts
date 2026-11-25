import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  function writeRuntime(
    options: {
      reused?: boolean
      appExtra?: string
      productionExtra?: string
      appLines?: string[]
    } = {},
  ) {
    const target = join(dir, 'image-playground-test')
    mkdirSync(target)
    const reused = options.reused ?? false
    const config = options.appLines ?? [
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
    const production = join(dir, 'image-playground-paid')
    mkdirSync(production, { recursive: true })
    writeFileSync(
      join(production, 'app.env'),
      [
        'EMAIL_FROM=Muvloom <login@example.com>',
        ...secrets.map((key) => `${key}=production-secret`),
        options.productionExtra ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return spawnSync('sh', [guard, 'runtime', target], { encoding: 'utf8', timeout: 5000 })
  }

  it('checks the rendered env files once the config center renders test, against production app.env (ADR 0035)', () => {
    const rendered = join(dir, 'rendered', 'image-playground-test')
    // Laid out the way `config render` writes them: each service holds only its own keys.
    const files = (secret: string): Record<string, string[]> => ({
      bff: [
        'APP_ROLE=bff',
        'PORT=37377',
        'DATABASE_POOL_MAX=6',
        'APP_DATABASE_URL=postgresql://aip_test_app:writer@postgres:5432/aip_test',
        'S3_BUCKET=muvloom-test',
        'OPERATOR_CONFIG_FILE=/run/operator/operator-config.json',
        'AUTH_PUBLIC_ORIGIN=https://test-api.muvloom.online',
        'AUTH_FRONTEND_ORIGIN=https://test.muvloom.online',
        'CORS_ALLOWED_ORIGINS=https://test.muvloom.online,https://muvloom-test.pages.dev',
        ...[
          'S3_ACCESS_KEY_ID',
          'S3_SECRET_ACCESS_KEY',
          'INTERNAL_API_TOKEN',
          'EMAIL_CODE_SECRET',
        ].map((key) => `${key}=${secret}`),
      ],
      // Per-service keys differ on purpose and must not trip the consistency check.
      worker: [
        'APP_ROLE=worker',
        'DATABASE_POOL_MAX=4',
        'APP_DATABASE_URL=postgresql://aip_test_app:writer@postgres:5432/aip_test',
        'S3_BUCKET=muvloom-test',
        `S3_SECRET_ACCESS_KEY=${secret}`,
      ],
      admin: [
        'APP_ROLE=admin',
        'PORT=37378',
        'DATABASE_POOL_MAX=3',
        'ADMIN_DATABASE_URL=postgresql://aip_test_admin:reader@postgres:5432/aip_test',
        `ADMIN_COOKIE_SECRET=${secret}`,
      ],
      web: ['BFF_BASE_URL=https://test-api.muvloom.online'],
    })
    const writeRendered = (secret: string) => {
      for (const [service, lines] of Object.entries(files(secret)))
        writeFileSync(join(rendered, `env/${service}.env`), `${lines.join('\n')}\n`)
    }
    mkdirSync(join(rendered, 'env'), { recursive: true })
    writeFileSync(join(rendered, 'deploy.env'), 'DEPLOYMENT=test\n')
    writeFileSync(
      join(rendered, 'env/migrate.env'),
      'MIGRATOR_DATABASE_URL=postgresql://aip_test_migrator:owner@postgres:5432/aip_test\n',
    )
    writeFileSync(join(rendered, 'operator-config.json'), '{}')
    const production = join(dir, 'apps', 'image-playground-paid')
    mkdirSync(production, { recursive: true })
    writeFileSync(
      join(production, 'app.env'),
      secrets.map((key) => `${key}=production-secret`).join('\n'),
    )
    const check = () => spawnSync('sh', [guard, 'runtime', rendered], { encoding: 'utf8' })
    writeRendered('independent-test-secret')
    const passed = check()
    expect(passed.status, passed.stderr).toBe(0)
    writeRendered('production-secret')
    const reused = check()
    expect(reused.status).toBe(1)
    expect(reused.stderr).toContain('reuses a production credential')

    // A merged view must not hide one service pointing elsewhere.
    writeRendered('independent-test-secret')
    writeFileSync(
      join(rendered, 'env/worker.env'),
      'S3_BUCKET=ai-images\nAPP_DATABASE_URL=postgresql://aip_test_app:writer@postgres:5432/aip_test\n',
    )
    const drifted = check()
    expect(drifted.status).toBe(1)
    expect(drifted.stderr).toContain('S3_BUCKET differs between services')
    writeRendered('independent-test-secret')

    // Production on the config center, test still checked against what production really uses.
    const productionRendered = join(dir, 'rendered', 'image-playground-paid')
    mkdirSync(join(productionRendered, 'env'), { recursive: true })
    writeFileSync(join(productionRendered, 'deploy.env'), 'DEPLOYMENT=prod\n')
    // Laid out like a real production render: bff and admin files, every credential present.
    const writeProduction = (s3AccessKey: string) => {
      writeFileSync(
        join(productionRendered, 'env/bff.env'),
        `${secrets
          .filter((key) => key !== 'ADMIN_COOKIE_SECRET')
          .map(
            (key) => `${key}=${key === 'S3_ACCESS_KEY_ID' ? s3AccessKey : 'rendered-production'}`,
          )
          .join('\n')}\n`,
      )
      writeFileSync(
        join(productionRendered, 'env/admin.env'),
        'ADMIN_COOKIE_SECRET=rendered-production\n',
      )
    }
    writeProduction('independent-test-secret')
    const sharedWithRenderedProduction = check()
    expect(sharedWithRenderedProduction.status).toBe(1)
    expect(sharedWithRenderedProduction.stderr).toContain(
      'S3_ACCESS_KEY_ID reuses a production credential',
    )

    // Production rendered but its containers still on app.env: both count.
    writeProduction('rotated-production')
    writeRendered('production-secret')
    expect(check().stderr).toContain('reuses a production credential')

    // A production render missing a file or a credential proves nothing: refuse.
    writeRendered('independent-test-secret')
    expect(check().status, check().stderr).toBe(0)
    rmSync(join(productionRendered, 'env/admin.env'))
    expect(check().stderr).toContain('production rendered configuration lacks admin.env')
    writeProduction('rotated-production')
    writeFileSync(join(productionRendered, 'env/admin.env'), '')
    expect(check().stderr).toContain(
      'ADMIN_COOKIE_SECRET is missing from the production rendered configuration',
    )
    writeProduction('rotated-production')

    // host-collector reads its own file; a production token left only there is still caught.
    writeRendered('independent-test-secret')
    writeFileSync(
      join(rendered, 'env/host-collector.env'),
      'INTERNAL_API_TOKEN=production-secret\n',
    )
    const collector = check()
    expect(collector.status).toBe(1)
    expect(collector.stderr).toContain('INTERNAL_API_TOKEN')
  })

  it('accepts independent resources and reads Docker env data without executing it', () => {
    expect(writeRuntime().status).toBe(0)
  })

  it('accepts pgbouncer for APP_DATABASE_URL alongside a dedicated direct postgres URL', () => {
    const pooled = writeRuntime({
      appExtra: [
        'APP_DATABASE_URL=postgresql://aip_test_app:writer@pgbouncer:6432/aip_test',
        'APP_DIRECT_DATABASE_URL=postgresql://aip_test_app:writer@postgres:5432/aip_test',
      ].join('\n'),
    })
    expect(pooled.status).toBe(0)
  })

  it('rejects production direct database URLs in APP_DIRECT_DATABASE_URL', () => {
    const badDirect = writeRuntime({
      appExtra:
        'APP_DIRECT_DATABASE_URL=postgresql://paid_app:secret@postgres:5432/image_playground_paid',
    })
    expect(badDirect.status).toBe(1)
    expect(badDirect.stderr).toContain('APP_DIRECT_DATABASE_URL')
  })

  it('rejects setting DIRECT_DATABASE_URL directly in app.env', () => {
    const rawDirect = writeRuntime({
      appExtra:
        'DIRECT_DATABASE_URL=postgresql://paid_app:secret@postgres:5432/image_playground_paid',
    })
    expect(rawDirect.status).toBe(1)
    expect(rawDirect.stderr).toContain('DIRECT_DATABASE_URL')
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
      appExtra: 'APP_DATABASE_URL="postgresql://aip_test_app:writer@postgres:5432/aip_test"',
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

  it('drops CRLF line endings and a leading BOM like docker --env-file', () => {
    const target = join(dir, 'image-playground-test')
    const result = writeRuntime()
    expect(result.status).toBe(0)
    const app = join(target, 'app.env')
    const body = readFileSync(app, 'utf8')
    writeFileSync(app, `\uFEFF${body.split('\n').join('\r\n')}`)
    expect(spawnSync('sh', [guard, 'runtime', target], { encoding: 'utf8' }).status).toBe(0)
  })

  it('keeps trailing whitespace in values', () => {
    const result = writeRuntime({ appExtra: 'S3_BUCKET=muvloom-test ' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dedicated test bucket required')
  })

  it('refuses a variable without = because Docker would inherit it from the host', () => {
    const result = writeRuntime({ appExtra: 'OPS_ALERT_WEBHOOK_URL' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not a valid Docker env file')
  })

  it('refuses variable names Docker rejects', () => {
    for (const line of ['APP_DATABASE_URL =postgresql://x', '=orphan']) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir)
      const result = writeRuntime({ appExtra: line })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('not a valid Docker env file')
    }
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
