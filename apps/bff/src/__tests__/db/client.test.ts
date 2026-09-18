import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '../..')

/** Runs a query burst in a fresh process, whose pool is built the way bff and worker build it. */
async function startPool(env: Record<string, string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      // More concurrent queries than the pool allows: the backends they land on are the pool.
      // After the idle timeout none of them may still be connected.
      `const { sql } = await import('drizzle-orm')
       const { db, close } = await import('./db/client.ts')
       const burst = await Promise.all(Array.from({ length: 8 }, () =>
         db.execute(sql\`SELECT pg_backend_pid() AS pid, current_setting('application_name') AS name,
           pg_sleep(0.05)\`)))
       const pids = [...new Set(burst.map((rows) => rows[0].pid))]
       await Bun.sleep(2_500)
       const [{ open }] = await db.execute(sql\`SELECT count(*)::int AS open FROM pg_stat_activity
         WHERE pid IN (\${sql.join(pids, sql\`, \`)})\`)
       console.log(JSON.stringify({ connections: pids.length, name: burst[0][0].name, open }))
       await close()`,
    ],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
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

describe('BFF database pool', () => {
  it('sizes the pool, names it after the role and closes idle connections, all from env', async () => {
    const result = await startPool({
      APP_ROLE: 'worker',
      DATABASE_POOL_MAX: '4',
      DATABASE_IDLE_TIMEOUT_SECONDS: '1',
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ connections: 4, name: 'aip-worker', open: 0 })
  })

  it('names the pool after the BFF outside the worker role', async () => {
    const result = await startPool({ APP_ROLE: 'bff', DATABASE_IDLE_TIMEOUT_SECONDS: '1' })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ name: 'aip-bff' })
  })

  it.each([
    'DATABASE_POOL_MAX',
    'DATABASE_IDLE_TIMEOUT_SECONDS',
  ])('refuses to start with an invalid %s', async (name) => {
    const result = await startPool({ [name]: '0' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`${name} must be a positive integer`)
  })
})
