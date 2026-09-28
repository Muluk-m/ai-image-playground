import { ArrowLeft, ArrowRight, Copy, Download, Expand, Images, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePreview } from '../../../components/Lightbox'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import { previewArtifactBitmap } from '../lib/artifactSource'
import { agentCanvasSink } from '../lib/canvasSink'
import type { AgentToolMessage } from '../types'

interface PaneItem {
  readonly id: string
  readonly media: 'image' | 'video'
  readonly load: () => Promise<string | null>
  readonly loadThumbnail: () => Promise<string | null>
  readonly videoUrl?: string
}

async function canvasOrSource(
  id: string,
  fallback: () => Promise<string | null>,
  scale = 1,
): Promise<string | null> {
  const canvas = agentCanvasSink()
  if (canvas?.has(id)) {
    const bitmap = await canvas.thumbnail(id, scale).catch(() => null)
    if (bitmap) return bitmap
  }
  return fallback()
}

async function sourceOrCanvas(
  id: string,
  loadSource: () => Promise<string | null>,
): Promise<string | null> {
  const source = await loadSource().catch(() => null)
  if (source) return source
  const canvas = agentCanvasSink()
  return canvas?.has(id) ? canvas.thumbnail(id, 3).catch(() => null) : null
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
  const [retry, setRetry] = useState(0)
  const items: PaneItem[] = [
    ...(message.artifacts ?? []).map((artifact) => ({
      id: artifact.artifactId,
      media: artifact.media === 'video' ? ('video' as const) : ('image' as const),
      load: () => sourceOrCanvas(artifact.artifactId, () => previewArtifactBitmap(artifact)),
      loadThumbnail: () =>
        canvasOrSource(artifact.artifactId, () => previewArtifactBitmap(artifact), 0.16),
      videoUrl:
        artifact.media === 'video'
          ? queueOutputUrl(artifact.taskId, artifact.outputIndex)
          : undefined,
    })),
    ...(message.fetchedImages ?? []).map((image, index) => ({
      id: fetchedCanvasId(message.toolCallId, index),
      media: 'image' as const,
      load: () =>
        sourceOrCanvas(fetchedCanvasId(message.toolCallId, index), () =>
          resolveMediaSource(`aip-media:${image.imageId}`, 'original', true).catch(() => null),
        ),
      loadThumbnail: () =>
        canvasOrSource(
          fetchedCanvasId(message.toolCallId, index),
          () => resolveMediaSource(`aip-media:${image.imageId}`, 'preview').catch(() => null),
          0.16,
        ),
    })),
  ]
  const active = items.find((item) => item.id === selectedId) ?? items[0]
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector('.studio-handoff-dialog')) return
      if (event.key === 'Escape') onClose()
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && items.length > 1) {
        const index = items.findIndex((item) => item.id === active?.id)
        onSelect(
          items[(index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].id,
        )
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [active?.id, items.length, onClose, onSelect])

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

  return createPortal(
    <aside
      className="studio-artifact-pane"
      role="dialog"
      aria-modal="true"
      aria-label={t('tool.previewTitle')}
    >
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
        {items.length > 1 && (
          <button
            type="button"
            className="studio-artifact-pane-prev"
            aria-label={t('tool.previousResult')}
            onClick={() =>
              onSelect(
                items[
                  (items.findIndex((item) => item.id === active.id) - 1 + items.length) %
                    items.length
                ].id,
              )
            }
          >
            <ArrowLeft size={22} />
          </button>
        )}
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
        {items.length > 1 && (
          <button
            type="button"
            className="studio-artifact-pane-next"
            aria-label={t('tool.nextResult')}
            onClick={() =>
              onSelect(
                items[(items.findIndex((item) => item.id === active.id) + 1) % items.length].id,
              )
            }
          >
            <ArrowRight size={22} />
          </button>
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
        {message.prompt && (
          <section className="studio-artifact-pane-prompt">
            <div>
              <span>{t('tool.imagePrompt')}</span>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(message.prompt ?? '')}
                aria-label={t('tool.copyPrompt')}
                title={t('tool.copyPrompt')}
              >
                <Copy size={15} />
              </button>
            </div>
            <p>{message.prompt}</p>
          </section>
        )}
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
    </aside>,
    document.body,
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
    void item.loadThumbnail().then((next) => {
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
