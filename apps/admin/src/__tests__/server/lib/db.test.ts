import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const serverRoot = resolve(import.meta.dir, '../../../../server')

/** Builds the Admin pool in a fresh process, the way the Admin server does on its first query. */
async function startPool(env: Record<string, string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      'const { getDbHandle } = await import("./lib/db.ts"); console.log(getDbHandle().client.options.max)',
    ],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        ADMIN_PASSWORD: 'test-pass-1234',
        ADMIN_COOKIE_SECRET: 'test-cookie-secret-32-bytes-min!!',
        DATABASE_URL: 'postgres://pool-test@127.0.0.1:1/pool_test',
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, max: stdout.trim(), stderr }
}

describe('Admin database pool', () => {
  it('sizes the pool from DATABASE_POOL_MAX', async () => {
    const result = await startPool({ DATABASE_POOL_MAX: '2' })
    expect(result.stderr).toBe('')
    expect(result.max).toBe('2')
  })

  it('refuses to start with an invalid DATABASE_POOL_MAX', async () => {
    const result = await startPool({ DATABASE_POOL_MAX: 'two' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('DATABASE_POOL_MAX must be a positive integer')
  })
})
