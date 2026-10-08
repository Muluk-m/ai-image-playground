import { FolderOpen, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePreview } from '../../../components/Lightbox'
import { useTranslation } from '../../../i18n'
import { blobDataUrl } from '../../../lib/cloudMedia'
import {
  fetchBatchPlan,
  fetchConversations,
  fetchMessageReference,
  fetchMessages,
} from '../lib/agentClient'
import {
  type AssetItem,
  assetsFromBatch,
  assetsFromMessages,
  batchNeedsRefresh,
  loadAssetOriginal,
  type StoredReferenceLoader,
} from '../lib/assetItems'
import { panelStateFromHistory } from '../lib/panelMessages'
import { useAgentStore } from '../store'
import type { AgentPanelMessage, AgentToolMessage } from '../types'

const ASSET_PAGE_SIZE = 24
const BATCH_REFRESH_MS = 4_000

export default function AgentAssetDrawer({
  messages,
  onClose,
  onPreview,
}: {
  messages: readonly AgentPanelMessage[]
  onClose: () => void
  onPreview: (message: AgentToolMessage, id: string) => void
}) {
  const { t } = useTranslation('agent')
  const [search, setSearch] = useState('')
  const [media, setMedia] = useState<'all' | 'image' | 'video'>('all')
  const [scope, setScope] = useState<'session' | 'all'>('session')
  const [allItems, setAllItems] = useState<AssetItem[]>([])
  const [loadingAll, setLoadingAll] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [batchById, setBatchById] = useState<Readonly<Record<string, readonly AssetItem[]>>>({})
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchFailed, setBatchFailed] = useState(false)
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const sourcePreviewRef = useRef<string | null>(null)
  sourcePreviewRef.current = sourcePreview
  const previewToken = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const loadNextRef = useRef<() => void>(() => {})
  const conversationId = useAgentStore((state) => state.conversationId)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const batchIds = useMemo(() => {
    const ids: string[] = []
    for (const message of messages) {
      if (message.kind === 'tool' && message.batchId && !ids.includes(message.batchId))
        ids.push(message.batchId)
    }
    return ids
  }, [messages])
  const batchKey = batchIds.join('\n')
  const reloadBatchRef = useRef<() => void>(() => {})
  const loadReferenceRef = useRef<StoredReferenceLoader>(async () => null)
  loadReferenceRef.current = async (targetConversationId, messageId, index, variant) => {
    try {
      const blob = await fetchMessageReference(targetConversationId, messageId, index, {
        signal: AbortSignal.timeout(30_000),
        ...(variant === 'original' ? { variant: 'original' as const } : {}),
      })
      return await blobDataUrl(blob)
    } catch {
      return null
    }
  }
  useEffect(() => {
    if (!batchKey) {
      setBatchById({})
      setBatchLoading(false)
      setBatchFailed(false)
      reloadBatchRef.current = () => {}
      return
    }
    const ids = batchKey.split('\n')
    let cancelled = false
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (initial: boolean) => {
      const token = ++generation
      if (timer) clearTimeout(timer)
      timer = undefined
      if (initial) setBatchLoading(true)
      const settled = await Promise.allSettled(ids.map((id) => fetchBatchPlan(id)))
      if (cancelled || token !== generation) return
      const failed: string[] = []
      const loaded = new Map<string, readonly AssetItem[]>()
      let refresh = false
      settled.forEach((result, index) => {
        const id = ids[index]!
        if (result.status === 'rejected') {
          failed.push(id)
          return
        }
        const message = messagesRef.current.find(
          (one): one is AgentToolMessage => one.kind === 'tool' && one.batchId === id,
        )
        loaded.set(id, message ? assetsFromBatch(message, result.value) : [])
        if (batchNeedsRefresh(result.value)) refresh = true
      })
      setBatchById((current) => {
        const next: Record<string, readonly AssetItem[]> = {}
        for (const id of ids) {
          const fresh = loaded.get(id)
          if (fresh) next[id] = fresh
          else if (current[id]) next[id] = current[id]
        }
        return next
      })
      setBatchFailed(failed.length > 0)
      setBatchLoading(false)
      if (refresh) timer = setTimeout(() => void load(false), BATCH_REFRESH_MS)
    }
    reloadBatchRef.current = () => void load(true)
    void load(true)
    return () => {
      cancelled = true
      generation += 1
      if (timer) clearTimeout(timer)
      reloadBatchRef.current = () => {}
    }
  }, [batchKey])
  const batchItems = useMemo(
    () => batchIds.flatMap((id) => batchById[id] ?? []),
    [batchIds, batchById],
  )
  const generatedItems = useMemo(
    () =>
      assetsFromMessages(
        messages,
        conversationId
          ? {
              conversationId,
              loadReference: (targetConversationId, messageId, index, variant) =>
                loadReferenceRef.current(targetConversationId, messageId, index, variant),
            }
          : undefined,
      ),
    [messages, conversationId],
  )
  const sessionItems = useMemo(() => {
    const seen = new Set<string>()
    const items: AssetItem[] = []
    for (const item of [...generatedItems, ...batchItems]) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
    return items
  }, [generatedItems, batchItems])
  const sessionItemsRef = useRef(sessionItems)
  const initialSessionIds = useRef(new Set<string>())
  sessionItemsRef.current = sessionItems
  useEffect(() => {
    if (scope !== 'all') return
    let cancelled = false
    let busy = false
    let conversations: Awaited<ReturnType<typeof fetchConversations>> | null = null
    let nextConversation = 0
    const initialItems = sessionItemsRef.current
    initialSessionIds.current = new Set(initialItems.map((item) => item.id))
    setLoadingAll(false)
    let pending = initialItems.slice(ASSET_PAGE_SIZE)
    setAllItems(initialItems.slice(0, ASSET_PAGE_SIZE))
    setHasMore(true)
    setLoadFailed(false)
    const loadNext = async () => {
      if (busy || cancelled) return
      busy = true
      setLoadingAll(true)
      setLoadFailed(false)
      const page: AssetItem[] = []
      try {
        // 先消费已在内存里的本会话产物；滚到底部才读取下一段会话历史。
        while (page.length < ASSET_PAGE_SIZE && !cancelled) {
          if (pending.length) {
            page.push(...pending.splice(0, ASSET_PAGE_SIZE - page.length))
          } else {
            if (!conversations)
              conversations = (await fetchConversations()).filter(
                (one) => one.id !== conversationId,
              )
            if (nextConversation >= conversations.length) break
            const olderId = conversations[nextConversation]!.id
            const history = await fetchMessages(olderId)
            pending = assetsFromMessages(panelStateFromHistory(history).messages, {
              conversationId: olderId,
              loadReference: (targetConversationId, messageId, index, variant) =>
                loadReferenceRef.current(targetConversationId, messageId, index, variant),
            })
            nextConversation += 1
          }
        }
      } catch {
        if (!cancelled) setLoadFailed(true)
      } finally {
        if (!cancelled) {
          if (page.length) setAllItems((items) => [...items, ...page])
          setHasMore(
            pending.length > 0 || conversations === null || nextConversation < conversations.length,
          )
          setLoadingAll(false)
        }
        busy = false
      }
    }
    loadNextRef.current = () => void loadNext()
    return () => {
      cancelled = true
      loadNextRef.current = () => {}
    }
  }, [scope, conversationId])
  const liveSession = new Map(sessionItems.map((item) => [item.id, item]))
  const items =
    scope === 'session'
      ? sessionItems
      : [
          ...sessionItems.filter((item) => !initialSessionIds.current.has(item.id)),
          ...allItems.map((item) => liveSession.get(item.id) ?? item),
        ]
  const shown = items.filter(
    (item) =>
      (media === 'all' || item.media === media) &&
      `${item.title} ${item.open.kind === 'result' ? (item.open.message.prompt ?? '') : ''}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  )
  useEffect(() => {
    if (scope !== 'all' || !hasMore || loadingAll || loadFailed) return
    const end = endRef.current
    const grid = gridRef.current
    if (!end || !grid) return
    if (typeof IntersectionObserver === 'undefined') {
      loadNextRef.current()
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) loadNextRef.current()
      },
      { root: grid, rootMargin: '220px' },
    )
    observer.observe(end)
    return () => observer.disconnect()
  }, [scope, hasMore, loadingAll, loadFailed, shown.length])
  useEffect(
    () => () => {
      previewToken.current += 1
    },
    [],
  )
  const openSource = (item: AssetItem) => {
    const token = ++previewToken.current
    void loadAssetOriginal(item, (targetConversationId, messageId, index, variant) =>
      loadReferenceRef.current(targetConversationId, messageId, index, variant),
    ).then((source) => {
      if (token === previewToken.current && source) setSourcePreview(source)
    })
  }
  const closeSource = () => {
    previewToken.current += 1
    setSourcePreview(null)
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      // 原图预览自己吃掉这一下；这里再关，会连抽屉一起收掉。
      if (event.key !== 'Escape' || sourcePreviewRef.current) return
      onClose()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  return createPortal(
    <div
      className="studio-assets-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <aside
        className="studio-assets-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('assets.title')}
      >
        <header className="studio-assets-head">
          <FolderOpen size={18} aria-hidden="true" />
          <h2>{t('assets.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('assets.close')}>
            <X size={18} />
          </button>
        </header>
        <div className="studio-assets-tabs" role="group" aria-label={t('assets.scope')}>
          <button
            type="button"
            aria-pressed={scope === 'session'}
            onClick={() => setScope('session')}
          >
            {t('assets.session')}
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            {t('assets.all')}
          </button>
        </div>
        <label className="studio-assets-search">
          <Search size={17} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(scope === 'all' ? 'assets.searchAll' : 'assets.search')}
            aria-label={t(scope === 'all' ? 'assets.searchAll' : 'assets.search')}
          />
        </label>
        <div className="studio-assets-filters" role="group" aria-label={t('assets.media')}>
          {(['all', 'image', 'video'] as const).map((one) => (
            <button
              key={one}
              type="button"
              aria-pressed={media === one}
              onClick={() => setMedia(one)}
            >
              {t(one === 'all' ? 'assets.allMedia' : `assets.${one}`)}
            </button>
          ))}
        </div>
        <div className="studio-assets-grid" ref={gridRef}>
          {shown.map((item) => (
            <AssetThumb
              key={item.id}
              item={item}
              label={item.title || t('assets.untitled')}
              onClick={() => {
                if (item.open.kind === 'source') {
                  openSource(item)
                  return
                }
                onClose()
                onPreview(item.open.message, item.id)
              }}
            />
          ))}
          {scope === 'all' && loadingAll && (
            <div className="studio-assets-status" role="status">
              <span className="studio-agent-history-pulse" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {t('assets.loading')}
            </div>
          )}
          {scope === 'all' && loadFailed && (
            <p className="studio-assets-status" role="alert">
              {t('assets.loadFailed')}{' '}
              <button type="button" onClick={() => loadNextRef.current()}>
                {t('assets.retry')}
              </button>
            </p>
          )}
          {scope === 'all' && hasMore && !loadFailed && (
            <div ref={endRef} className="studio-assets-end" aria-hidden="true" />
          )}
          {scope === 'session' && batchLoading && !shown.length && (
            <div className="studio-assets-status" role="status">
              <span className="studio-agent-history-pulse" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {t('assets.loadingBatch')}
            </div>
          )}
          {scope === 'session' && batchFailed && (
            <p className="studio-assets-status" role="alert">
              {t('assets.batchFailed')}{' '}
              <button type="button" onClick={() => reloadBatchRef.current()}>
                {t('assets.retry')}
              </button>
            </p>
          )}
          {!shown.length &&
            !loadingAll &&
            !batchLoading &&
            !loadFailed &&
            !batchFailed &&
            (scope === 'session' || !hasMore) && (
              <p className="studio-assets-empty">
                {t(items.length ? 'assets.noMatch' : 'assets.empty')}
              </p>
            )}
        </div>
        {sourcePreview && <ImagePreview src={sourcePreview} onClose={closeSource} />}
      </aside>
    </div>,
    document.body,
  )
}

function AssetThumb({
  item,
  label,
  onClick,
}: {
  item: AssetItem
  label: string
  onClick: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { root: element.closest('.studio-assets-grid'), rootMargin: '160px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let alive = true
    void item
      .load()
      .then((next) => {
        if (alive) setSource(next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [item.id, visible])
  return (
    <button ref={ref} type="button" className="studio-assets-item" title={label} onClick={onClick}>
      <span className="studio-assets-thumb">
        {source && <img src={source} alt="" loading="lazy" />}
        {item.media === 'video' && <span className="studio-assets-video">▶</span>}
      </span>
      <span className="studio-assets-name">{label}</span>
    </button>
  )
}
