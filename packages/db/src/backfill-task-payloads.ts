import type { SQL } from 'bun'

export interface BackfillTaskPayloadsOptions {
  /** Number of `tasks` rows scanned per keyset batch (default 1000, max 10000). */
  readonly batchSize?: number
  /** Pause between batches in milliseconds to throttle WAL and I/O (default 50). */
  readonly delayMs?: number
  /** Stop after this many batches if set (useful for bounded maintenance slices). */
  readonly maxBatches?: number
  /**
   * When true, takes `FOR SHARE` on each batch and updates rows whose payload columns differ from
   * `tasks` (post-rollout catch-up after old non-dual-writing instances have exited).
   * Default false (`ON CONFLICT DO NOTHING`), safe during rolling deploys with zero row locks.
   */
  readonly repairMismatches?: boolean
  readonly onBatch?: (progress: BackfillTaskPayloadsBatch) => void
}

export interface BackfillTaskPayloadsBatch {
  readonly batchNumber: number
  readonly scanned: number
  readonly written: number
  readonly lastId: string | null
}

export interface BackfillTaskPayloadsResult {
  readonly batches: number
  readonly scanned: number
  readonly written: number
  readonly lastId: string | null
  readonly completed: boolean
}

export interface TaskPayloadsConsistencyReport {
  readonly totalTasks: number
  readonly totalPayloads: number
  readonly missingCount: number
  readonly mismatchCount: number
  readonly sampleMissingIds: readonly string[]
  readonly sampleMismatchIds: readonly string[]
}

interface BatchRow {
  readonly scanned: number
  readonly written: number
  readonly last_id: string | null
}

async function runInsertOnlyBatch(
  client: SQL,
  lastId: string | null,
  batchSize: number,
): Promise<BatchRow> {
  const [row] =
    lastId === null
      ? await client<BatchRow[]>`
          WITH batch AS (
            SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
            FROM tasks
            ORDER BY id ASC
            LIMIT ${batchSize}
          ),
          upserted AS (
            INSERT INTO task_payloads (
              task_id, request_payload, metering, result_payload, archive_payload, upstream_body
            )
            SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
            FROM batch
            ON CONFLICT (task_id) DO NOTHING
            RETURNING task_id
          )
          SELECT
            (SELECT count(*)::int FROM batch) AS scanned,
            (SELECT count(*)::int FROM upserted) AS written,
            (SELECT max(id) FROM batch) AS last_id
        `
      : await client<BatchRow[]>`
          WITH batch AS (
            SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
            FROM tasks
            WHERE id > ${lastId}
            ORDER BY id ASC
            LIMIT ${batchSize}
          ),
          upserted AS (
            INSERT INTO task_payloads (
              task_id, request_payload, metering, result_payload, archive_payload, upstream_body
            )
            SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
            FROM batch
            ON CONFLICT (task_id) DO NOTHING
            RETURNING task_id
          )
          SELECT
            (SELECT count(*)::int FROM batch) AS scanned,
            (SELECT count(*)::int FROM upserted) AS written,
            (SELECT max(id) FROM batch) AS last_id
        `
  return row ?? { scanned: 0, written: 0, last_id: null }
}

async function runRepairBatch(
  client: SQL,
  lastId: string | null,
  batchSize: number,
): Promise<BatchRow> {
  return client.begin(async (tx) => {
    const [row] =
      lastId === null
        ? await tx<BatchRow[]>`
            WITH batch AS (
              SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
              FROM tasks
              ORDER BY id ASC
              LIMIT ${batchSize}
              FOR SHARE
            ),
            upserted AS (
              INSERT INTO task_payloads (
                task_id, request_payload, metering, result_payload, archive_payload, upstream_body
              )
              SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
              FROM batch
              ON CONFLICT (task_id) DO UPDATE SET
                request_payload = EXCLUDED.request_payload,
                metering = EXCLUDED.metering,
                result_payload = EXCLUDED.result_payload,
                archive_payload = EXCLUDED.archive_payload,
                upstream_body = EXCLUDED.upstream_body
              WHERE
                task_payloads.request_payload IS DISTINCT FROM EXCLUDED.request_payload
                OR task_payloads.metering IS DISTINCT FROM EXCLUDED.metering
                OR task_payloads.result_payload IS DISTINCT FROM EXCLUDED.result_payload
                OR task_payloads.archive_payload IS DISTINCT FROM EXCLUDED.archive_payload
                OR task_payloads.upstream_body IS DISTINCT FROM EXCLUDED.upstream_body
              RETURNING task_id
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM upserted) AS written,
              (SELECT max(id) FROM batch) AS last_id
          `
        : await tx<BatchRow[]>`
            WITH batch AS (
              SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
              FROM tasks
              WHERE id > ${lastId}
              ORDER BY id ASC
              LIMIT ${batchSize}
              FOR SHARE
            ),
            upserted AS (
              INSERT INTO task_payloads (
                task_id, request_payload, metering, result_payload, archive_payload, upstream_body
              )
              SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
              FROM batch
              ON CONFLICT (task_id) DO UPDATE SET
                request_payload = EXCLUDED.request_payload,
                metering = EXCLUDED.metering,
                result_payload = EXCLUDED.result_payload,
                archive_payload = EXCLUDED.archive_payload,
                upstream_body = EXCLUDED.upstream_body
              WHERE
                task_payloads.request_payload IS DISTINCT FROM EXCLUDED.request_payload
                OR task_payloads.metering IS DISTINCT FROM EXCLUDED.metering
                OR task_payloads.result_payload IS DISTINCT FROM EXCLUDED.result_payload
                OR task_payloads.archive_payload IS DISTINCT FROM EXCLUDED.archive_payload
                OR task_payloads.upstream_body IS DISTINCT FROM EXCLUDED.upstream_body
              RETURNING task_id
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM upserted) AS written,
              (SELECT max(id) FROM batch) AS last_id
          `
    return row ?? { scanned: 0, written: 0, last_id: null }
  })
}

