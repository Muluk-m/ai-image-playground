import { projectArtifactId } from '@image-playground/shared'
import { and, desc, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { cancelTasks } from '../db/task-transitions'
import { cliApiRoutes, cliError, cliSuccess } from '../lib/cli-api'
import { resolveCliBearerToken } from '../lib/cli-auth'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { publicTaskErrorMessage } from '../lib/public-task-error'
import { cancelUpstreamOfCancelledTasks } from '../lib/upstream-cancel'

const POLL_AFTER_SECONDS = 2
const LIST_LIMIT = 100

type CliJobStatus = 'queued' | 'running' | 'persisting' | 'succeeded' | 'failed' | 'canceled'

type CliJob = {
  job_id: string
  status: CliJobStatus
  terminal: boolean
  submitted_at: number
  started_at?: number
  completed_at?: number
  poll_after_seconds?: number
  actual_credits?: number | null
  artifacts?: Array<{
    artifact_id: string
    media_id: string
    output_index: number
    mime: string
  }>
  error?: { code: string; message: string }
}

function tokenFromRequest(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return /^Bearer\s+/i.test(header) ? header.slice(header.indexOf(' ') + 1).trim() : ''
}

function statusOf(task: { status: string; archive_payload: unknown }): CliJobStatus {
  if (task.archive_payload && (task.status === 'queued' || task.status === 'in_progress'))
    return 'persisting'
  if (task.status === 'queued') return 'queued'
  if (task.status === 'in_progress') return 'running'
  if (task.status === 'reconciling') return 'persisting'
  if (task.status === 'completed') return 'succeeded'
  if (task.status === 'cancelled') return 'canceled'
  return 'failed'
}

async function currentUser(request: Request) {
  return resolveCliBearerToken(tokenFromRequest(request))
}

async function artifactsOf(taskId: string, userId: string) {
  const rows = await db
    .select({
      mediaId: schema.media_objects.id,
      mime: schema.media_objects.content_type,
      index: schema.generation_images.position,
    })
    .from(schema.generation_images)
    .innerJoin(schema.media_objects, eq(schema.generation_images.media_id, schema.media_objects.id))
    .where(
      and(
        eq(schema.generation_images.generation_id, taskId),
        eq(schema.generation_images.role, 'output'),
        eq(schema.media_objects.user_id, userId),
      ),
    )
    .orderBy(schema.generation_images.position)
  return rows.map((row) => ({
    artifact_id: projectArtifactId(taskId, row.index),
    media_id: row.mediaId,
    output_index: row.index,
    mime: row.mime,
  }))
}

async function toJob(
  task: {
    id: string
    status: string
    archive_payload: unknown
    submitted_at: number
    started_at: number | null
    completed_at: number | null
    error_message: string | null
    error_type: string | null
  },
  userId: string,
): Promise<CliJob> {
  const status = statusOf(task)
  const terminal = status === 'succeeded' || status === 'failed' || status === 'canceled'
  const job: CliJob = {
    job_id: task.id,
    status,
    terminal,
    submitted_at: task.submitted_at,
    ...(task.started_at == null ? {} : { started_at: task.started_at }),
    ...(task.completed_at == null ? {} : { completed_at: task.completed_at }),
    ...(terminal ? {} : { poll_after_seconds: POLL_AFTER_SECONDS }),
  }

  if (terminal) {
    try {
      const credits = await (await loadPrivateBffOverlay()).taskHooks.taskCredits({
        taskIds: [task.id],
      })
      job.actual_credits = credits[task.id] ?? null
    } catch {
      job.actual_credits = null
    }
  }
  if (status === 'succeeded') {
    job.artifacts = await artifactsOf(task.id, userId)
  }
  if (status === 'failed') {
    job.error = {
      code: task.error_type ?? 'unknown',
      message: publicTaskErrorMessage(task.error_message ?? '任务失败'),
    }
  }
  return job
}

const taskSelect = {
  id: schema.tasks.id,
  status: schema.tasks.status,
  archive_payload: schema.tasks.archive_payload,
  submitted_at: schema.tasks.submitted_at,
  started_at: schema.tasks.started_at,
  completed_at: schema.tasks.completed_at,
  error_message: schema.tasks.error_message,
  error_type: schema.tasks.error_type,
} as const

export const cliJobsRoutes = new Elysia({ name: 'cli-jobs-routes' })
  .use(cliApiRoutes({ authenticate: async (token) => Boolean(await resolveCliBearerToken(token)) }))
  .derive({ as: 'scoped' }, async ({ request }) => ({ cliUser: await currentUser(request) }))
  .onError({ as: 'scoped' }, ({ code, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return cliError('INVALID_REQUEST', 'The request is invalid')
    }
    set.status = 500
    return cliError('INTERNAL_ERROR', 'The request could not be completed')
  })
  .get(
    '/v1/jobs/:id',
    async ({ params, cliUser }) => {
      const [task] = await db
        .select(taskSelect)
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, params.id),
            eq(schema.tasks.user_id, cliUser!.id),
            eq(schema.tasks.kind, 'queue'),
          ),
        )
        .limit(1)
      if (!task) return cliError('NOT_FOUND', 'The requested resource was not found')
      return cliSuccess(await toJob(task, cliUser!.id))
    },
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  )
  .get('/v1/jobs', async ({ cliUser }) => {
    const tasks = await db
      .select(taskSelect)
      .from(schema.tasks)
      .where(and(eq(schema.tasks.user_id, cliUser!.id), eq(schema.tasks.kind, 'queue')))
      .orderBy(desc(schema.tasks.submitted_at), desc(schema.tasks.id))
      .limit(LIST_LIMIT)
    return cliSuccess({ jobs: await Promise.all(tasks.map((task) => toJob(task, cliUser!.id))) })
  })
  .post(
    '/v1/jobs/:id/cancel',
    async ({ params, cliUser }) => {
      const access = and(
        eq(schema.tasks.id, params.id),
        eq(schema.tasks.user_id, cliUser!.id),
        eq(schema.tasks.kind, 'queue'),
      )!
      const [existing] = await db
        .select({ status: schema.tasks.status, archive_payload: schema.tasks.archive_payload })
        .from(schema.tasks)
        .where(access)
        .limit(1)
      if (!existing) return cliError('NOT_FOUND', 'The requested resource was not found')
      if (existing.archive_payload || existing.status === 'reconciling')
        return cliError('JOB_NOT_CANCELLABLE', 'The job cannot be canceled in its current state')

      const cancelled = await cancelTasks(access)
      if (cancelled.length) void cancelUpstreamOfCancelledTasks(cancelled.map((row) => row.id))
      const [task] = await db.select(taskSelect).from(schema.tasks).where(access).limit(1)
      if (!task) return cliError('NOT_FOUND', 'The requested resource was not found')
      return cliSuccess(await toJob(task, cliUser!.id))
    },
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  )
