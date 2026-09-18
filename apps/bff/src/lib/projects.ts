import { createHash } from 'node:crypto'
import {
  type CloudProjectSummary,
  PROJECT_RECEIPT_COUNT,
  type ProjectWrite,
} from '@image-playground/shared'
import { and, asc, count, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { withAgentLifecycle } from './agent/lifecycle'
import { runningTurn } from './agent/runningTurns'

const table = schema.canvas_projects
const summaryColumns = {
  id: table.id,
  name: table.name,
  revision: table.revision,
  createdAt: table.created_at,
  updatedAt: table.updated_at,
  elementCount: table.element_count,
  coverMediaId: table.cover_media_id,
  conversationId: table.conversation_id,
}

export async function listProjects(userId: string, pageSize: number, cursor?: string) {
  const rows = await db
    .select(summaryColumns)
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        isNull(table.deleted_at),
        cursor ? gt(table.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(table.id))
    .limit(pageSize + 1)
  const deleted = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.user_id, userId), isNotNull(table.deleted_at)))
  return {
    projects: rows.slice(0, pageSize).filter((row) => !deleted.some((one) => one.id === row.id)),
    deletedIds: deleted.map((one) => one.id),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
  }
}

export async function readProject(userId: string, id: string) {
  const [project] = await db
    .select({ ...summaryColumns, document: table.document, deletedAt: table.deleted_at })
    .from(table)
    .where(and(eq(table.user_id, userId), eq(table.id, id)))
  return project ?? null
}

export async function writeProject(userId: string, id: string, input: ProjectWrite) {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.baseRevision, input.name, input.document]))
    .digest('hex')
  return db.transaction(async (tx) => {
    // 所有项目写入在所有者行上串行，首次创建与已有项目写入共用一个事务边界。
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
    const [existing] = await tx
      .select()
      .from(table)
      .where(and(eq(table.id, id), eq(table.user_id, userId)))
    if (existing?.deleted_at != null)
      return { ok: false as const, status: 410 as const, error: 'project_deleted' }
    const receipt = existing?.receipts.find((one) => one.requestId === input.requestId)
    if (receipt)
      return receipt.digest === digest
        ? { ok: true as const, project: receipt.result }
        : { ok: false as const, status: 409 as const, error: 'request_id_reused' }
    if ((existing?.revision ?? 0) !== input.baseRevision)
      return {
        ok: false as const,
        status: 409 as const,
        error: 'project_conflict',
        revision: existing?.revision ?? 0,
      }
    const reservations = input.document.elements.filter((element) => element.type === 'generation')
    if (reservations.length) {
      const owned = await tx
        .select()
        .from(schema.project_generation_outputs)
        .where(
          and(
            eq(schema.project_generation_outputs.user_id, userId),
            eq(schema.project_generation_outputs.project_id, id),
            inArray(
              schema.project_generation_outputs.object_id,
              reservations.map((element) => element.id),
            ),
          ),
        )
      if (
        reservations.some(
          (element) =>
            !existing?.document.elements.some(
              (current) =>
                current.type === 'generation' &&
                current.id === element.id &&
                current.generationId === element.generationId &&
                current.position === element.position,
            ) ||
            !owned.some(
              (output) =>
                output.object_id === element.id &&
                output.generation_id === element.generationId &&
                output.position === element.position,
            ),
        )
      )
        return { ok: false as const, status: 409 as const, error: 'project_output_not_owned' }
    }
    const imageIds = input.document.elements.flatMap((element) =>
      element.type === 'image' ? [element.mediaId] : [],
    )
    const mediaIds = [...new Set(imageIds)]
    if (mediaIds.length) {
      const ready = await tx
        .select({ id: schema.media_objects.id })
        .from(schema.media_objects)
        .where(
          and(
            eq(schema.media_objects.user_id, userId),
            eq(schema.media_objects.status, 'ready'),
            inArray(schema.media_objects.id, mediaIds),
          ),
        )
      if (ready.length !== mediaIds.length)
        return { ok: false as const, status: 409 as const, error: 'project_media_not_ready' }
    }
    const now = Date.now()
    const project: CloudProjectSummary = {
      id,
      name: input.name,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
      elementCount: input.document.elements.length,
      coverMediaId: imageIds.at(-1) ?? null,
      conversationId: existing?.conversation_id ?? null,
    }
    const values = {
      name: project.name,
      revision: project.revision,
      document: input.document,
      element_count: project.elementCount,
      cover_media_id: project.coverMediaId,
      updated_at: now,
      receipts: [
        ...(existing?.receipts ?? []),
        { requestId: input.requestId, digest, result: project },
      ].slice(-PROJECT_RECEIPT_COUNT),
    }
    if (existing) {
      await tx
        .update(table)
        .set(values)
        .where(and(eq(table.id, id), eq(table.user_id, userId)))
    } else {
      const [total] = await tx
        .select({ count: count() })
        .from(table)
        .where(eq(table.user_id, userId))
      if ((total?.count ?? 0) >= config.operator.quotas['sync:user-projects'])
        return { ok: false as const, status: 413 as const, error: 'project_quota_exceeded' }
      const created = await tx
        .insert(table)
        .values({ id, user_id: userId, created_at: now, ...values })
        .onConflictDoNothing()
        .returning({ id: table.id })
      if (!created.length)
        return { ok: false as const, status: 404 as const, error: 'project_not_found' }
    }
    await tx
      .delete(schema.media_references)
      .where(
        and(
          eq(schema.media_references.user_id, userId),
          eq(schema.media_references.owner_kind, 'project'),
          eq(schema.media_references.owner_id, id),
        ),
      )
    if (mediaIds.length)
      await tx.insert(schema.media_references).values(
        mediaIds.map((mediaId) => ({
          user_id: userId,
          media_id: mediaId,
          owner_kind: 'project' as const,
          owner_id: id,
          created_at: now,
        })),
      )
    return { ok: true as const, project }
  })
}

