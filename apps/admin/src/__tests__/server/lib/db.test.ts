import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const serverRoot = resolve(import.meta.dir, '../../../../server')

/** Opens the Admin pool in a fresh process, the way the Admin server does on its first query. */
async function startPool(env: Record<string, string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { getDbHandle } = await import('./lib/db.ts')
       const { client, close } = getDbHandle()
       const [{ name }] = await client\`SELECT current_setting('application_name') AS name\`
       const { max, idleTimeout } = client.options
       console.log(JSON.stringify({ max, idleTimeout, name }))
       await close()`,
    ],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        ADMIN_PASSWORD: 'test-pass-1234',
        ADMIN_COOKIE_SECRET: 'test-cookie-secret-32-bytes-min!!',
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
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
  return { exitCode, stdout, stderr }
}

describe('Admin database pool', () => {
  // Bun reports the idle timeout in milliseconds.
  it('names the pool and closes idle connections after 60 s by default', async () => {
    const result = await startPool({})
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ max: 10, idleTimeout: 60_000, name: 'aip-admin' })
  })

  it('sizes the pool and its idle timeout from env', async () => {
    const result = await startPool({ DATABASE_POOL_MAX: '2', DATABASE_IDLE_TIMEOUT_SECONDS: '15' })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ max: 2, idleTimeout: 15_000 })
  })

  it.each([
    'DATABASE_POOL_MAX',
    'DATABASE_IDLE_TIMEOUT_SECONDS',
  ])('refuses to start with an invalid %s', async (name) => {
    const result = await startPool({ [name]: 'two' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`${name} must be a positive integer`)
  })
})
