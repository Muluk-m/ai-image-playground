import { sql } from 'drizzle-orm'
import type {
  ClientErrorEvent,
  ClientErrorEventsResult,
  ClientErrorGroup,
  ClientErrorKind,
  ClientErrorsResult,
  Range,
} from '../../contracts'
import { getDbHandle } from './db'
import { volumeBucketUnit } from './queries'

const GROUP_LIMIT = 100
const EVENT_LIMIT = 50

type Row = Record<string, unknown>

function since(range: Range) {
  return range === '1d'
    ? sql`NOW() - INTERVAL '1 day'`
    : range === '7d'
      ? sql`NOW() - INTERVAL '7 days'`
      : sql`NOW() - INTERVAL '30 days'`
}

function epochMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** 趋势分桶与概览的任务量一致：1 天按小时，其余按天，空桶补零。 */
async function trend(range: Range): Promise<ClientErrorsResult['trend']> {
  const { db } = getDbHandle()
  const unit = range === '1d' ? sql`'hour'` : sql`'day'`
  const step = range === '1d' ? sql`INTERVAL '1 hour'` : sql`INTERVAL '1 day'`
  const start =
    range === '1d'
      ? sql`DATE_TRUNC('hour', NOW()) - INTERVAL '23 hours'`
      : range === '7d'
        ? sql`DATE_TRUNC('day', NOW()) - INTERVAL '6 days'`
        : sql`DATE_TRUNC('day', NOW()) - INTERVAL '29 days'`
  const rows = (await db.execute(sql`
    WITH buckets AS (
      SELECT GENERATE_SERIES(${start}, DATE_TRUNC(${unit}, NOW()), ${step}) AS bucket
    )
    SELECT
      EXTRACT(EPOCH FROM b.bucket) * 1000 AS bucket_at,
      COUNT(e.id) FILTER (WHERE e.kind = 'boot') AS boot,
      COUNT(e.id) FILTER (WHERE e.kind <> 'boot') AS runtime
    FROM buckets b
    LEFT JOIN client_errors e
      ON e.received_at >= b.bucket
     AND e.received_at < b.bucket + ${step}
    GROUP BY b.bucket
    ORDER BY b.bucket
  `)) as unknown as Row[]
  return rows.map((row) => ({
    bucket_at: Number(row.bucket_at),
    boot: Number(row.boot),
    runtime: Number(row.runtime),
  }))
}

export async function getClientErrors(range: Range): Promise<ClientErrorsResult> {
  const { db } = getDbHandle()
  const [summaryRows, groupRows, buckets] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) AS events,
        COUNT(DISTINCT device_id) AS devices,
        COUNT(*) FILTER (WHERE kind = 'boot') AS boot_events,
        COUNT(DISTINCT fingerprint) AS groups
      FROM client_errors
      WHERE received_at >= ${since(range)}
    `),
    db.execute(sql`
      SELECT g.*, l.kind, l.name, l.message, l.url, l.release
      FROM (
        SELECT
          fingerprint,
          COUNT(*) AS count,
          COUNT(DISTINCT device_id) AS devices,
          COUNT(DISTINCT user_id) AS users,
          MIN(received_at) AS first_seen,
          MAX(received_at) AS last_seen
        FROM client_errors
        WHERE received_at >= ${since(range)}
        GROUP BY fingerprint
        ORDER BY count DESC, last_seen DESC
        LIMIT ${GROUP_LIMIT}
      ) g
      CROSS JOIN LATERAL (
        SELECT kind, name, message, url, release
        FROM client_errors c
        WHERE c.fingerprint = g.fingerprint
        ORDER BY c.received_at DESC
        LIMIT 1
      ) l
      ORDER BY g.count DESC, g.last_seen DESC
    `),
    trend(range),
  ])
  const summary = (summaryRows as unknown as Row[])[0] ?? {}
  return {
    range,
    bucket_unit: volumeBucketUnit(range),
    summary: {
      events: Number(summary.events ?? 0),
      devices: Number(summary.devices ?? 0),
      boot_events: Number(summary.boot_events ?? 0),
      groups: Number(summary.groups ?? 0),
    },
    trend: buckets,
    groups: (groupRows as unknown as Row[]).map(
      (row): ClientErrorGroup => ({
        fingerprint: String(row.fingerprint),
        kind: row.kind as ClientErrorKind,
        name: text(row.name),
        message: String(row.message),
        count: Number(row.count),
        devices: Number(row.devices),
        users: Number(row.users),
        first_seen: epochMs(row.first_seen),
        last_seen: epochMs(row.last_seen),
        last_url: text(row.url),
        last_release: text(row.release),
      }),
    ),
  }
}

export async function getClientErrorEvents(
  fingerprint: string,
  range: Range,
): Promise<ClientErrorEventsResult> {
  const { db } = getDbHandle()
  const rows = (await db.execute(sql`
    SELECT id, received_at, kind, name, message, stack, url, release, device_id, user_id,
           user_agent, context
    FROM client_errors
    WHERE fingerprint = ${fingerprint} AND received_at >= ${since(range)}
    ORDER BY received_at DESC
    LIMIT ${EVENT_LIMIT}
  `)) as unknown as Row[]
  return {
    fingerprint,
    events: rows.map(
      (row): ClientErrorEvent => ({
        id: String(row.id),
        received_at: epochMs(row.received_at),
        kind: row.kind as ClientErrorKind,
        name: text(row.name),
        message: String(row.message),
        stack: text(row.stack),
        url: text(row.url),
        release: text(row.release),
        device_id: text(row.device_id),
        user_id: text(row.user_id),
        user_agent: text(row.user_agent),
        context:
          row.context && typeof row.context === 'object'
            ? (row.context as Record<string, unknown>)
            : null,
      }),
    ),
  }
}
