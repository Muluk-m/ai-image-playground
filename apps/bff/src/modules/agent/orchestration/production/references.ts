import { resolvedTaskResultPayload } from '@image-playground/db'
import {
  type ProductionContent,
  type ProductionMediaReference,
  parseProjectArtifactId,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../../../db/client'
import { resolveImageBytesRef } from '../../../../lib/extractImages'
import type { BffTransaction } from '../../../../lib/private-overlay'
import { lockMediaOwner } from '../../../../lib/projectMedia'
import { asQueueProvider } from '../../../../lib/queueProvider'
import { ensureAssetMediaIds, findAssetImageMeta } from '../../../../lib/sync-assets'
import { taskAccessWhere } from '../../../../lib/task-access'
import { productionMediaReferences, productionReferenceKey } from './asset-validation'

export async function validateProductionMediaReferences(
  conversationId: string,
  userId: string,
  references: readonly ProductionMediaReference[],
  executor: Pick<typeof db, 'select'> = db,
  expectedMedia: 'image' | 'video' = 'image',
): Promise<boolean> {
  for (const reference of references) {
    if (reference.kind === 'media') {
      const [media] = await executor
        .select({ id: schema.media_objects.id, contentType: schema.media_objects.content_type })
        .from(schema.media_objects)
        .where(
          and(
            eq(schema.media_objects.id, reference.mediaId),
            eq(schema.media_objects.user_id, userId),
            eq(schema.media_objects.status, 'ready'),
          ),
        )
        .for('share')
        .limit(1)
      if (!media?.contentType.startsWith(`${expectedMedia}/`)) return false
    } else if (reference.kind === 'asset') {
      const asset = await findAssetImageMeta(executor, userId, reference.imageId, {
        lockShare: true,
      })
      if (!asset?.contentType.startsWith(`${expectedMedia}/`)) return false
    } else {
      const parsed = parseProjectArtifactId(reference.artifactId)
      if (!parsed) return false
      const [task] = await executor
        .select({
          status: schema.tasks.status,
          provider: schema.tasks.provider,
          result: resolvedTaskResultPayload,
        })
        .from(schema.tasks)
        .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
        .where(
          and(
            taskAccessWhere(parsed.generationId, userId),
            eq(schema.tasks.agent_conversation_id, conversationId),
          ),
        )
        .limit(1)
      const provider = task && asQueueProvider(task.provider)
      if (
        !task ||
        task.status !== 'completed' ||
        !provider ||
        !resolveImageBytesRef(provider, task.result, parsed.position)?.mime.startsWith(
          `${expectedMedia}/`,
        )
      )
        return false
    }
  }
  return true
}

export async function reconcileProductionReferences(
  tx: BffTransaction,
  conversationId: string,
  userId: string,
  previous: ProductionContent | null,
  next: ProductionContent,
  historical: readonly ProductionMediaReference[] = [],
): Promise<boolean> {
  const existing = new Set(
    [...(previous ? productionMediaReferences(previous) : []), ...historical].map(
      productionReferenceKey,
    ),
  )
  const references = productionMediaReferences(next).filter(
    (reference) => !existing.has(productionReferenceKey(reference)),
  )
  if (references.some((reference) => reference.kind === 'asset' || reference.kind === 'media')) {
    await lockMediaOwner(tx, userId)
  }
  if (!(await validateProductionMediaReferences(conversationId, userId, references, tx)))
    return false
  const assetImageIds = [
    ...new Set(
      references.flatMap((reference) => (reference.kind === 'asset' ? [reference.imageId] : [])),
    ),
  ]
  const unifiedAssetMediaIds = assetImageIds.length
    ? [...(await ensureAssetMediaIds(tx, userId, assetImageIds)).values()]
    : []
  const mediaIds = [
    ...new Set([
      ...references.flatMap((reference) => (reference.kind === 'media' ? [reference.mediaId] : [])),
      ...unifiedAssetMediaIds,
    ]),
  ]
  if (mediaIds.length) {
    // Same ownership edge as attached conversation images; no copy or library asset is created.
    await tx
      .insert(schema.media_references)
      .values(
        mediaIds.map((mediaId) => ({
          user_id: userId,
          media_id: mediaId,
          owner_kind: 'conversation' as const,
          owner_id: conversationId,
          created_at: Date.now(),
        })),
      )
      .onConflictDoNothing()
  }
  return true
}
