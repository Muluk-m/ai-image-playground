import { FolderOpen, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import { artifactPreview, fetchedImagePreview } from '../lib/artifactPreview'
import type { AgentPanelMessage } from '../types'

interface AssetItem {
  messageId: string
  id: string
  title: string
  media: 'image' | 'video'
  load: () => Promise<string | null>
}

export default function AgentAssetDrawer({
  messages,
  onClose,
  onPreview,
}: {
  messages: readonly AgentPanelMessage[]
  onClose: () => void
  onPreview: (messageId: string, id: string) => void
}) {
  const { t } = useTranslation('agent')
  const [search, setSearch] = useState('')
  const [media, setMedia] = useState<'all' | 'image' | 'video'>('all')
  const items = useMemo<AssetItem[]>(
    () =>
      messages
        .flatMap((message) => {
          if (message.kind !== 'tool' || message.status !== 'succeeded') return []
          return [
            ...(message.artifacts ?? []).map((artifact) => ({
              messageId: message.id,
              id: artifact.artifactId,
              title: message.title,
              media: artifact.media === 'video' ? ('video' as const) : ('image' as const),
              load: async () => (await artifactPreview(artifact)).source,
            })),
            ...(message.fetchedImages ?? []).map((image, index) => {
              const id = fetchedCanvasId(message.toolCallId, index)
              return {
                messageId: message.id,
                id,
                title: message.title,
                media: 'image' as const,
                load: async () => (await fetchedImagePreview(image, id)).source,
              }
            }),
          ]
        })
        .reverse(),
    [messages],
  )
  const shown = items.filter(
    (item) =>
      (media === 'all' || item.media === media) &&
      item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  const openLibrary = () => {
    onClose()
    useLibraryStore.getState().setTab('assets')
    useStore.getState().setAppMode('library')
  }
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
          <button type="button" aria-pressed="true">
            {t('assets.session')}
          </button>
          <button type="button" onClick={openLibrary}>
            {t('assets.all')}
          </button>
        </div>
        <label className="studio-assets-search">
          <Search size={17} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('assets.search')}
            aria-label={t('assets.search')}
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
          {shown.map((item) => (
            <AssetThumb
              key={item.id}
              item={item}
              onClick={() => {
                onClose()
                onPreview(item.messageId, item.id)
              }}
            />
          ))}
          {!shown.length && (
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
