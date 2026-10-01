import { createHash } from 'node:crypto'
import {
  PRODUCTION_PROPOSALS_MAX,
  type ProductionAssetProposal,
  type ProductionCharacter,
  type ProductionLocation,
  type ProductionMediaReference,
  type ProductionRecord,
} from '@image-playground/shared'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { decodeDataUrl } from '../imageArchive'
import { readAssetImage } from '../sync-assets'
import { createAgentImageSource, readConversationMedia } from './images'
import {
  applyProductionMutation,
  ProductionError,
  readProduction,
  updateProductionRecord,
  validateProductionContent,
} from './production'
import { productionMediaReferences, productionReferenceKey } from './production-asset-validation'
import { validateProductionMediaReferences } from './production-references'

export async function proposeProductionAssets(
  conversationId: string,
  userId: string,
  input: {
    baseRevision: number
    characters: readonly ProductionCharacter[]
    locations: readonly ProductionLocation[]
  },
  sourceTurnId: string,
  operationId: string,
): Promise<ProductionAssetProposal> {
  let result: ProductionAssetProposal | undefined
  await updateProductionRecord(conversationId, userId, async (record, tx) => {
    const id = createHash('sha256').update(operationId).digest('hex')
    const replay = record.assetProposals?.find((proposal) => proposal.id === id)
    if (replay) {
      result = replay
      return record
    }
    if (record.document.revision !== input.baseRevision)
      throw new ProductionError('production_conflict', record.document)
    const content = {
      ...record.document.content,
      characters: input.characters,
      locations: input.locations,
    }
    if (
      !validateProductionContent(content) ||
      !(await validateProductionMediaReferences(
        conversationId,
        userId,
        productionMediaReferences(content),
        tx,
      ))
    )
      throw new ProductionError('production_invalid')
    const proposals = record.assetProposals ?? []
    const pending = proposals.filter((proposal) => proposal.status === 'pending')
    if (pending.length >= PRODUCTION_PROPOSALS_MAX) throw new ProductionError('production_invalid')
    result = { id, ...input, sourceTurnId, status: 'pending', createdAt: Date.now() }
    const slots = PRODUCTION_PROPOSALS_MAX - pending.length - 1
    const completed =
      slots > 0 ? proposals.filter((proposal) => proposal.status !== 'pending').slice(-slots) : []
    return { ...record, assetProposals: [...pending, ...completed, result] }
  })
  return result!
}
export async function adoptProductionAssets(
  conversationId: string,
  userId: string,
  proposalId: string,
  input: { operationId: string; baseRevision: number },
): Promise<ProductionRecord> {
  return updateProductionRecord(conversationId, userId, (record) => {
    const proposal = record.assetProposals?.find((item) => item.id === proposalId)
    if (!proposal) throw new ProductionError('production_not_found')
    if (proposal.status === 'adopted') return record
    if (proposal.status !== 'pending' || proposal.baseRevision !== input.baseRevision)
      throw new ProductionError('production_conflict', record.document)
    const next = applyProductionMutation(
      record,
      {
        ...input,
        content: {
          ...record.document.content,
          characters: proposal.characters,
          locations: proposal.locations,
        },
      },
      'agent',
      conversationId,
      record.document.projectId,
      proposal.sourceTurnId,
    )
    return {
      ...next,
      assetProposals: record.assetProposals?.map((item) =>
        item.id === proposalId
          ? { ...item, status: 'adopted', adoptedRevision: next.document.revision }
          : item,
      ),
    }
  })
}
export async function discardProductionAssets(
  conversationId: string,
  userId: string,
  proposalId: string,
): Promise<ProductionRecord> {
  return updateProductionRecord(conversationId, userId, (record) => {
    const proposal = record.assetProposals?.find((item) => item.id === proposalId)
    if (!proposal) throw new ProductionError('production_not_found')
    if (proposal.status === 'adopted')
      throw new ProductionError('production_conflict', record.document)
    return {
      ...record,
      assetProposals: record.assetProposals?.map((item) =>
        item.id === proposalId ? { ...item, status: 'discarded' } : item,
      ),
    }
  })
}
export async function previewProductionReference(
  conversationId: string,
  userId: string,
  reference: ProductionMediaReference,
): Promise<Response> {
  const record = await readProduction(conversationId, userId)
  if (!record) throw new ProductionError('production_not_found')
  const generationDrafts = await db
    .select({ submission: schema.agent_generation_drafts.submission })
    .from(schema.agent_generation_drafts)
    .where(eq(schema.agent_generation_drafts.conversation_id, conversationId))
    .orderBy(desc(schema.agent_generation_drafts.created_at))
    .limit(100)
  const allowed = [
    ...generationDrafts
      .filter((draft) => draft.submission.production?.documentId === record.document.id)
      .flatMap((draft) =>
        (draft.submission.productionReferences ?? []).map((one) => one.reference),
      ),
    ...productionMediaReferences(record.document.content),
    ...(record.storyboardProposals ?? [])
      .filter((proposal) => proposal.status === 'pending')
      .flatMap((proposal) =>
        proposal.shots.flatMap((shot) => (shot.keyframe ? [shot.keyframe] : [])),
      ),
    ...(record.assetProposals ?? [])
      .filter((proposal) => proposal.status === 'pending')
      .flatMap((proposal) =>
        productionMediaReferences({
          ...record.document.content,
          characters: proposal.characters,
          locations: proposal.locations,
        }),
      ),
  ]
  if (
    !allowed.some(
      (candidate) => productionReferenceKey(candidate) === productionReferenceKey(reference),
    )
  )
    throw new ProductionError('production_not_found')
  try {
    if (!(await validateProductionMediaReferences(conversationId, userId, [reference])))
      throw new Error('missing')
    let image: { bytes: Uint8Array; contentType: string } | null
    if (reference.kind === 'asset') image = await readAssetImage(userId, reference.imageId)
    else if (reference.kind === 'media')
      image = await readConversationMedia(
        reference.mediaId,
        conversationId,
        userId,
        'preview',
        true,
      )
    else {
      const resolved = await createAgentImageSource({
        conversationId,
        userId,
        references: [],
        history: [],
      }).resolve(reference.artifactId, 'preview')
      const decoded = resolved && decodeDataUrl(resolved.dataUrl)
      image = decoded ? { bytes: decoded.bytes, contentType: decoded.mime } : null
    }
    if (!image || !image.contentType.startsWith('image/')) throw new Error('missing')
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        'Content-Type': image.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    throw new ProductionError('production_not_found')
  }
}
