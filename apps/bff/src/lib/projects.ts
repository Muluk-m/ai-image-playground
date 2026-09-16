import { createHash } from 'node:crypto'
import {
  type CloudProjectSummary,
  PROJECT_RECEIPT_COUNT,
  type ProjectWrite,
} from '@image-playground/shared'
import { and, asc, count, eq, gt } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'

const table = schema.canvas_projects
const summaryColumns = {
  id: table.id,
  name: table.name,
  revision: table.revision,
  createdAt: table.created_at,
  updatedAt: table.updated_at,
  elementCount: table.element_count,
}

export async function listProjects(userId: string, pageSize: number, cursor?: string) {
  const rows = await db
    .select(summaryColumns)
    .from(table)
    .where(and(eq(table.user_id, userId), cursor ? gt(table.id, cursor) : undefined))
    .orderBy(asc(table.id))
    .limit(pageSize + 1)
  return {
    projects: rows.slice(0, pageSize),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
  }
}

export async function readProject(userId: string, id: string) {
  const [project] = await db
    .select({ ...summaryColumns, document: table.document })
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
    const now = Date.now()
    const project: CloudProjectSummary = {
      id,
      name: input.name,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
      elementCount: input.document.elements.length,
    }
    const values = {
      name: project.name,
      revision: project.revision,
      document: input.document,
      element_count: project.elementCount,
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
    return { ok: true as const, project }
  })
}
