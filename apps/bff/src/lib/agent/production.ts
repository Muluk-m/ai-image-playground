import { createHash } from 'node:crypto'
import {
  PRODUCTION_HISTORY_MAX,
  PRODUCTION_RECEIPTS_MAX,
  PRODUCTION_SCENES_MAX,
  PRODUCTION_TEXT_MAX_CHARS,
  type ProductionContent,
  type ProductionMutation,
  type ProductionRecord,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'

export class ProductionError extends Error {
  constructor(
    readonly code:
      | 'production_disabled'
      | 'production_not_found'
      | 'production_conflict'
      | 'production_invalid'
      | 'production_operation_reused',
    readonly current?: ProductionRecord['document'],
  ) {
    super(code)
  }
}
export function validateProductionContent(value: unknown): value is ProductionContent {
  if (!value || typeof value !== 'object') return false
  const c = value as Partial<ProductionContent>
  return (
    typeof c.title === 'string' &&
    c.title.length <= 200 &&
    typeof c.setting === 'string' &&
    typeof c.outline === 'string' &&
    Array.isArray(c.scenes) &&
    c.scenes.length <= PRODUCTION_SCENES_MAX &&
    c.scenes.every(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        s.id.length > 0 &&
        s.id.length <= 128 &&
        typeof s.title === 'string' &&
        s.title.length <= 200 &&
        typeof s.body === 'string',
    ) &&
    new Set(c.scenes.map((s) => s.id)).size === c.scenes.length &&
    JSON.stringify(value).length <= PRODUCTION_TEXT_MAX_CHARS
  )
}
function owned(conversationId: string, userId: string) {
  return and(
    eq(schema.agent_conversations.id, conversationId),
    eq(schema.agent_conversations.user_id, userId),
    isNull(schema.agent_conversations.deleted_at),
  )
}
function assertEnabled() {
  if (!isCapabilityEnabled('agent:production')) throw new ProductionError('production_disabled')
}
export async function readProduction(
  conversationId: string,
  userId: string,
): Promise<ProductionRecord | null> {
  assertEnabled()
  const [row] = await db
    .select({ production: schema.agent_conversations.production })
    .from(schema.agent_conversations)
    .where(owned(conversationId, userId))
  if (!row) throw new ProductionError('production_not_found')
  return row.production
}
export async function writeProduction(
  conversationId: string,
  userId: string,
  mutation: ProductionMutation,
  source: 'user' | 'agent' | 'restore',
  turnId?: string,
): Promise<ProductionRecord> {
  assertEnabled()
  if (
    !validateProductionContent(mutation.content) ||
    !Number.isSafeInteger(mutation.baseRevision) ||
    mutation.baseRevision < 0 ||
    !mutation.operationId ||
    mutation.operationId.length > 128
  )
    throw new ProductionError('production_invalid')
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ production: schema.agent_conversations.production })
      .from(schema.agent_conversations)
      .where(owned(conversationId, userId))
      .for('update')
    if (!row) throw new ProductionError('production_not_found')
    const current = row.production
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([mutation.baseRevision, mutation.content, source]))
      .digest('hex')
    const receipt = current?.receipts.find((r) => r.operationId === mutation.operationId)
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new ProductionError('production_operation_reused', current?.document)
      return current!
    }
    if ((current?.document.revision ?? 0) !== mutation.baseRevision)
      throw new ProductionError('production_conflict', current?.document)
    const [project] = await tx
      .select({ id: schema.canvas_projects.id })
      .from(schema.canvas_projects)
      .where(
        and(
          eq(schema.canvas_projects.conversation_id, conversationId),
          eq(schema.canvas_projects.user_id, userId),
          isNull(schema.canvas_projects.deleted_at),
        ),
      )
      .limit(1)
    const now = Date.now()
    const revision = mutation.baseRevision + 1
    const record: ProductionRecord = {
      document: {
        id: current?.document.id ?? crypto.randomUUID(),
        conversationId,
        projectId: project?.id ?? null,
        revision,
        content: mutation.content,
        updatedAt: now,
      },
      history: [
        ...(current?.history ?? []),
        {
          revision,
          content: mutation.content,
          source,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        },
      ].slice(-PRODUCTION_HISTORY_MAX),
      receipts: [
        ...(current?.receipts ?? []),
        { operationId: mutation.operationId, fingerprint, revision },
      ].slice(-PRODUCTION_RECEIPTS_MAX),
    }
    await tx
      .update(schema.agent_conversations)
      .set({ production: record, updated_at: now })
      .where(owned(conversationId, userId))
    return record
  })
}

export async function restoreProduction(
  conversationId: string,
  userId: string,
  input: { operationId: string; baseRevision: number; revision: number },
): Promise<ProductionRecord> {
  const record = await readProduction(conversationId, userId)
  const previous = record?.history.find((item) => item.revision === input.revision)
  if (!previous) throw new ProductionError('production_not_found')
  return writeProduction(
    conversationId,
    userId,
    { operationId: input.operationId, baseRevision: input.baseRevision, content: previous.content },
    'restore',
  )
}
