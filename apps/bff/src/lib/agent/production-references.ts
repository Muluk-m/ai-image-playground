import {
  type ProductionContent,
  type ProductionMediaReference,
  parseProjectArtifactId,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { resolveImageBytesRef } from '../extractImages'
import type { BffTransaction } from '../private-overlay'
import { asQueueProvider } from '../queueProvider'
import { taskAccessWhere } from '../task-access'
import { productionMediaReferences, productionReferenceKey } from './production-asset-validation'

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
      const [asset] = await executor
        .select({
          id: schema.user_asset_objects.image_id,
          contentType: schema.user_asset_objects.content_type,
        })
        .from(schema.user_asset_objects)
        .where(
          and(
            eq(schema.user_asset_objects.image_id, reference.imageId),
            eq(schema.user_asset_objects.user_id, userId),
          ),
        )
        .limit(1)
      if (!asset?.contentType.startsWith(`${expectedMedia}/`)) return false
    } else {
      const parsed = parseProjectArtifactId(reference.artifactId)
      if (!parsed) return false
      const [task] = await executor
        .select({
          status: schema.tasks.status,
          provider: schema.tasks.provider,
          result: schema.tasks.result_payload,
        })
        .from(schema.tasks)
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
  if (!(await validateProductionMediaReferences(conversationId, userId, references, tx)))
    return false
  const mediaIds = [
    ...new Set(
      references.flatMap((reference) => (reference.kind === 'media' ? [reference.mediaId] : [])),
    ),
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