export async function listRecycledProjects(userId: string, pageSize: number, cursor?: string) {
  const rows = await db
    .select({ ...summaryColumns, deletedAt: table.deleted_at, restoreUntil: table.restore_until })
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        gt(table.restore_until, Date.now()),
        cursor ? gt(table.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(table.id))
    .limit(pageSize + 1)
  return {
    projects: rows.slice(0, pageSize),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
  }
}

export async function recycleProject(userId: string, id: string, restore = false) {
  return withAgentLifecycle({ kind: 'user', userId }, () =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update')
      const [project] = await tx
        .select()
        .from(table)
        .where(and(eq(table.user_id, userId), eq(table.id, id)))
      if (!project) return { ok: false as const, status: 404 as const, error: 'project_not_found' }
      const now = Date.now()
      if (restore && project.deleted_at != null && (project.restore_until ?? 0) <= now)
        return { ok: false as const, status: 410 as const, error: 'project_expired' }
      if ((project.deleted_at == null) === restore) return { ok: true as const }
      if (!restore && project.conversation_id) {
        const [task] = await tx
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.user_id, userId),
              eq(schema.tasks.agent_conversation_id, project.conversation_id),
              inArray(schema.tasks.status, ['queued', 'in_progress']),
            ),
          )
          .limit(1)
        if (runningTurn(project.conversation_id) || task)
          return { ok: false as const, status: 409 as const, error: 'project_busy' }
      }
      const deletedAt = restore ? null : now
      await tx
        .update(table)
        .set({
          deleted_at: deletedAt,
          restore_until: restore
            ? null
            : now + config.operator.quotas['sync:project-recycle-days'] * 86400000,
          revision: project.revision + 1,
          receipts: [],
          updated_at: now,
        })
        .where(and(eq(table.user_id, userId), eq(table.id, id)))
      if (project.conversation_id)
        await tx
          .update(schema.agent_conversations)
          .set({ deleted_at: deletedAt, updated_at: now })
          .where(
            and(
              eq(schema.agent_conversations.id, project.conversation_id),
              eq(schema.agent_conversations.user_id, userId),
            ),
          )
      return { ok: true as const }
    }),
  )
}
