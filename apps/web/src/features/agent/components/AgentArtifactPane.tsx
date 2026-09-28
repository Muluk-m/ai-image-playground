import { ArrowLeft, Download, Expand, Images, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ImagePreview } from '../../../components/Lightbox'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import { previewArtifactBitmap } from '../lib/artifactSource'
import type { AgentToolMessage } from '../types'
import AgentPromptDialog from './AgentPromptDialog'

interface PaneItem {
  readonly id: string
  readonly media: 'image' | 'video'
  readonly load: () => Promise<string | null>
  readonly videoUrl?: string
}

export default function AgentArtifactPane({
  message,
  selectedId,
  onSelect,
  onClose,
  onViewCanvas,
}: {
  message: AgentToolMessage
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
  onViewCanvas: (objectIds?: readonly string[]) => void
}) {
  const { t } = useTranslation('agent')
  const [source, setSource] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [zoomed, setZoomed] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  const items: PaneItem[] = [
    ...(message.artifacts ?? []).map((artifact) => ({
      id: artifact.artifactId,
      media: artifact.media === 'video' ? ('video' as const) : ('image' as const),
      load: () => previewArtifactBitmap(artifact),
      videoUrl:
        artifact.media === 'video'
          ? queueOutputUrl(artifact.taskId, artifact.outputIndex)
          : undefined,
    })),
    ...(message.fetchedImages ?? []).map((image, index) => ({
      id: fetchedCanvasId(message.toolCallId, index),
      media: 'image' as const,
      load: () =>
        resolveMediaSource(`aip-media:${image.imageId}`, 'original', true).catch(() => null),
    })),
  ]
  const active = items.find((item) => item.id === selectedId) ?? items[0]

  useEffect(() => {
    let alive = true
    setLoading(true)
    setSource(null)
    setZoomed(false)
    if (!active) return
    void active.load().then((next) => {
      if (!alive) return
      setSource(next)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [active?.id, message.delivery, retry])

  if (!active) return null
  const download = () => {
    if (!source || active.media !== 'image') return
    const link = document.createElement('a')
    link.href = source
    const mime = source.match(/^data:image\/(png|jpeg|webp|gif)/)?.[1]
    link.download = `muvloom-${active.id}.${mime === 'jpeg' ? 'jpg' : (mime ?? 'png')}`
    link.click()
  }

  return (
    <aside className="studio-artifact-pane" aria-label={t('tool.previewTitle')}>
      <div className="studio-artifact-pane-head">
        <button type="button" className="studio-artifact-pane-back" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden="true" />
          {t('tool.backToChat')}
        </button>
        <div className="studio-artifact-pane-heading">
          <Images size={16} aria-hidden="true" />
          <span>{t('tool.previewTitle')}</span>
          {items.length > 1 && (
            <span className="studio-artifact-pane-count">
              {items.findIndex((item) => item.id === active.id) + 1}/{items.length}
            </span>
          )}
        </div>
        <button
          type="button"
          className="studio-artifact-pane-close"
          aria-label={t('tool.closePreview')}
          onClick={onClose}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="studio-artifact-pane-viewer">
        {active.media === 'video' && active.videoUrl ? (
          <video
            key={active.id}
            controls
            playsInline
            poster={source ?? undefined}
            src={active.videoUrl}
          />
        ) : source ? (
          <button
            type="button"
            className="studio-artifact-pane-image"
            onClick={() => setZoomed(true)}
            aria-label={t('tool.zoomResult')}
          >
            <img src={source} alt={message.title} />
          </button>
        ) : (
          <div className="studio-artifact-pane-loading" role="status">
            {loading ? (
              t('tool.loadingPreview')
            ) : (
              <>
                <span>{t('tool.previewUnavailable')}</span>
                <button type="button" onClick={() => setRetry((value) => value + 1)}>
                  {t('tool.retryPreview')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {items.length > 1 && (
        <div className="studio-artifact-pane-strip" aria-label={t('tool.previewTitle')}>
          {items.map((item, index) => (
            <PaneThumbnail
              key={item.id}
              item={item}
              index={index}
              selected={item.id === active.id}
              delivery={message.delivery}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      <div className="studio-artifact-pane-foot">
        <p title={message.title}>{message.title}</p>
        <div className="studio-artifact-pane-actions">
          {active.media === 'image' && source && (
            <>
              <button type="button" onClick={() => setZoomed(true)}>
                <Expand size={15} aria-hidden="true" />
                {t('tool.zoomResult')}
              </button>
              <button type="button" onClick={download}>
                <Download size={15} aria-hidden="true" />
                {t('tool.downloadResult')}
              </button>
            </>
          )}
          {message.prompt && (
            <button type="button" onClick={() => setPromptOpen(true)}>
              {t('tool.viewPrompt')}
            </button>
          )}
          <button
            type="button"
            className="studio-artifact-pane-edit"
            onClick={() => onViewCanvas([active.id])}
          >
            <Images size={15} aria-hidden="true" />
            {t('tool.editOnCanvas')}
          </button>
        </div>
      </div>
      {zoomed && source && <ImagePreview src={source} onClose={() => setZoomed(false)} />}
      {promptOpen && message.prompt && (
        <AgentPromptDialog prompt={message.prompt} onClose={() => setPromptOpen(false)} />
      )}
    </aside>
  )
}

function PaneThumbnail({
  item,
  index,
  selected,
  delivery,
  onSelect,
}: {
  item: PaneItem
  index: number
  selected: boolean
  delivery?: AgentToolMessage['delivery']
  onSelect: (id: string) => void
}) {
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void item.load().then((next) => {
      if (alive) setSource(next)
    })
    return () => {
      alive = false
    }
  }, [item.id, delivery])
  return (
    <button
      type="button"
      className="studio-artifact-pane-thumb"
      aria-label={`${index + 1}`}
      aria-pressed={selected}
      onClick={() => onSelect(item.id)}
    >
      {source && <img src={source} alt="" />}
      <span>{index + 1}</span>
    </button>
  )
}
