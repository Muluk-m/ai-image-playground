import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../../../..')

describe('PgBouncer configuration & entrypoint credential routing', () => {
  it('enforces transaction pooling, SCRAM auth_query, prepared statements and ignored timeout startup params', () => {
    const ini = readFileSync(resolve(repoRoot, 'deploy/pgbouncer/pgbouncer.ini'), 'utf8')
    expect(ini).toContain('* = host=postgres port=5432')
    expect(ini).toContain('pool_mode = transaction')
    expect(ini).toContain('auth_type = scram-sha-256')
    expect(ini).toContain('auth_user = pgbouncer_auth')
    expect(ini).toContain('auth_dbname = postgres')
    expect(ini).toContain('auth_query = SELECT usename, passwd FROM pgbouncer.get_auth($1)')
    expect(ini).toMatch(/max_prepared_statements\s*=\s*[1-9]\d*/)
    const ignoredLine = ini.match(/^ignore_startup_parameters\s*=\s*(.+)$/m)?.[1] ?? ''
    for (const param of [
      'statement_timeout',
      'lock_timeout',
      'idle_in_transaction_session_timeout',
    ]) {
      expect(ignoredLine).toContain(param)
    }
  })

  it('provisions pgbouncer_auth without superuser access, sets app role timeout defaults, and avoids compose interpolation on SQL dollar quotes', () => {
    const compose = readFileSync(resolve(repoRoot, 'deploy/compose.infra.yaml'), 'utf8')
    const provision = readFileSync(resolve(repoRoot, 'deploy/pgbouncer/provision.sh'), 'utf8')
    const healthcheck = readFileSync(resolve(repoRoot, 'deploy/pgbouncer/healthcheck.sh'), 'utf8')
    expect(compose).toContain("ALTER ROLE %I SET statement_timeout = ''60s''")
    expect(compose).toContain("ALTER ROLE %I SET lock_timeout = ''10s''")
    expect(compose).toContain("ALTER ROLE %I SET idle_in_transaction_session_timeout = ''60s''")
    expect(compose).toContain('./pgbouncer/provision.sh:/usr/local/bin/pgbouncer-provision.sh:ro')
    expect(compose).toContain(
      './pgbouncer/healthcheck.sh:/usr/local/bin/pgbouncer-healthcheck.sh:ro',
    )
    expect(provision).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT')
    expect(provision).toContain('AND NOT rolsuper')
    expect(provision).toContain('SET search_path = pg_catalog, pg_temp')
    expect(provision).toContain('AS $$')
    expect(healthcheck).toContain(
      "psql --host=127.0.0.1 --port=6432 --username=pgbouncer_auth --dbname=postgres \\\n  --tuples-only --command='SELECT 1'",
    )
  })

  it('maps APP_DIRECT_DATABASE_URL only for bff/worker and scrubs it from every role', () => {
    const baseEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      APP_DATABASE_URL: 'postgresql://app:pw@pgbouncer:6432/db',
      APP_DIRECT_DATABASE_URL: 'postgresql://app:pw@postgres:5432/db',
      MIGRATOR_DATABASE_URL: 'postgresql://mig:pw@postgres:5432/db',
      ADMIN_DATABASE_URL: 'postgresql://adm:pw@postgres:5432/db',
    }
    const runRole = (role: string, extra: Record<string, string> = {}) => {
      const result = spawnSync('sh', ['scripts/docker-entrypoint.sh', 'env'], {
        cwd: repoRoot,
        env: { ...baseEnv, APP_ROLE: role, ...extra },
        encoding: 'utf8',
        timeout: 5000,
      })
      expect(result.status).toBe(0)
      const parsed: Record<string, string> = {}
      for (const line of result.stdout.split('\n')) {
        const sep = line.indexOf('=')
        if (sep > 0) parsed[line.slice(0, sep)] = line.slice(sep + 1)
      }
      return {
        db: parsed.DATABASE_URL ?? '',
        direct: parsed.DIRECT_DATABASE_URL ?? '',
        appDirect: parsed.APP_DIRECT_DATABASE_URL ?? '',
      }
    }

    expect(runRole('bff')).toEqual({
      db: 'postgresql://app:pw@pgbouncer:6432/db',
      direct: 'postgresql://app:pw@postgres:5432/db',
      appDirect: '',
    })
    expect(runRole('worker')).toEqual({
      db: 'postgresql://app:pw@pgbouncer:6432/db',
      direct: 'postgresql://app:pw@postgres:5432/db',
      appDirect: '',
    })
    expect(runRole('bff', { APP_DIRECT_DATABASE_URL: '', DIRECT_DATABASE_URL: 'leaked' })).toEqual({
      db: 'postgresql://app:pw@pgbouncer:6432/db',
      direct: '',
      appDirect: '',
    })
    expect(runRole('migrate', { DIRECT_DATABASE_URL: 'leaked' })).toEqual({
      db: 'postgresql://mig:pw@postgres:5432/db',
      direct: '',
      appDirect: '',
    })
    expect(runRole('admin', { DIRECT_DATABASE_URL: 'leaked' })).toEqual({
      db: 'postgresql://adm:pw@postgres:5432/db',
      direct: '',
      appDirect: '',
    })
    expect(runRole('host-collector', { DIRECT_DATABASE_URL: 'leaked' })).toEqual({
      db: '',
      direct: '',
      appDirect: '',
    })
    expect(runRole('obs-proxy', { DIRECT_DATABASE_URL: 'leaked' })).toEqual({
      db: '',
      direct: '',
      appDirect: '',
    })
  })
})
