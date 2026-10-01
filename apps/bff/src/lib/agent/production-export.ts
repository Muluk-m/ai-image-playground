import { type ProductionMediaReference, parseProjectArtifactId } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { durableMediaStore } from '../durableMediaStore'
import { resolveImageBytesRef } from '../extractImages'
import { type ObjectRangeReader, objectStore } from '../objectStore'
import { asQueueProvider } from '../queueProvider'
import { assetObjectKey } from '../sync-assets'
import { taskAccessWhere } from '../task-access'
import { ProductionError, readProduction } from './production'
import { productionMediaReferences, productionReferenceKey } from './production-asset-validation'

export const PRODUCTION_EXPORT_BATCH_MAX = 500
interface ExportOriginal {
  mime: string | null
  reader: ObjectRangeReader | null
}
function missing(mime: string | null = null): ExportOriginal {
  return { mime, reader: null }
}
function notFound(): never {
  throw new ProductionError('production_not_found')
}

/** Authorize all requested identities before touching object storage or returning any metadata. */
async function authorizeExport(
  conversationId: string,
  userId: string,
  revision: number,
  references: readonly ProductionMediaReference[],
) {
  const record = await readProduction(conversationId, userId)
  if (!record) return notFound()
  const snapshot =
    record.document.revision === revision
      ? record.document
      : record.history.find((item) => item.revision === revision)
  if (!snapshot) return notFound()
  const allowed = new Set(productionMediaReferences(snapshot.content).map(productionReferenceKey))
  for (const clip of snapshot.content.clips ?? [])
    if (clip.adopted)
      allowed.add(productionReferenceKey({ kind: 'artifact', artifactId: clip.adopted.artifactId }))
  for (const reference of references) {
    if (allowed.has(productionReferenceKey(reference))) continue
    if (reference.kind !== 'artifact') return notFound()
    const parsed = parseProjectArtifactId(reference.artifactId)
    if (!parsed) return notFound()
    const drafts = await db
      .select({ submission: schema.agent_generation_drafts.submission })
      .from(schema.agent_generation_drafts)
      .where(
        and(
          eq(schema.agent_generation_drafts.conversation_id, conversationId),
          eq(schema.agent_generation_drafts.task_id, parsed.generationId),
        ),
      )
    const member = drafts.some(
      ({ submission }) =>
        submission?.production?.documentId === record.document.id &&
        submission.production.revision <= revision,
    )
    if (!member) return notFound()
    const [task] = await db
      .select({
        provider: schema.tasks.provider,
        result: schema.tasks.result_payload,
        status: schema.tasks.status,
      })
      .from(schema.tasks)
      .where(
        and(
          taskAccessWhere(parsed.generationId, userId),
          eq(schema.tasks.user_id, userId),
          eq(schema.tasks.agent_conversation_id, conversationId),
        ),
      )
      .limit(1)
    const provider = task && asQueueProvider(task.provider)
    if (
      !task ||
      task.status !== 'completed' ||
      !provider ||
      !resolveImageBytesRef(provider, task.result, parsed.position)
    )
      return notFound()
  }
}
async function openStored(key: string, mime: string, durable = false): Promise<ExportOriginal> {
  try {
    return { mime, reader: await (durable ? durableMediaStore() : objectStore()).open(key) }
  } catch {
    return missing(mime)
  }
}
/** Legacy inline payloads are decoded one aligned base64 chunk at a time, never one whole video. */
function base64Reader(data: string): ObjectRangeReader | null {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null
  const size = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  return {
    size,
    stream: () => {
      let offset = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= data.length) {
            controller.close()
            return
          }
          const end = Math.min(offset + 65536, data.length)
          controller.enqueue(Buffer.from(data.slice(offset, end), 'base64'))
          offset = end
        },
      })
    },
  }
}
async function exportOriginal(
  conversationId: string,
  userId: string,
  reference: ProductionMediaReference,
): Promise<ExportOriginal> {
  if (reference.kind === 'media') {
    const [media] = await db
      .select()
      .from(schema.media_objects)
      .where(eq(schema.media_objects.id, reference.mediaId))
      .limit(1)
    if (!media) return missing()
    if (media.user_id !== userId) return notFound()
    return media.status === 'ready' && media.object_key
      ? openStored(media.object_key, media.content_type, true)
      : missing(media.content_type)
  }
  if (reference.kind === 'asset') {
    const [asset] = await db
      .select({ mime: schema.user_asset_objects.content_type })
      .from(schema.user_asset_objects)
      .where(
        and(
          eq(schema.user_asset_objects.user_id, userId),
          eq(schema.user_asset_objects.image_id, reference.imageId),
        ),
      )
      .limit(1)
    return asset ? openStored(assetObjectKey(userId, reference.imageId), asset.mime) : missing()
  }
  const parsed = parseProjectArtifactId(reference.artifactId)
  if (!parsed) return notFound()
  const [task] = await db
    .select({
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result: schema.tasks.result_payload,
    })
    .from(schema.tasks)
    .where(
      and(
        taskAccessWhere(parsed.generationId, userId),
        eq(schema.tasks.user_id, userId),
        eq(schema.tasks.agent_conversation_id, conversationId),
      ),
    )
    .limit(1)
  if (!task || task.status !== 'completed') return missing()
  const provider = asQueueProvider(task.provider)
  const result = provider && resolveImageBytesRef(provider, task.result, parsed.position)
  if (!result) return missing()
  if (result.kind === 'object')
    return openStored(result.data, result.mime, result.store === 'durable')
  if (result.kind === 'b64') return { mime: result.mime, reader: base64Reader(result.data) }
  return missing(result.mime)
}
export async function inspectProductionExport(
  conversationId: string,
  userId: string,
  revision: number,
  references: readonly ProductionMediaReference[],
) {
  await authorizeExport(conversationId, userId, revision, references)
  const items = []
  for (let start = 0; start < references.length; start += 8) {
    items.push(
      ...(await Promise.all(
        references.slice(start, start + 8).map(async (reference) => {
          const original = await exportOriginal(conversationId, userId, reference)
          return {
            reference,
            bytes: original.reader?.size ?? null,
            mime: original.mime,
            status: original.reader ? ('available' as const) : ('missing' as const),
          }
        }),
      )),
    )
  }
  return { items }
}
export async function streamProductionExport(
  conversationId: string,
  userId: string,
  revision: number,
  reference: ProductionMediaReference,
  download = false,
) {
  await authorizeExport(conversationId, userId, revision, [reference])
  const original = await exportOriginal(conversationId, userId, reference)
  if (!original.reader) return notFound()
  const mime =
    original.mime && /^(image|video)\/[a-z0-9.+-]+$/i.test(original.mime)
      ? original.mime
      : 'application/octet-stream'
  const name = productionReferenceKey(reference).replace(/[^a-zA-Z0-9._-]/g, '_')
  return new Response(
    original.reader.size ? original.reader.stream(0, original.reader.size - 1) : null,
    {
      headers: {
        'content-type': mime,
        'content-length': String(original.reader.size),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
      },
    },
  )
}
