import { Elysia, t } from 'elysia'
import { parseContainerLog } from '../lib/container-logs'
import { writeServerLogs } from '../lib/server-logs'
import { requireInternalService } from '../lib/user-auth'

/** A Fluent Bit flush is one chunk of at most a few thousand records. */
const MAX_RECORDS = 100_000
const WRITE_BATCH = 200

/**
 * The deployment's log collector posts the containers' stdout/stderr here
 * (docs/deploy/server-logs.md). It retries any non-2xx with its buffered chunk, so a database
 * failure answers 503 instead of dropping the batch. Requests here are never logged themselves:
 * the BFF's own output comes back through this route.
 */
export const internalLogRoutes = new Elysia({ prefix: '/internal/logs' })
  .use(requireInternalService)
  .post(
    '/ingest',
    async ({ body, status }) => {
      const entries = body.flatMap((record) => parseContainerLog(record) ?? [])
      try {
        for (let start = 0; start < entries.length; start += WRITE_BATCH) {
          await writeServerLogs(entries.slice(start, start + WRITE_BATCH))
        }
      } catch {
        return status(503, { error: 'log_store_unavailable' })
      }
      return status(204)
    },
    { body: t.Array(t.Any(), { maxItems: MAX_RECORDS }) },
  )
