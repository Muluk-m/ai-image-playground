import { FolderOpen, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../../i18n'
import { fetchConversations, fetchMessages } from '../lib/agentClient'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import { artifactPreview, fetchedImagePreview } from '../lib/artifactPreview'
import { panelStateFromHistory } from '../lib/panelMessages'
import { useAgentStore } from '../store'
import type { AgentPanelMessage, AgentToolMessage } from '../types'

interface AssetItem {
  message: AgentToolMessage
  id: string
  title: string
  media: 'image' | 'video'
  load: () => Promise<string | null>
}

function assetsFromMessages(messages: readonly AgentPanelMessage[]): AssetItem[] {
  return messages
    .flatMap((message) => {
      if (message.kind !== 'tool' || message.status !== 'succeeded') return []
      return [
        ...(message.artifacts ?? []).map((artifact) => ({
          message,
          id: artifact.artifactId,
          title: message.title,
          media: artifact.media === 'video' ? ('video' as const) : ('image' as const),
          load: async () => (await artifactPreview(artifact)).source,
        })),
        ...(message.fetchedImages ?? []).map((image, index) => {
          const id = fetchedCanvasId(message.toolCallId, index)
          return {
            message,
            id,
            title: message.title,
            media: 'image' as const,
            load: async () => (await fetchedImagePreview(image, id)).source,
          }
        }),
      ]
    })
    .reverse()
}

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
  const conversationId = useAgentStore((state) => state.conversationId)
  const sessionItems = useMemo(() => assetsFromMessages(messages), [messages])
  useEffect(() => {
    if (scope !== 'all') return
    let cancelled = false
    setLoadingAll(true)
    setLoadFailed(false)
    void (async () => {
      try {
        const conversations = await fetchConversations()
        const other = conversations.filter((one) => one.id !== conversationId)
        const byConversation = new Map<string, AssetItem[]>()
        const publish = () =>
          setAllItems([
            ...sessionItems,
            ...other.flatMap((conversation) => byConversation.get(conversation.id) ?? []),
          ])
        // 并发受控，避免打开资产抽屉时对 BFF 同时发出大量完整历史请求。
        let next = 0
        await Promise.all(
          Array.from({ length: Math.min(3, other.length) }, async () => {
            while (next < other.length && !cancelled) {
              const conversation = other[next++]!
              try {
                const history = await fetchMessages(conversation.id)
                byConversation.set(
                  conversation.id,
                  assetsFromMessages(panelStateFromHistory(history).messages),
                )
                if (!cancelled) publish()
              } catch {
                if (!cancelled) setLoadFailed(true)
              }
            }
          }),
        )
        if (!cancelled) publish()
      } catch {
        if (!cancelled) setLoadFailed(true)
      } finally {
        if (!cancelled) setLoadingAll(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scope, conversationId, sessionItems])
  const items = scope === 'session' ? sessionItems : allItems
  const shown = items.filter(
    (item) =>
      (media === 'all' || item.media === media) &&
      `${item.title} ${item.message.prompt ?? ''}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  )
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
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
        <div className="studio-assets-grid">
          {scope === 'all' && loadingAll && (
            <p className="studio-assets-status">{t('assets.loading')}</p>
          )}
          {scope === 'all' && loadFailed && (
            <p className="studio-assets-status" role="alert">
              {t('assets.loadFailed')}
            </p>
          )}
          {shown.map((item) => (
            <AssetThumb
              key={item.id}
              item={item}
              onClick={() => {
                onClose()
                onPreview(item.message, item.id)
              }}
            />
          ))}
          {!shown.length && !loadingAll && !loadFailed && (
            <p className="studio-assets-empty">
              {t(items.length ? 'assets.noMatch' : 'assets.empty')}
            </p>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function AssetThumb({ item, onClick }: { item: AssetItem; onClick: () => void }) {
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
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
  }, [item.id])
  return (
    <button type="button" className="studio-assets-item" title={item.title} onClick={onClick}>
      <span className="studio-assets-thumb">
        {source && <img src={source} alt="" loading="lazy" />}
        {item.media === 'video' && <span className="studio-assets-video">▶</span>}
      </span>
      <span className="studio-assets-name">{item.title}</span>
    </button>
  )
}
