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
      `const { sql } = await import('drizzle-orm')
       const { db, close } = await import('./db/client.ts')
       const burst = await Promise.all(Array.from({ length: 8 }, () =>
         db.execute(sql\`SELECT pg_backend_pid() AS pid, pg_sleep(0.05)\`)))
       console.log(new Set(burst.map((rows) => rows[0].pid)).size)
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
  return { exitCode, connections: stdout.trim(), stderr }
}

describe('BFF database pool', () => {
  it('sizes the pool from DATABASE_POOL_MAX', async () => {
    const result = await startPool({ DATABASE_POOL_MAX: '4' })
    expect(result.stderr).toBe('')
    expect(result.connections).toBe('4')
  })

  it('refuses to start with an invalid DATABASE_POOL_MAX', async () => {
    const result = await startPool({ DATABASE_POOL_MAX: '0' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('DATABASE_POOL_MAX must be a positive integer')
  })
})
