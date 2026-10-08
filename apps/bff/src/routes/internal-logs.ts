import { Elysia } from 'elysia'
import { parseContainerLog } from '../lib/container-logs'
import { writeServerLogs } from '../lib/server-logs'
import { requireInternalService } from '../lib/user-auth'

// Forward input chunks are about 2 MiB; JSON encoding adds container metadata and escaping.
const MAX_BYTES = 8 * 1024 * 1024
const MAX_RECORDS = 20_000
const WRITE_BATCH = 200

async function readBatch(request: Request): Promise<unknown[] | null> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return null
  if (!request.body) return []
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const records: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  if (!Array.isArray(records)) throw new Error('invalid_batch')
  return records.length <= MAX_RECORDS ? records : null
}

/** No request logging here: collector retries would otherwise feed a logging loop. */
export const internalLogRoutes = new Elysia({ prefix: '/internal/logs' })
  .use(requireInternalService)
  .post(
    '/ingest',
    async ({ request, status }) => {
      let records: unknown[] | null
      try {
        records = await readBatch(request)
      } catch {
        return status(400, { error: 'invalid_batch' })
      }
      if (records === null) return status(413, { error: 'log_batch_too_large' })
      try {
        // Parse only a write batch at a time and yield between batches, including empty ones.
        for (let start = 0; start < records.length; start += WRITE_BATCH) {
          const entries = records
            .slice(start, start + WRITE_BATCH)
            .flatMap((record) => parseContainerLog(record) ?? [])
          if (entries.length) await writeServerLogs(entries)
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      } catch {
        return status(503, { error: 'log_store_unavailable' })
      }
      return status(204)
    },
    { parse: 'none' },
  )
