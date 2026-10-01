import type {
  ProductionClipDependencyState,
  ProductionDocument,
  ProductionMutation,
  ProductionProposal,
  ProductionRevision,
  ProductionShotDependencyState,
} from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

export interface ProductionResponse {
  shotDependencyStates?: readonly ProductionShotDependencyState[]
  dependencyStates?: readonly ProductionClipDependencyState[]
  proposals?: readonly ProductionProposal[]
  document: ProductionDocument | null
  history: readonly ProductionRevision[]
}

export class ProductionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly current?: ProductionDocument,
  ) {
    super(code)
  }
}

async function request(
  conversationId: string,
  suffix: string,
  init: RequestInit,
): Promise<ProductionResponse> {
  const response = await authenticatedBffFetch(
    `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(conversationId)}/production${suffix}`,
    {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      current?: ProductionDocument
    }
    throw new ProductionRequestError(body.error ?? 'production_unavailable', body.current)
  }
  return response.json() as Promise<ProductionResponse>
}

export function fetchProduction(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ProductionResponse> {
  return request(conversationId, '', { signal, cache: 'no-store' })
}

export function fetchProductionHistory(conversationId: string): Promise<ProductionResponse> {
  return request(conversationId, '?history=true', { cache: 'no-store' })
}

export function saveProduction(
  conversationId: string,
  mutation: ProductionMutation,
): Promise<ProductionResponse> {
  return request(conversationId, '', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mutation),
  })
}

export function restoreProduction(
  conversationId: string,
  operationId: string,
  baseRevision: number,
  revision: number,
): Promise<ProductionResponse> {
  return request(conversationId, '/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId, baseRevision, revision }),
  })
}

export function fetchProductionProposals(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ProductionResponse> {
  return request(conversationId, '?proposals=true', { signal, cache: 'no-store' })
}
export function adoptProductionProposal(
  conversationId: string,
  proposalId: string,
  operationId: string,
  baseRevision: number,
): Promise<ProductionResponse> {
  return request(conversationId, `/proposals/${encodeURIComponent(proposalId)}/adopt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId, baseRevision }),
  })
}
export function discardProductionProposal(
  conversationId: string,
  proposalId: string,
): Promise<ProductionResponse> {
  return request(conversationId, `/proposals/${encodeURIComponent(proposalId)}/discard`, {
    method: 'POST',
  })
}

export function refreshProductionDependencies(
  conversationId: string,
  target: { kind: 'shot' | 'clip'; id: string },
  baseRevision: number,
  operationId: string,
): Promise<ProductionResponse> {
  return request(
    conversationId,
    `/${target.kind === 'shot' ? 'shots' : 'clips'}/${encodeURIComponent(target.id)}/refresh`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision, operationId }),
    },
  )
}
