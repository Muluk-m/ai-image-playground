import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AgentConversationState,
  fetchBatchPlan,
  fetchConversations,
  fetchMessages,
} from '../../agent/lib/agentClient'
import { batchNeedsRefresh } from '../../agent/lib/assetItems'
import { panelStateFromHistory } from '../../agent/lib/panelMessages'
import { useAgentStore } from '../../agent/store'
import type { AgentPanelMessage, AgentToolMessage } from '../../agent/types'
import {
  type CanvasAssetItem,
  canvasAssetsFromBatch,
  canvasAssetsFromMessages,
  messageTimes,
  sortCanvasAssets,
} from './canvasAssets'

const PAGE_SIZE = 24
/** 每次最多读这么多段对话，空对话很多时也不会一口气把全部历史拉完。 */
const CONVERSATIONS_PER_PAGE = 12
const BATCH_REFRESH_MS = 4_000
const NO_MESSAGES: readonly AgentPanelMessage[] = []

export type CanvasAssetScope = 'project' | 'all'

export interface CanvasAssets {
  readonly items: readonly CanvasAssetItem[]
  readonly loading: boolean
  readonly failed: boolean
  /** 所有项目还有没读到的对话。 */
  readonly hasMore: boolean
  readonly loadMore: () => void
}

/** 本项目对话的消息：正在聊的就用实时消息，否则读一次历史。落库时间都从历史取。 */
function useProjectMessages(conversationId: string | null) {
  const live = useAgentStore((s) =>
    conversationId && s.conversationId === conversationId ? s.messages : null,
  )
  const [history, setHistory] = useState<AgentConversationState | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  useEffect(() => {
    setHistory(null)
    if (!conversationId) {
      setState('idle')
      return
    }
    let cancelled = false
    setState('loading')
    fetchMessages(conversationId).then(
      (next) => {
        if (cancelled) return
        setHistory(next)
        setState('idle')
      },
      () => {
        if (!cancelled) setState('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [conversationId])
  const messages = useMemo(
    () => live ?? (history ? panelStateFromHistory(history).messages : NO_MESSAGES),
    [live, history],
  )
  const time = useMemo(() => messageTimes(history), [history])
  return { messages, time, loading: state === 'loading' && !live, failed: state === 'failed' }
}

/** 本项目批量计划里完成的产物，计划没跑完时每 4 秒刷新一次。 */
function useBatchAssets(
  conversationId: string | null,
  messages: readonly AgentPanelMessage[],
  time: (message: AgentPanelMessage) => number,
) {
  const batchMessages = useMemo(
    () =>
      messages.filter(
        (one): one is AgentToolMessage & { batchId: string } =>
          one.kind === 'tool' && !!one.batchId,
      ),
    [messages],
  )
  const batchKey = [...new Set(batchMessages.map((one) => one.batchId))].join('\n')
  const latest = useRef({ batchMessages, time })
  latest.current = { batchMessages, time }
  const [byBatch, setByBatch] = useState<Record<string, readonly CanvasAssetItem[]>>({})
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!batchKey || !conversationId) {
      setByBatch({})
      setFailed(false)
      return
    }
    const ids = batchKey.split('\n')
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const settled = await Promise.allSettled(ids.map((id) => fetchBatchPlan(id)))
      if (cancelled) return
      let refresh = false
      const next: Record<string, readonly CanvasAssetItem[]> = {}
      settled.forEach((result, index) => {
        const id = ids[index]!
        if (result.status === 'rejected') return
        const message = latest.current.batchMessages.find((one) => one.batchId === id)
        next[id] = message
          ? canvasAssetsFromBatch(
              message,
              result.value,
              conversationId,
              latest.current.time(message),
            )
          : []
        if (batchNeedsRefresh(result.value)) refresh = true
      })
      setByBatch((current) => {
        const merged: Record<string, readonly CanvasAssetItem[]> = {}
        for (const id of ids) {
          const fresh = next[id] ?? current[id]
          if (fresh) merged[id] = fresh
        }
        return merged
      })
      setFailed(settled.some((result) => result.status === 'rejected'))
      if (refresh) timer = setTimeout(() => void load(), BATCH_REFRESH_MS)
    }
    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [batchKey, conversationId])
  return { items: useMemo(() => Object.values(byBatch).flat(), [byBatch]), failed }
}

/** 别的对话的产物，按对话最近更新的顺序一段段读，每段至少凑够一页。 */
function useOtherAssets(enabled: boolean, conversationId: string | null) {
  const [items, setItems] = useState<CanvasAssetItem[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const loadNextRef = useRef<() => void>(() => {})
  useEffect(() => {
    setItems([])
    setFailed(false)
    setHasMore(enabled)
    if (!enabled) {
      loadNextRef.current = () => {}
      return
    }
    let cancelled = false
    let busy = false
    let conversations: string[] | null = null
    let next = 0
    const loadNext = async () => {
      if (busy || cancelled) return
      busy = true
      setLoading(true)
      setFailed(false)
      const page: CanvasAssetItem[] = []
      let read = 0
      try {
        while (page.length < PAGE_SIZE && read < CONVERSATIONS_PER_PAGE && !cancelled) {
          if (!conversations)
            conversations = (await fetchConversations())
              .map((one) => one.id)
              .filter((id) => id !== conversationId)
          const id = conversations[next]
          if (!id) break
          const history = await fetchMessages(id)
          page.push(
            ...canvasAssetsFromMessages(
              panelStateFromHistory(history).messages,
              id,
              messageTimes(history),
            ),
          )
          next += 1
          read += 1
        }
      } catch {
        if (!cancelled) setFailed(true)
      } finally {
        if (!cancelled) {
          if (page.length) setItems((current) => [...current, ...page])
          setHasMore(conversations === null || next < conversations.length)
          setLoading(false)
        }
        busy = false
      }
    }
    loadNextRef.current = () => void loadNext()
    void loadNext()
    return () => {
      cancelled = true
      loadNextRef.current = () => {}
    }
  }, [enabled, conversationId])
  const loadMore = useCallback(() => loadNextRef.current(), [])
  return { items, loading, failed, hasMore, loadMore }
}

/**
 * 画布资产浮层的数据：当前项目对话里生成成功的图和视频（含批量计划的产物），
 * 切到所有项目时再按需读其它对话。
 */
export function useCanvasAssets(
  conversationId: string | null,
  scope: CanvasAssetScope,
): CanvasAssets {
  const project = useProjectMessages(conversationId)
  const batch = useBatchAssets(conversationId, project.messages, project.time)
  const others = useOtherAssets(scope === 'all', conversationId)
  const projectItems = useMemo(
    () =>
      conversationId
        ? [
            ...canvasAssetsFromMessages(project.messages, conversationId, project.time),
            ...batch.items,
          ]
        : [],
    [conversationId, project.messages, project.time, batch.items],
  )
  const items = useMemo(
    () => sortCanvasAssets(scope === 'all' ? [...projectItems, ...others.items] : projectItems),
    [scope, projectItems, others.items],
  )
  const all = scope === 'all'
  return {
    items,
    loading: project.loading || (all && others.loading),
    failed: project.failed || batch.failed || (all && others.failed),
    hasMore: all && others.hasMore,
    loadMore: others.loadMore,
  }
}
