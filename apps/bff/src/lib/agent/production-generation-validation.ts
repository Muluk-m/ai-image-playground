import type { AgentDraftSubmission } from '@image-playground/db'
import type { ProductionGenerationDraftInput } from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { modelCapabilities } from '../channels'
import { ProductionError } from './production'
import { validateProductionMediaReferences } from './production-references'
export function validateImageParameters(
  model: string,
  provider: string,
  params: ProductionGenerationDraftInput['params'],
  referenceCount: number,
) {
  const capabilities = modelCapabilities(model)
  if (!capabilities?.includes('generate') || (referenceCount > 0 && !capabilities.includes('edit')))
    throw new ProductionError('production_invalid')
  if (!params) return
  if (
    params.quality &&
    params.quality !== 'auto' &&
    (!capabilities.includes('quality') || !['low', 'medium', 'high'].includes(params.quality))
  )
    throw new ProductionError('production_invalid')
  if (
    params.size &&
    params.size !== 'auto' &&
    (!capabilities.includes('size') || !/^\d{2,5}x\d{2,5}$/.test(params.size))
  )
    throw new ProductionError('production_invalid')
  if (params.output_format && !['png', 'jpeg', 'webp'].includes(params.output_format))
    throw new ProductionError('production_invalid')
  if (
    params.output_compression !== undefined &&
    (!Number.isInteger(params.output_compression) ||
      params.output_compression < 0 ||
      params.output_compression > 100 ||
      !['jpeg', 'webp'].includes(params.output_format ?? ''))
  )
    throw new ProductionError('production_invalid')
  if (
    provider === 'openai-compat' &&
    (params.gemini_aspect_ratio || params.gemini_image_size || params.gemini_thinking_level)
  )
    throw new ProductionError('production_invalid')
  if (provider === 'gemini') {
    if (params.output_format || params.output_compression !== undefined)
      throw new ProductionError('production_invalid')
    if (
      params.gemini_aspect_ratio &&
      !['1:1', '16:9', '9:16', '4:3', '3:4'].includes(params.gemini_aspect_ratio)
    )
      throw new ProductionError('production_invalid')
    if (params.gemini_image_size && !['1K', '2K', '4K'].includes(params.gemini_image_size))
      throw new ProductionError('production_invalid')
    if (
      params.gemini_thinking_level &&
      !['minimal', 'low', 'medium', 'high'].includes(params.gemini_thinking_level)
    )
      throw new ProductionError('production_invalid')
  }
}

export async function validateProductionConfirmation(
  conversationId: string,
  userId: string | null,
  submission: AgentDraftSubmission,
  executor: Pick<typeof db, 'select'> = db,
): Promise<boolean> {
  const binding = submission.production
  if (!binding) return true
  if (!userId || !isCapabilityEnabled('agent:production')) return false
  const [conversation] = await executor
    .select({ production: schema.agent_conversations.production })
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, conversationId),
        eq(schema.agent_conversations.user_id, userId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
    .limit(1)
  const document = conversation?.production?.document
  if (!document || document.id !== binding.documentId) return false
  const target =
    binding.target === 'look'
      ? document.content.characters
          ?.flatMap((character) => character.looks)
          .find((look) => look.id === binding.targetId)
      : binding.target === 'location'
        ? document.content.locations?.find((location) => location.id === binding.targetId)
        : undefined
  if (
    !target ||
    target.description !== binding.snapshot.description ||
    JSON.stringify(target.reference ? [target.reference] : []) !==
      JSON.stringify(binding.snapshot.references)
  )
    return false
  return validateProductionMediaReferences(
    conversationId,
    userId,
    (submission.productionReferences ?? []).map((item) => item.reference),
    executor,
  )
}
