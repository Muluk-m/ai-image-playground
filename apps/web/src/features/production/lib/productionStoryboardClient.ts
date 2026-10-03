import type { ProductionStoryboardProposal } from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { ProductionRequestError, type ProductionResponse } from './productionClient'

export interface StoryboardResponse extends ProductionResponse {
  storyboardProposals: readonly ProductionStoryboardProposal[]
}

async function storyboardRequest(
  conversationId: string,
  suffix: string,
  body?: { operationId: string; baseRevision: number },
): Promise<StoryboardResponse> {
  const response = await authenticatedBffFetch(
    `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(conversationId)}/production${suffix}`,
    {
      method: suffix.startsWith('?') ? 'GET' : 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    },
  )
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string }
    throw new ProductionRequestError(error.error ?? 'production_unavailable')
  }
  return response.json() as Promise<StoryboardResponse>
}
export const fetchStoryboards = (conversationId: string) =>
  storyboardRequest(conversationId, '?storyboard=true')
export const adoptStoryboard = (conversationId: string, id: string, baseRevision: number) =>
  storyboardRequest(conversationId, `/storyboard/${encodeURIComponent(id)}/adopt`, {
    operationId: crypto.randomUUID(),
    baseRevision,
  })
export const discardStoryboard = (conversationId: string, id: string) =>
  storyboardRequest(conversationId, `/storyboard/${encodeURIComponent(id)}/discard`)
