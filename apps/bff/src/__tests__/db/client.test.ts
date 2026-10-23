import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '../..')

const GATE = 4_242_001
/** The child waits on two events with 15-second deadlines each; a green run takes about a second. */
const CHILD_DEADLINE_MS = 40_000

/**
 * Runs a query burst in a fresh process, whose pool is built the way bff and worker build it.
 *
 * The burst queues more queries than the pool allows behind an advisory lock held by a separate
 * connection, so every query is still running when the pool has opened all it may. The lock is
 * released only once `connections` backends of the pool wait on it: how many the pool opened no
 * longer depends on how fast the runner happens to connect. Idle connections are then awaited
 * until the server no longer lists them, with a deadline far past the idle timeout.
 */
async function startPool(env: Record<string, string>, connections = 0) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { sql } = await import('drizzle-orm')
       const { SQL } = await import('bun')
       const { db, close } = await import('./db/client.ts')
       const gate = new SQL(process.env.DATABASE_URL, { max: 1 })
       const until = async (check, what) => {
         const deadline = Date.now() + 15_000
         while (!(await check())) {
           if (Date.now() > deadline) throw new Error('timed out waiting for ' + what)
           await Bun.sleep(20)
         }
       }
       await gate.unsafe('SELECT pg_advisory_lock(${GATE})')
       const burst = Promise.all(Array.from({ length: 8 }, () =>
         db.execute(sql\`SELECT pg_backend_pid() AS pid, current_setting('application_name') AS name,
           pg_advisory_xact_lock_shared(${GATE})\`)))
       const waiting = async () => (await gate.unsafe(
         "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${GATE} AND NOT granted"))[0].n
       await until(async () => (await waiting()) >= ${connections}, 'the pool to open its connections')
       await gate.unsafe('SELECT pg_advisory_unlock(${GATE})')
       const rows = await burst
       const pids = [...new Set(rows.map((result) => result[0].pid))]
       const stillOpen = async () => (await gate.unsafe(
         'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid IN (' + pids.map(Number).join(', ') + ')'))[0].n
       await until(async () => (await stillOpen()) === 0, 'idle connections to close')
       console.log(JSON.stringify({ connections: pids.length, name: rows[0][0].name, open: await stillOpen() }))
       await gate.close()
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
  it(
    'sizes the pool, names it after the role and closes idle connections, all from env',
    async () => {
      const result = await startPool(
        { APP_ROLE: 'worker', DATABASE_POOL_MAX: '4', DATABASE_IDLE_TIMEOUT_SECONDS: '1' },
        4,
      )
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ connections: 4, name: 'aip-worker', open: 0 })
    },
    CHILD_DEADLINE_MS,
  )

  it(
    'names the pool after the BFF outside the worker role',
    async () => {
      const result = await startPool({ APP_ROLE: 'bff', DATABASE_IDLE_TIMEOUT_SECONDS: '1' }, 8)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ connections: 8, name: 'aip-bff' })
    },
    CHILD_DEADLINE_MS,
  )

  it.each([
    'DATABASE_POOL_MAX',
    'DATABASE_IDLE_TIMEOUT_SECONDS',
  ])('refuses to start with an invalid %s', async (name) => {
    const result = await startPool({ [name]: '0' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`${name} must be a positive integer`)
  })
})
