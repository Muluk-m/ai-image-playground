import type { TaskStatus } from '@image-playground/shared'
import { and, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { cancelTasks } from '../../db/task-transitions'
import { loadPrivateBffOverlay } from '../private-overlay'
import { publicTaskErrorMessage } from '../public-task-error'
import { taskProgressPhase } from '../task-progress'
import { cancelUpstreamOfCancelledTasks } from '../upstream-cancel'
import { CliRequestError } from './envelope'

const POLL_AFTER_SECONDS = 2
export const JOB_LIST_MAX = 50

export type CliJobStatus = 'queued' | 'running' | 'persisting' | 'succeeded' | 'failed' | 'canceled'

export interface CliArtifactRef {
  readonly artifact_id: string
  readonly media_id: string
  readonly content_type: string
}

export interface CliJob {
  readonly job_id: string
  readonly status: CliJobStatus
  readonly terminal: boolean
  readonly model: string
  readonly idempotency_key: string | null
  readonly submitted_at: number
  readonly started_at: number | null
  readonly completed_at: number | null
  readonly next_poll_after_seconds?: number
  readonly actual_credits?: number | null
  readonly artifacts?: readonly CliArtifactRef[]
  readonly error?: { readonly code: string; readonly message: string }
}

const jobColumns = {
  id: schema.tasks.id,
  status: schema.tasks.status,
  model: schema.tasks.model,
  client_request_id: schema.tasks.client_request_id,
  archive_payload: schema.tasks.archive_payload,
  upstream_task_ids: schema.tasks.upstream_task_ids,
  lease_expires_at: schema.tasks.lease_expires_at,
  submitted_at: schema.tasks.submitted_at,
  started_at: schema.tasks.started_at,
  completed_at: schema.tasks.completed_at,
  error_message: schema.tasks.error_message,
  error_type: schema.tasks.error_type,
} as const

type JobRow = {
  id: string
  status: TaskStatus
  model: string
  client_request_id: string | null
  archive_payload: unknown
  upstream_task_ids: string[] | null
  lease_expires_at: number | null
  submitted_at: number
  started_at: number | null
  completed_at: number | null
  error_message: string | null
  error_type: string | null
}

/** 产物 id：任务 id 加输出序号。对外只认这个，不暴露内部的画布元素 id。 */
export function artifactId(taskId: string, position: number): string {
  return `art_${taskId}_${position}`
}

export function parseArtifactId(value: string): { taskId: string; position: number } | null {
  const match = /^art_([0-9A-Za-z-]{1,64})_(\d{1,3})$/.exec(value)
  return match ? { taskId: match[1]!, position: Number(match[2]) } : null
}

/**
 * 内部状态 → 对外六态。`succeeded` 只在产物已落库后出现（ADR 0009：归档确认前任务仍是进行中，
 * 这段对外叫 persisting）；结果待核查（reconciling）仍算 running。
 */
function statusOf(row: JobRow): CliJobStatus {
  if (row.status === 'completed') return 'succeeded'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'cancelled') return 'canceled'
  const phase = taskProgressPhase(row)
  if (phase === 'confirming') return 'persisting'
  return phase === 'queued' ? 'queued' : 'running'
}

/** 一批任务的对外形状：积分与产物各查一次，不按任务逐条查。 */
async function toJobs(rows: readonly JobRow[], userId: string): Promise<CliJob[]> {
  const succeeded = rows.filter((row) => row.status === 'completed').map((row) => row.id)
  const terminal = rows
    .filter((row) => ['completed', 'failed', 'cancelled'].includes(row.status))
    .map((row) => row.id)
  const [artifacts, credits] = await Promise.all([
    succeeded.length
      ? db
          .select({
            taskId: schema.generation_images.generation_id,
            position: schema.generation_images.position,
            mediaId: schema.media_objects.id,
            contentType: schema.media_objects.content_type,
          })
          .from(schema.generation_images)
          .innerJoin(
            schema.generation_records,
            eq(schema.generation_records.id, schema.generation_images.generation_id),
          )
          .innerJoin(
            schema.media_objects,
            eq(schema.media_objects.id, schema.generation_images.media_id),
          )
          .where(
            and(
              inArray(schema.generation_images.generation_id, succeeded),
              eq(schema.generation_images.role, 'output'),
              // 网站上删掉的生成：产物不再列出，与 artifacts 接口的 404 保持一致。
              isNull(schema.generation_records.deleted_at),
              eq(schema.media_objects.user_id, userId),
            ),
          )
          .orderBy(schema.generation_images.position)
      : [],
    terminal.length
      ? loadPrivateBffOverlay()
          .then((overlay) => overlay.taskHooks.taskCredits({ taskIds: terminal }))
          .catch(() => null)
      : null,
  ])
  const artifactsByTask = new Map<string, typeof artifacts>()
  for (const row of artifacts)
    artifactsByTask.set(row.taskId, [...(artifactsByTask.get(row.taskId) ?? []), row])
  return rows.map((row) => {
    const status = statusOf(row)
    const isTerminal = status === 'succeeded' || status === 'failed' || status === 'canceled'
    return {
      job_id: row.id,
      status,
      terminal: isTerminal,
      model: row.model,
      idempotency_key: row.client_request_id,
      submitted_at: row.submitted_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      ...(isTerminal
        ? { actual_credits: credits?.[row.id] ?? null }
        : { next_poll_after_seconds: POLL_AFTER_SECONDS }),
      ...(status === 'succeeded'
        ? {
            artifacts: (artifactsByTask.get(row.id) ?? []).map((one) => ({
              artifact_id: artifactId(row.id, one.position),
              media_id: one.mediaId,
              content_type: one.contentType,
            })),
          }
        : {}),
      ...(status === 'failed'
        ? {
            error: {
              code: row.error_type ?? 'generation_failed',
              message: publicTaskErrorMessage(row.error_message ?? '任务失败'),
            },
          }
        : {}),
    }
  })
}