/**
 * Throttled, idempotent keyset backfill copying cold payload columns from `tasks` into
 * `task_payloads`. Safe to re-run or interrupt at any batch boundary.
 */
export async function backfillTaskPayloads(
  client: SQL,
  options: BackfillTaskPayloadsOptions = {},
): Promise<BackfillTaskPayloadsResult> {
  const batchSize = options.batchSize ?? 1000
  const delayMs = options.delayMs ?? 50
  const maxBatches = options.maxBatches
  const repairMismatches = options.repairMismatches ?? false
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError(`batchSize must be an integer between 1 and 10000, got ${batchSize}`)
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(`delayMs must be >= 0, got ${delayMs}`)
  }
  if (maxBatches !== undefined && (!Number.isInteger(maxBatches) || maxBatches < 1)) {
    throw new RangeError(`maxBatches must be a positive integer, got ${maxBatches}`)
  }

  let lastId: string | null = null
  let batches = 0
  let scanned = 0
  let written = 0

  while (maxBatches === undefined || batches < maxBatches) {
    const row = repairMismatches
      ? await runRepairBatch(client, lastId, batchSize)
      : await runInsertOnlyBatch(client, lastId, batchSize)
    if (row.scanned === 0) {
      return { batches, scanned, written, lastId, completed: true }
    }
    batches++
    scanned += row.scanned
    written += row.written
    lastId = row.last_id
    options.onBatch?.({
      batchNumber: batches,
      scanned: row.scanned,
      written: row.written,
      lastId,
    })
    if (row.scanned < batchSize) {
      return { batches, scanned, written, lastId, completed: true }
    }
    if (delayMs > 0 && (maxBatches === undefined || batches < maxBatches)) {
      await Bun.sleep(delayMs)
    }
  }
  return { batches, scanned, written, lastId, completed: false }
}

/** Checks parity between `tasks` and `task_payloads` across all 5 cold payload columns. */
export async function verifyTaskPayloadsConsistency(
  client: SQL,
  sampleLimit = 10,
): Promise<TaskPayloadsConsistencyReport> {
  const [counts] = await client<
    {
      total_tasks: number
      total_payloads: number
      missing_count: number
      mismatch_count: number
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM tasks) AS total_tasks,
      (SELECT count(*)::int FROM task_payloads) AS total_payloads,
      (
        SELECT count(*)::int
        FROM tasks t
        LEFT JOIN task_payloads p ON p.task_id = t.id
        WHERE p.task_id IS NULL
      ) AS missing_count,
      (
        SELECT count(*)::int
        FROM tasks t
        JOIN task_payloads p ON p.task_id = t.id
        WHERE
          t.request_payload IS DISTINCT FROM p.request_payload
          OR t.metering IS DISTINCT FROM p.metering
          OR t.result_payload IS DISTINCT FROM p.result_payload
          OR t.archive_payload IS DISTINCT FROM p.archive_payload
          OR t.upstream_body IS DISTINCT FROM p.upstream_body
      ) AS mismatch_count
  `
  const missingRows = await client<{ id: string }[]>`
    SELECT t.id
    FROM tasks t
    LEFT JOIN task_payloads p ON p.task_id = t.id
    WHERE p.task_id IS NULL
    ORDER BY t.id ASC
    LIMIT ${sampleLimit}
  `
  const mismatchRows = await client<{ id: string }[]>`
    SELECT t.id
    FROM tasks t
    JOIN task_payloads p ON p.task_id = t.id
    WHERE
      t.request_payload IS DISTINCT FROM p.request_payload
      OR t.metering IS DISTINCT FROM p.metering
      OR t.result_payload IS DISTINCT FROM p.result_payload
      OR t.archive_payload IS DISTINCT FROM p.archive_payload
      OR t.upstream_body IS DISTINCT FROM p.upstream_body
    ORDER BY t.id ASC
    LIMIT ${sampleLimit}
  `
  return {
    totalTasks: counts?.total_tasks ?? 0,
    totalPayloads: counts?.total_payloads ?? 0,
    missingCount: counts?.missing_count ?? 0,
    mismatchCount: counts?.mismatch_count ?? 0,
    sampleMissingIds: missingRows.map((row) => row.id),
    sampleMismatchIds: mismatchRows.map((row) => row.id),
  }
}
