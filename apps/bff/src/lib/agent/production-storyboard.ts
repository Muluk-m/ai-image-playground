import { createHash } from 'node:crypto'
import type {
  ProductionContext,
  ProductionShot,
  ProductionStoryboardProposal,
} from '@image-playground/shared'
import { PRODUCTION_PROPOSALS_MAX } from '@image-playground/shared'
import {
  applyProductionMutation,
  ProductionError,
  updateProductionRecord,
  validateProductionContent,
} from './production'
import { productionMediaReferences, productionReferenceKey } from './production-asset-validation'
import { validateProductionMediaReferences } from './production-references'
import { hasValidProductionShotReferences } from './production-shot-validation'

export async function proposeProductionStoryboard(
  conversationId: string,
  userId: string,
  input: { baseRevision: number; shots: readonly ProductionShot[] },
  turnId: string,
  operationId: string,
  context?: ProductionContext,
): Promise<ProductionStoryboardProposal> {
  const id = createHash('sha256').update(operationId).digest('hex')
  const record = await updateProductionRecord(conversationId, userId, async (current, tx) => {
    const replay = current.storyboardProposals?.find((item) => item.id === id)
    if (replay) return current
    if (current.document.revision !== input.baseRevision)
      throw new ProductionError('production_conflict', current.document)
    const existing = current.document.content.shots ?? []
    if (existing.length > 0) {
      if (
        !context ||
        context.documentId !== current.document.id ||
        context.revision !== input.baseRevision ||
        (context.target !== 'shot' && context.target !== 'shots')
      )
        throw new ProductionError('production_invalid')
      if (context.target === 'shot') {
        if (
          !context.shotId ||
          !existing.some((shot) => shot.id === context.shotId) ||
          input.shots.length !== existing.length ||
          input.shots.some(
            (shot, index) =>
              shot.id !== existing[index]?.id ||
              (shot.id !== context.shotId &&
                canonical({ ...shot, dependencies: undefined }) !==
                  canonical({ ...existing[index], dependencies: undefined })),
          )
        )
          throw new ProductionError('production_invalid')
      }
    }
    if (
      !validateProductionContent({ ...current.document.content, shots: input.shots }) ||
      !hasValidProductionShotReferences(
        current.document.content,
        input.shots,
        current.document.content.shots,
      )
    )
      throw new ProductionError('production_invalid')
    const knownReferences = new Set(
      productionMediaReferences(current.document.content).map(productionReferenceKey),
    )
    const newReferences = input.shots
      .flatMap((shot) => (shot.keyframe ? [shot.keyframe] : []))
      .filter((reference) => !knownReferences.has(productionReferenceKey(reference)))
    if (!(await validateProductionMediaReferences(conversationId, userId, newReferences, tx)))
      throw new ProductionError('production_invalid')
    const pending = (current.storyboardProposals ?? []).filter((item) => item.status === 'pending')
    if (pending.length >= PRODUCTION_PROPOSALS_MAX) throw new ProductionError('production_invalid')
    const proposal: ProductionStoryboardProposal = {
      id,
      baseRevision: input.baseRevision,
      shots: input.shots,
      sourceTurnId: turnId,
      status: 'pending',
      createdAt: Date.now(),
    }
    const remaining = PRODUCTION_PROPOSALS_MAX - pending.length - 1
    const completed =
      remaining > 0
        ? (current.storyboardProposals ?? [])
            .filter((item) => item.status !== 'pending')
            .slice(-remaining)
        : []
    return { ...current, storyboardProposals: [...pending, ...completed, proposal] }
  })
  return record.storyboardProposals!.find((item) => item.id === id)!
}

export async function adoptProductionStoryboard(
  conversationId: string,
  userId: string,
  proposalId: string,
  input: { operationId: string; baseRevision: number },
) {
  return updateProductionRecord(conversationId, userId, (current) => {
    const proposal = current.storyboardProposals?.find((item) => item.id === proposalId)
    if (!proposal) throw new ProductionError('production_not_found')
    if (proposal.status === 'adopted') return current
    if (proposal.status !== 'pending' || proposal.baseRevision !== input.baseRevision)
      throw new ProductionError('production_conflict', current.document)
    if (
      !hasValidProductionShotReferences(
        current.document.content,
        proposal.shots,
        current.document.content.shots,
      )
    )
      throw new ProductionError('production_invalid')
    const updated = applyProductionMutation(
      current,
      { ...input, content: { ...current.document.content, shots: proposal.shots } },
      'agent',
      conversationId,
      current.document.projectId,
      proposal.sourceTurnId,
    )
    return {
      ...updated,
      storyboardProposals: current.storyboardProposals?.map((item) =>
        item.id === proposalId
          ? { ...item, status: 'adopted', adoptedRevision: updated.document.revision }
          : item,
      ),
    }
  })
}
export async function discardProductionStoryboard(
  conversationId: string,
  userId: string,
  proposalId: string,
) {
  return updateProductionRecord(conversationId, userId, (current) => {
    const proposal = current.storyboardProposals?.find((item) => item.id === proposalId)
    if (!proposal) throw new ProductionError('production_not_found')
    if (proposal.status === 'adopted')
      throw new ProductionError('production_conflict', current.document)
    return {
      ...current,
      storyboardProposals: current.storyboardProposals?.map((item) =>
        item.id === proposalId ? { ...item, status: 'discarded' } : item,
      ),
    }
  })
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, one]) => `${JSON.stringify(key)}:${canonical(one)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