function ownedJob(userId: string, jobId: string): SQL {
  return and(
    eq(schema.tasks.id, jobId),
    eq(schema.tasks.user_id, userId),
    eq(schema.tasks.kind, 'queue'),
  )!
}

export async function getJob(userId: string, jobId: string): Promise<CliJob> {
  const [row] = await db.select(jobColumns).from(schema.tasks).where(ownedJob(userId, jobId))
  if (!row) throw new CliRequestError('NOT_FOUND')
  return (await toJobs([row], userId))[0]!
}

/**
 * 最近的任务，新的在前；`cursor` 是上一页最后一条的 job_id。按幂等键过滤时最多一条，
 * 用来找回提交响应丢了的那次任务。列的是账号全部图片任务，网站发起的也在内。
 */
export async function listJobs(
  userId: string,
  options: { limit: number; cursor?: string; idempotencyKey?: string },
): Promise<{ jobs: CliJob[]; next_cursor: string | null }> {
  const conditions: SQL[] = [eq(schema.tasks.user_id, userId), eq(schema.tasks.kind, 'queue')]
  if (options.idempotencyKey)
    conditions.push(eq(schema.tasks.client_request_id, options.idempotencyKey))
  if (options.cursor) {
    const [anchor] = await db
      .select({ submittedAt: schema.tasks.submitted_at, id: schema.tasks.id })
      .from(schema.tasks)
      .where(ownedJob(userId, options.cursor))
    if (!anchor) throw new CliRequestError('INVALID_REQUEST', { message: 'unknown cursor' })
    conditions.push(
      or(
        lt(schema.tasks.submitted_at, anchor.submittedAt),
        and(eq(schema.tasks.submitted_at, anchor.submittedAt), lt(schema.tasks.id, anchor.id)),
      )!,
    )
  }
  const rows = await db
    .select(jobColumns)
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.submitted_at), desc(schema.tasks.id))
    .limit(options.limit + 1)
  const page = rows.slice(0, options.limit)
  return {
    jobs: await toJobs(page, userId),
    next_cursor: rows.length > options.limit ? page.at(-1)!.id : null,
  }
}

/**
 * 只有排队或生成中、还没拿到结果的任务能取消，退款走既有的取消结算。结果正在落库
 * （persisting）或待核查时拒绝，图继续交付；已取消的再取消一次直接返回原状。
 */
export async function cancelJob(userId: string, jobId: string): Promise<CliJob> {
  const access = ownedJob(userId, jobId)
  const cancelled = await db.transaction(async (tx) => {
    const [row] = await tx.select(jobColumns).from(schema.tasks).where(access).for('update')
    if (!row) throw new CliRequestError('NOT_FOUND')
    if (row.status === 'cancelled') return []
    if (!['queued', 'in_progress'].includes(row.status) || row.archive_payload)
      throw new CliRequestError('JOB_NOT_CANCELLABLE', {
        details: { status: statusOf(row) },
      })
    return cancelTasks(and(access, isNull(schema.tasks.archive_payload))!, { tx })
  })
  if (cancelled.length) void cancelUpstreamOfCancelledTasks(cancelled.map((row) => row.id))
  return getJob(userId, jobId)
}

/** 记下这条任务来自哪个 CLI 连接，供来源统计；失败不影响任务本身。 */
export async function recordCliJob(taskId: string, userId: string, connectionId: string) {
  await db
    .insert(schema.cli_jobs)
    .values({
      task_id: taskId,
      user_id: userId,
      connection_id: connectionId,
      created_at: Date.now(),
    })
    .onConflictDoNothing()
}
