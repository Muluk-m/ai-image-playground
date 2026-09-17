import type { QueueProvider } from '@image-playground/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '../db/client'
import { extractMeta, resolveImageBytesRef } from './extractImages'
import { objectStore } from './objectStore'
import type { BffTransaction } from './private-overlay'
import { lockMediaOwner, storeMedia } from './projectMedia'

export interface GenerationMediaLink {
  role: 'input' | 'mask' | 'output'
  position: number
  mediaId: string
}

/** Keep retrievable source URLs before any download; large inline originals stay out of PostgreSQL. */
export function generationSourceCheckpoint(provider: QueueProvider, payload: unknown) {
  if (provider !== 'openai-compat') return null
  const meta = extractMeta(provider, payload)
  const refs = meta.images.map((image) => resolveImageBytesRef(provider, payload, image.index))
  if (!refs.length || refs.some((ref) => ref?.kind !== 'url')) return null
  return { ...meta.actual_params, data: refs.map((ref) => ({ url: ref!.data, mime: ref!.mime })) }
}

export async function archiveGenerationOutputs(
  userId: string,
  provider: QueueProvider,
  payload: unknown,
) {
  const links: GenerationMediaLink[] = []
  for (const image of extractMeta(provider, payload).images) {
    const source = resolveImageBytesRef(provider, payload, image.index)
    if (!source || !source.mime.startsWith('image/')) throw new Error('generation_image_missing')
    const bytes =
      source.kind === 'object'
        ? await objectStore().read(source.data)
        : source.kind === 'b64'
          ? Buffer.from(source.data, 'base64')
          : null
    if (!bytes) throw new Error('generation_image_not_archived')
    const media = await storeMedia(userId, bytes, source.mime)
    links.push({ role: 'output', position: image.index, mediaId: media.id })
  }
  return links
}

export async function publishGenerationImages(
  tx: BffTransaction,
  userId: string,
  id: string,
  links: GenerationMediaLink[],
) {
  if (!links.length) return
  await lockMediaOwner(tx, userId)
  const ids = [...new Set(links.map((link) => link.mediaId))]
  const owned = await tx
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
        inArray(schema.media_objects.id, ids),
      ),
    )
  if (owned.length !== ids.length) throw new Error('generation_media_not_ready')
  await tx
    .insert(schema.generation_images)
    .values(
      links.map((link) => ({
        generation_id: id,
        role: link.role,
        position: link.position,
        media_id: link.mediaId,
      })),
    )
    .onConflictDoNothing()
  await tx
    .insert(schema.media_references)
    .values(
      ids.map((mediaId) => ({
        user_id: userId,
        media_id: mediaId,
        owner_kind: 'generation' as const,
        owner_id: id,
        created_at: Date.now(),
      })),
    )
    .onConflictDoNothing()
}
