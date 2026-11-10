import { SQL } from 'bun'
import { sql } from 'drizzle-orm'
import { type BunSQLDatabase, drizzle } from 'drizzle-orm/bun-sql'
import { config } from '../config'
import { schema } from '../db/client'

export const SHARED_MAINTENANCE_INTERVAL_MS = 5 * 60_000
export type MaintenanceTransaction = Parameters<
  Parameters<BunSQLDatabase<typeof schema>['transaction']>[0]
>[0]

interface SharedMaintenanceOptions {
  job: string
  work: (transaction: MaintenanceTransaction) => Promise<void>
  onError?: (error: unknown) => void
  intervalMs?: number
}

/** A dedicated session owns leadership; all maintenance SQL uses its transaction connection. */
export function createSharedMaintenance(options: SharedMaintenanceOptions) {
  let client: SQL | undefined
  let leaderPid: number | undefined
  let pending: Promise<void> | undefined
  let stopped = false
  const disconnect = async () => {
    const previous = client
    client = undefined
    leaderPid = undefined
    if (previous) await previous.close({ timeout: 0 })
  }
  const execute = async () => {
    try {
      if (!client) {
        client = new SQL(process.env.DATABASE_URL?.trim() || config.databaseUrl, {
          max: 1,
          idleTimeout: 0,
          maxLifetime: 0,
          connectionTimeout: 2,
          connection: {
            application_name: `aip-maintenance:${options.job}`,
            statement_timeout: '1500',
            lock_timeout: '500',
          },
          onclose: () => {
            leaderPid = undefined
          },
        })
      }
      const database = drizzle(client, { schema })
      await database.transaction(async (transaction) => {
        const [session] = await transaction.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        )
        if (leaderPid !== session!.pid) {
          const [lock] = await transaction.execute<{ locked: boolean }>(sql`
            SELECT pg_try_advisory_lock(hashtextextended(${`maintenance:${options.job}`}, 0)) AS locked
          `)
          if (!lock?.locked) return
          leaderPid = session!.pid
        }
        if (!stopped) await options.work(transaction)
      })
      // A follower retains no idle connection. Reconnection must acquire leadership again.
      if (leaderPid === undefined) await disconnect()
    } catch (error) {
      await disconnect().catch(() => {})
      options.onError?.(error)
    }
  }
  return {
    run() {
      if (stopped) return Promise.resolve()
      if (!pending)
        pending = execute().finally(() => {
          pending = undefined
        })
      return pending
    },
    async stop() {
      stopped = true
      await pending
      await disconnect()
    },
  }
}

/** Start immediately, then run serially without queuing missed ticks. */
export function startSharedMaintenance(options: SharedMaintenanceOptions) {
  const maintenance = createSharedMaintenance(options)
  void maintenance.run()
  const timer = setInterval(
    () => void maintenance.run(),
    options.intervalMs ?? SHARED_MAINTENANCE_INTERVAL_MS,
  )
  timer.unref()
  return async () => {
    clearInterval(timer)
    await maintenance.stop()
  }
}
