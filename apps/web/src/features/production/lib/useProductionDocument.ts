import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchProduction, type ProductionResponse } from './productionClient'

const EMPTY: ProductionResponse = { document: null, history: [] }

export function useProductionDocument(conversationId: string | null, refreshKey: string) {
  const [data, setData] = useState<ProductionResponse>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const owner = useRef(conversationId)
  owner.current = conversationId
  useEffect(() => {
    setData(EMPTY)
  }, [conversationId])
  useEffect(() => {
    if (!conversationId) return
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    void fetchProduction(conversationId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted)
          setData((current) =>
            current.document?.conversationId === next.document?.conversationId &&
            (current.document?.revision ?? 0) > (next.document?.revision ?? 0)
              ? current
              : next,
          )
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [conversationId, refreshKey, retry])
  const accept = useCallback((next: ProductionResponse) => {
    if (next.document?.conversationId === owner.current)
      setData((current) =>
        current.document?.conversationId === next.document?.conversationId &&
        (current.document?.revision ?? 0) > (next.document?.revision ?? 0)
          ? current
          : next,
      )
  }, [])
  return {
    ...data,
    document: data.document?.conversationId === conversationId ? data.document : null,
    loading,
    failed,
    accept,
    reload: () => setRetry((value) => value + 1),
  }
}
