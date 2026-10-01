import type {
  ProductionDocument,
  ProductionGenerationDraftInput,
  ProductionGenerationView,
} from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { ProductionRequestError } from './productionClient'

export async function generationRequest<T>(
  conversationId: string,
  suffix: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await authenticatedBffFetch(
    `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(conversationId)}/production/generations${suffix}`,
    {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      current?: ProductionDocument
    }
    throw new ProductionRequestError(body.error ?? 'production_unavailable', body.current)
  }
  return response.json() as Promise<T>
}
export function listGenerations(conversationId: string, signal?: AbortSignal) {
  return generationRequest<{ generations: readonly ProductionGenerationView[] }>(
    conversationId,
    '',
    { signal, cache: 'no-store' },
  )
}
export function adoptGeneration(
  conversationId: string,
  draftId: string,
  body: { operationId: string; baseRevision: number; artifactId: string },
) {
  return generationRequest<{ document: ProductionDocument }>(
    conversationId,
    `/${encodeURIComponent(draftId)}/adopt`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )
}
export type GenerationFields = Pick<
  ProductionGenerationView,
  'prompt' | 'model' | 'params' | 'video' | 'references'
>
export function editGeneration(
  conversationId: string,
  draftId: string,
  draftRevision: number,
  fields: GenerationFields,
) {
  return generationRequest<{ generation: ProductionGenerationView }>(
    conversationId,
    `/${encodeURIComponent(draftId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, draftRevision }),
    },
  )
}

export function createGeneration(conversationId: string, input: ProductionGenerationDraftInput) {
  return generationRequest<{ generation: ProductionGenerationView }>(conversationId, '', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}
