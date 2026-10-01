import { createHash } from 'node:crypto'
import {
  PRODUCTION_HISTORY_MAX,
  PRODUCTION_PROPOSALS_MAX,
  PRODUCTION_RECEIPTS_MAX,
  PRODUCTION_SCENES_MAX,
  PRODUCTION_TEXT_MAX_CHARS,
  type ProductionContent,
  type ProductionContext,
  type ProductionMutation,
  type ProductionProposal,
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
    super(
      code === 'production_conflict'
        ? '文稿已更新，请重新选择引用或检查当前版本；原文没有被覆盖。'
        : code,
    )
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
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ production: schema.agent_conversations.production })
      .from(schema.agent_conversations)
      .where(owned(conversationId, userId))
      .for('update')
    if (!row) throw new ProductionError('production_not_found')
    const current = row.production
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
    const record = applyProductionMutation(
      current,
      mutation,
      source,
      conversationId,
      project?.id ?? null,
      turnId,
    )
    await tx
      .update(schema.agent_conversations)
      .set({ production: record, updated_at: record.document.updatedAt })
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

export function applyProductionMutation(
  current: ProductionRecord | null,
  mutation: ProductionMutation,
  source: 'user' | 'agent' | 'restore',
  conversationId: string,
  projectId: string | null,
  turnId?: string,
): ProductionRecord {
  if (
    !validateProductionContent(mutation.content) ||
    !Number.isSafeInteger(mutation.baseRevision) ||
    mutation.baseRevision < 0 ||
    !mutation.operationId ||
    mutation.operationId.length > 128
  )
    throw new ProductionError('production_invalid')

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
  const now = Date.now()
  const revision = mutation.baseRevision + 1
  const record: ProductionRecord = {
    ...current,
    document: {
      id: current?.document.id ?? crypto.randomUUID(),
      conversationId,
      projectId: projectId,
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
  return record
}

export async function proposeProductionEdit(
  conversationId: string,
  userId: string,
  context: ProductionContext,
  replacement: string,
  sourceTurnId: string,
  operationId: string,
): Promise<ProductionProposal> {
  let proposed: ProductionProposal | undefined
  await updateProductionRecord(conversationId, userId, (record) => {
    const id = createHash('sha256').update(operationId).digest('hex')
    const replay = record.proposals?.find((proposal) => proposal.id === id)
    if (replay) {
      proposed = replay
      return record
    }
    if (record.document.id !== context.documentId || record.document.revision !== context.revision)
      throw new ProductionError('production_conflict', record.document)
    const before = productionTargetText(record.document.content, context)
    let after = replacement
    if (context.quote) {
      const { start, end, text } = context.quote
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > before.length ||
        before.slice(start, end) !== text
      )
        throw new ProductionError('production_conflict', record.document)
      after = before.slice(0, start) + replacement + before.slice(end)
    }
    const content = replaceProductionTarget(record.document.content, context, after)
    if (!validateProductionContent(content)) throw new ProductionError('production_invalid')
    const proposals = record.proposals ?? []
    const pending = proposals.filter((proposal) => proposal.status === 'pending')
    if (pending.length >= PRODUCTION_PROPOSALS_MAX) throw new ProductionError('production_invalid')
    proposed = {
      id,
      baseRevision: context.revision,
      target: context.target,
      ...(context.sceneId ? { sceneId: context.sceneId } : {}),
      before,
      after,
      sourceTurnId,
      status: 'pending',
      createdAt: Date.now(),
    }
    const retainedSlots = PRODUCTION_PROPOSALS_MAX - pending.length - 1
    const completed =
      retainedSlots > 0
        ? proposals.filter((proposal) => proposal.status !== 'pending').slice(-retainedSlots)
        : []
    return { ...record, proposals: [...pending, ...completed, proposed] }
  })
  return proposed!
}

function productionTargetText(
  content: ProductionContent,
  target: Pick<ProductionContext, 'target' | 'sceneId'>,
): string {
  if (target.target === 'setting') return content.setting
  if (target.target === 'outline') return content.outline
  const scene = content.scenes.find((scene) => scene.id === target.sceneId)
  if (!scene || target.target !== 'scene') throw new ProductionError('production_invalid')
  return scene.body
}
function replaceProductionTarget(
  content: ProductionContent,
  target: Pick<ProductionContext, 'target' | 'sceneId'>,
  text: string,
): ProductionContent {
  productionTargetText(content, target)
  return target.target === 'scene'
    ? {
        ...content,
        scenes: content.scenes.map((scene) =>
          scene.id === target.sceneId ? { ...scene, body: text } : scene,
        ),
      }
    : { ...content, [target.target]: text }
}

export async function updateProductionRecord(
  conversationId: string,
  userId: string,
  change: (record: ProductionRecord) => ProductionRecord,
): Promise<ProductionRecord> {
  assertEnabled()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ production: schema.agent_conversations.production })
      .from(schema.agent_conversations)
      .where(owned(conversationId, userId))
      .for('update')
    if (!row?.production) throw new ProductionError('production_not_found')
    const updated = change(row.production)
    await tx
      .update(schema.agent_conversations)
      .set({ production: updated, updated_at: Date.now() })
      .where(owned(conversationId, userId))
    return updated
  })
}

export async function adoptProductionProposal(
  conversationId: string,
  userId: string,
  proposalId: string,
  input: { operationId: string; baseRevision: number },
): Promise<ProductionRecord> {
  return updateProductionRecord(conversationId, userId, (record) => {
    const proposal = record.proposals?.find((proposal) => proposal.id === proposalId)
    if (!proposal) throw new ProductionError('production_not_found')
    if (proposal.status === 'adopted') return record
    if (
      proposal.status !== 'pending' ||
      proposal.baseRevision !== input.baseRevision ||
      productionTargetText(record.document.content, proposal) !== proposal.before
    )
      throw new ProductionError('production_conflict', record.document)
    const next = applyProductionMutation(
      record,
      {
        ...input,
        content: replaceProductionTarget(record.document.content, proposal, proposal.after),
      },
      'agent',
      record.document.conversationId,
      record.document.projectId,
      proposal.sourceTurnId,
    )
    return {
      ...next,
      proposals: record.proposals?.map((item) =>
        item.id === proposalId
          ? { ...item, status: 'adopted', adoptedRevision: next.document.revision }
          : item,
      ),
    }
  })
}
export async function discardProductionProposal(
  conversationId: string,
  userId: string,
  proposalId: string,
): Promise<ProductionRecord> {
  return updateProductionRecord(conversationId, userId, (record) => {
    const proposal = record.proposals?.find((item) => item.id === proposalId)
    if (!proposal) throw new ProductionError('production_not_found')
    if (proposal.status === 'adopted')
      throw new ProductionError('production_conflict', record.document)
    return {
      ...record,
      proposals: record.proposals?.map((item) =>
        item.id === proposalId ? { ...item, status: 'discarded' } : item,
      ),
    }
  })
}
