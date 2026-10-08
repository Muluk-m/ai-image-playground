import { FolderOpen, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePreview } from '../../../components/Lightbox'
import { useTranslation } from '../../../i18n'
import { fetchBatchPlan, fetchConversations, fetchMessages } from '../lib/agentClient'
import {
  type AssetItem,
  assetsFromBatch,
  assetsFromMessages,
  loadAssetOriginal,
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
  const [batchItems, setBatchItems] = useState<readonly AssetItem[]>([])
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchFailed, setBatchFailed] = useState(false)
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const sourcePreviewRef = useRef<string | null>(null)
  sourcePreviewRef.current = sourcePreview
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
  useEffect(() => {
    if (!batchKey) {
      setBatchItems([])
      setBatchLoading(false)
      setBatchFailed(false)
      reloadBatchRef.current = () => {}
      return
    }
    const ids = batchKey.split('\n')
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (initial: boolean) => {
      if (initial) setBatchLoading(true)
      setBatchFailed(false)
      try {
        const pages = await Promise.all(ids.map((id) => fetchBatchPlan(id)))
        if (cancelled) return
        const loaded = pages.flatMap((page, index) => {
          const message = messagesRef.current.find(
            (one): one is AgentToolMessage => one.kind === 'tool' && one.batchId === ids[index],
          )
          return message ? assetsFromBatch(message, page) : []
        })
        setBatchItems(loaded)
        if (pages.some((page) => page.batch.status === 'running'))
          timer = setTimeout(() => void load(false), BATCH_REFRESH_MS)
      } catch {
        if (!cancelled) setBatchFailed(true)
      } finally {
        if (!cancelled) setBatchLoading(false)
      }
    }
    reloadBatchRef.current = () => void load(true)
    void load(true)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      reloadBatchRef.current = () => {}
    }
  }, [batchKey])
  const generatedItems = useMemo(() => assetsFromMessages(messages), [messages])
  const sessionItems = useMemo(() => {
    const seen = new Set(generatedItems.map((item) => item.id))
    return [...generatedItems, ...batchItems.filter((item) => !seen.has(item.id))]
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
            const history = await fetchMessages(conversations[nextConversation]!.id)
            nextConversation += 1
            pending = assetsFromMessages(panelStateFromHistory(history).messages)
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
                  void loadAssetOriginal(item).then((source) => {
                    if (source) setSourcePreview(source)
                  })
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
        {sourcePreview && (
          <ImagePreview src={sourcePreview} onClose={() => setSourcePreview(null)} />
        )}
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
