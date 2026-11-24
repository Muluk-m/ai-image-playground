import type { SQL } from 'bun'

export interface BackfillTaskPayloadsOptions {
  /** Number of `tasks` rows scanned per keyset batch (default 1000, max 10000). */
  readonly batchSize?: number
  /** Pause between batches in milliseconds to throttle WAL and I/O (default 50). */
  readonly delayMs?: number
  /** Stop after this many batches if set (useful for bounded maintenance slices). */
  readonly maxBatches?: number
  /** Resume cursor from a previous bounded slice (`result.lastId`); scans strictly `id > afterId`. */
  readonly afterId?: string | null
  /**
   * When true, runs a lock-free drift scan per batch and only takes `FOR SHARE` on the subset of
   * rows that are missing or differ from `tasks` (post-rollout catch-up after old non-dual-writing
   * instances have exited). Default false (`ON CONFLICT DO NOTHING`), safe during rolling deploys.
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

interface DriftScanRow {
  readonly scanned: number
  readonly last_id: string | null
  readonly dirty_ids: string[] | null
}

const MAX_FK_RACE_RETRIES = 3

function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { errno?: unknown; code?: unknown }
  return record.errno === '23503' || record.code === '23503'
}

async function runInsertOnlyBatch(
  client: SQL,
  lastId: string | null,
  batchSize: number,
): Promise<BatchRow> {
  // If maintenance or account deletion removes a row between reading `batch` and checking the FK
  // in `INSERT`, PostgreSQL raises 23503; retry a few times without holding row locks on `tasks`.
  for (let attempt = 1; ; attempt++) {
    try {
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
                SELECT b.id, b.request_payload, b.metering, b.result_payload, b.archive_payload, b.upstream_body
                FROM batch b
                WHERE NOT EXISTS (SELECT 1 FROM task_payloads p WHERE p.task_id = b.id)
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
                SELECT b.id, b.request_payload, b.metering, b.result_payload, b.archive_payload, b.upstream_body
                FROM batch b
                WHERE NOT EXISTS (SELECT 1 FROM task_payloads p WHERE p.task_id = b.id)
                ON CONFLICT (task_id) DO NOTHING
                RETURNING task_id
              )
              SELECT
                (SELECT count(*)::int FROM batch) AS scanned,
                (SELECT count(*)::int FROM upserted) AS written,
                (SELECT max(id) FROM batch) AS last_id
            `
      return row ?? { scanned: 0, written: 0, last_id: null }
    } catch (error) {
      if (attempt < MAX_FK_RACE_RETRIES && isForeignKeyViolation(error)) {
        continue
      }
      throw error
    }
  }
}

async function runRepairBatch(
  client: SQL,
  lastId: string | null,
  batchSize: number,
): Promise<BatchRow> {
  // Phase 1: lock-free single-statement scan finds only missing or drifted rows in this slice.
  const [scan] =
    lastId === null
      ? await client<DriftScanRow[]>`
          WITH batch AS (
            SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
            FROM tasks
            ORDER BY id ASC
            LIMIT ${batchSize}
          ),
          dirty AS (
            SELECT b.id
            FROM batch b
            LEFT JOIN task_payloads p ON p.task_id = b.id
            WHERE
              p.task_id IS NULL
              OR b.request_payload IS DISTINCT FROM p.request_payload
              OR b.metering IS DISTINCT FROM p.metering
              OR b.result_payload IS DISTINCT FROM p.result_payload
              OR b.archive_payload IS DISTINCT FROM p.archive_payload
              OR b.upstream_body IS DISTINCT FROM p.upstream_body
            ORDER BY b.id ASC
          )
          SELECT
            (SELECT count(*)::int FROM batch) AS scanned,
            (SELECT max(id) FROM batch) AS last_id,
            (SELECT coalesce(jsonb_agg(id ORDER BY id ASC), '[]'::jsonb) FROM dirty) AS dirty_ids
        `
      : await client<DriftScanRow[]>`
          WITH batch AS (
            SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
            FROM tasks
            WHERE id > ${lastId}
            ORDER BY id ASC
            LIMIT ${batchSize}
          ),
          dirty AS (
            SELECT b.id
            FROM batch b
            LEFT JOIN task_payloads p ON p.task_id = b.id
            WHERE
              p.task_id IS NULL
              OR b.request_payload IS DISTINCT FROM p.request_payload
              OR b.metering IS DISTINCT FROM p.metering
              OR b.result_payload IS DISTINCT FROM p.result_payload
              OR b.archive_payload IS DISTINCT FROM p.archive_payload
              OR b.upstream_body IS DISTINCT FROM p.upstream_body
            ORDER BY b.id ASC
          )
          SELECT
            (SELECT count(*)::int FROM batch) AS scanned,
            (SELECT max(id) FROM batch) AS last_id,
            (SELECT coalesce(jsonb_agg(id ORDER BY id ASC), '[]'::jsonb) FROM dirty) AS dirty_ids
        `
  const scanned = scan?.scanned ?? 0
  const nextLastId = scan?.last_id ?? null
  const dirtyIds = scan?.dirty_ids ?? []
  if (scanned === 0 || dirtyIds.length === 0) {
    return { scanned, written: 0, last_id: nextLastId }
  }

  // Phase 2: lock ONLY the drifted subset in deterministic id order so clean rows stay unlocked.
  const written = await client.begin(async (tx) => {
    const [row] = await tx<{ written: number }[]>`
      WITH locked AS (
        SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
        FROM tasks
        WHERE id IN (
          SELECT value FROM jsonb_array_elements_text(${JSON.stringify(dirtyIds)}::text::jsonb) AS d(value)
        )
        ORDER BY id ASC
        FOR SHARE
      ),
      upserted AS (
        INSERT INTO task_payloads (
          task_id, request_payload, metering, result_payload, archive_payload, upstream_body
        )
        SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
        FROM locked
        WHERE true
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
      SELECT count(*)::int AS written FROM upserted
    `
    return row?.written ?? 0
  })
  return { scanned, written, last_id: nextLastId }
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

  let lastId: string | null = options.afterId ?? null
  let batches = 0
  let scanned = 0
  let written = 0

  while (maxBatches === undefined || batches < maxBatches) {
    const row: BatchRow = repairMismatches
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

/**
 * Checks parity between `tasks` and `task_payloads` across all 5 cold payload columns within a
 * single `REPEATABLE READ READ ONLY` snapshot so counts and sampled IDs are mutually consistent.
 */
export async function verifyTaskPayloadsConsistency(
  client: SQL,
  sampleLimit = 10,
): Promise<TaskPayloadsConsistencyReport> {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) {
    throw new RangeError(`sampleLimit must be a non-negative integer, got ${sampleLimit}`)
  }
  return client.begin('isolation level repeatable read read only', async (tx) => {
    const [counts] = await tx<
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
    const missingCount = counts?.missing_count ?? 0
    const mismatchCount = counts?.mismatch_count ?? 0
    const missingRows =
      missingCount > 0 && sampleLimit > 0
        ? await tx<{ id: string }[]>`
            SELECT t.id
            FROM tasks t
            LEFT JOIN task_payloads p ON p.task_id = t.id
            WHERE p.task_id IS NULL
            ORDER BY t.id ASC
            LIMIT ${sampleLimit}
          `
        : []
    const mismatchRows =
      mismatchCount > 0 && sampleLimit > 0
        ? await tx<{ id: string }[]>`
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
        : []
    return {
      totalTasks: counts?.total_tasks ?? 0,
      totalPayloads: counts?.total_payloads ?? 0,
      missingCount,
      mismatchCount,
      sampleMissingIds: missingRows.map((row) => row.id),
      sampleMismatchIds: mismatchRows.map((row) => row.id),
    }
  })
}
