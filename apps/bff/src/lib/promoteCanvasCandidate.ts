import type { GenerationDetail, PersistedSubmitRequest } from '@image-playground/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { publishGenerations } from '../db/generation-events'
import {
  archiveCandidateSelection,
  CandidateExpiredError,
  publishGenerationImages,
} from './generationMedia'
import { readGeneration } from './generations'
import { asQueueProvider } from './queueProvider'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type PromoteCanvasResult =
  | { ok: true; detail: GenerationDetail }
  | { ok: false; error: 'not_found' | 'candidate_expired' }

/**
 * 把画布上入选的那一张候选收进作品，来源标成 canvas。
 * 同一张再提升是空操作。原件已经过期时不写记录，避免作品里出现空白卡。
 * 不改计费：不预扣、不结算、不退款。
 */
export async function promoteCanvasCandidate(
  userId: string,
  taskId: string,
  outputIndex: number,
): Promise<PromoteCanvasResult> {
  const [task] = await db
    .select({
      id: schema.tasks.id,
      kind: schema.tasks.kind,
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      request: schema.tasks.request_payload,
      result: schema.tasks.result_payload,
      agentConversationId: schema.tasks.agent_conversation_id,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.user_id, userId)))
    .limit(1)
  if (!task || !isCanvasTask(task)) return { ok: false, error: 'not_found' }
  const provider = asQueueProvider(task.provider)
  if (task.status !== 'completed' || task.result == null || !provider)
    return { ok: false, error: 'candidate_expired' }

  const existing = await readGeneration(userId, taskId)
  if (existing?.outputs.some((output) => output.index === outputIndex)) {
    if (existing.source?.kind !== 'canvas') await markCanvas(userId, taskId, task.request)
    const detail = await readGeneration(userId, taskId)
    return detail ? { ok: true, detail } : { ok: false, error: 'candidate_expired' }
  }

  let links
  try {
    links = await archiveCandidateSelection(
      userId,
      provider,
      task.result,
      task.request,
      outputIndex,
    )
  } catch (error) {
    if (error instanceof CandidateExpiredError) return { ok: false, error: 'candidate_expired' }
    throw error
  }
  if (!links.some((link) => link.role === 'output'))
    return { ok: false, error: 'candidate_expired' }

  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          request: schema.tasks.request_payload,
          agentConversationId: schema.tasks.agent_conversation_id,
          kind: schema.tasks.kind,
        })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.user_id, userId)))
        .limit(1)
        .for('update')
      if (!locked || !isCanvasTask({ ...locked, status: 'completed' }))
        throw new CandidateExpiredError()
      const [linked] = await tx
        .select({ position: schema.generation_images.position })
        .from(schema.generation_images)
        .where(
          and(
            eq(schema.generation_images.generation_id, taskId),
            eq(schema.generation_images.role, 'output'),
            eq(schema.generation_images.position, outputIndex),
            isNull(schema.generation_images.deleted_at),
          ),
        )
        .limit(1)
      await tx
        .update(schema.tasks)
        .set({
          request_payload: { ...locked.request, output_retention: 'canvas' },
        })
        .where(eq(schema.tasks.id, taskId))
      await publishGenerations(tx, [taskId])
      if (!linked) await publishGenerationImages(tx, userId, taskId, links)
      await tx
        .update(schema.generation_records)
        .set({ source: { kind: 'canvas' }, archive_status: 'ready' })
        .where(
          and(
            eq(schema.generation_records.id, taskId),
            eq(schema.generation_records.user_id, userId),
            sql`${schema.generation_records.source} ->> 'kind' IS DISTINCT FROM 'agent'`,
          ),
        )
      const [image] = await tx
        .select({ position: schema.generation_images.position })
        .from(schema.generation_images)
        .where(
          and(
            eq(schema.generation_images.generation_id, taskId),
            eq(schema.generation_images.role, 'output'),
            eq(schema.generation_images.position, outputIndex),
            isNull(schema.generation_images.deleted_at),
          ),
        )
        .limit(1)
      if (!image) throw new CandidateExpiredError()
    })
  } catch (error) {
    if (error instanceof CandidateExpiredError) return { ok: false, error: 'candidate_expired' }
    throw error
  }

  const detail = await readGeneration(userId, taskId)
  if (!detail?.outputs.length) return { ok: false, error: 'candidate_expired' }
  return { ok: true, detail }
}

function isCanvasTask(task: {
  kind: string
  status: string
  agentConversationId: string | null
  request: PersistedSubmitRequest
}): boolean {
  return (
    task.kind === 'queue' &&
    task.agentConversationId == null &&
    task.request.video == null &&
    (task.request.output_retention === 'candidate' || task.request.output_retention === 'canvas')
  )
}

async function markCanvas(
  userId: string,
  taskId: string,
  request: PersistedSubmitRequest,
): Promise<void> {
  await db.transaction(async (tx: Transaction) => {
    await tx
      .update(schema.tasks)
      .set({ request_payload: { ...request, output_retention: 'canvas' } })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.user_id, userId)))
    await publishGenerations(tx, [taskId])
    await tx
      .update(schema.generation_records)
      .set({ source: { kind: 'canvas' }, archive_status: 'ready' })
      .where(
        and(
          eq(schema.generation_records.id, taskId),
          eq(schema.generation_records.user_id, userId),
          sql`${schema.generation_records.source} ->> 'kind' IS DISTINCT FROM 'agent'`,
        ),
      )
  })
}
