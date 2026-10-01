import type { ProductionAssetProposal } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import type { ProductionResponse } from './productionClient'

interface AssetResponse extends ProductionResponse {
  assetProposals?: readonly ProductionAssetProposal[]
}
export function useProductionAssets(
  conversationId: string | null,
  revision: number,
  refreshKey: string,
  onSaved: (next: ProductionResponse) => void,
) {
  const [state, setState] = useState<{
    owner: string
    proposals: readonly ProductionAssetProposal[]
  } | null>(null)
  const owner = useRef(conversationId)
  owner.current = conversationId
  const epoch = useRef(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!conversationId || revision === 0) return
    const controller = new AbortController()
    const readEpoch = epoch.current
    void authenticatedBffFetch(
      `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(conversationId)}/production?assetProposals=true`,
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable')
        const result = (await response.json()) as AssetResponse
        if (
          !controller.signal.aborted &&
          epoch.current === readEpoch &&
          owner.current === conversationId
        ) {
          setState({ owner: conversationId, proposals: result.assetProposals ?? [] })
          setFailed(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [conversationId, revision, refreshKey, reload])
  const act = async (proposalId: string, action: 'adopt' | 'discard') => {
    if (!conversationId || busy) return
    epoch.current++
    setBusy(true)
    setFailed(false)
    try {
      const response = await authenticatedBffFetch(
        `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(conversationId)}/production/asset-proposals/${encodeURIComponent(proposalId)}/${action}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            action === 'adopt'
              ? { baseRevision: revision, operationId: `adopt-assets:${proposalId}` }
              : {},
          ),
        },
      )
      if (!response.ok) throw new Error('unavailable')
      const result = (await response.json()) as AssetResponse
      if (owner.current !== conversationId) return
      onSaved({ ...result, history: result.history ?? [] })
      setState({ owner: conversationId, proposals: result.assetProposals ?? [] })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return {
    proposals: state?.owner === conversationId ? state.proposals : [],
    busy,
    failed,
    act,
    reload: () => setReload((value) => value + 1),
  }
}
