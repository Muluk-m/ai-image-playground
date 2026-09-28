import {
  ArrowLeft,
  ArrowRight,
  Brush,
  Copy,
  Crop,
  Download,
  Eraser,
  Expand,
  ImagePlus,
  Images,
  Scan,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePreview } from '../../../components/Lightbox'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import { previewArtifactBitmap } from '../lib/artifactSource'
import { attachFilesToComposer } from '../lib/attachments'
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
  onViewCanvas: (
    objectIds?: readonly string[],
    action?: 'inpaint' | 'erase' | 'crop' | 'outpaint',
  ) => void
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
    if (!source && !active.videoUrl) return
    const link = document.createElement('a')
    link.href = active.media === 'video' ? active.videoUrl! : source!
    const mime = source?.match(/^data:image\/(png|jpeg|webp|gif)/)?.[1]
    link.download = `muvloom-${active.id}.${active.media === 'video' ? 'mp4' : mime === 'jpeg' ? 'jpg' : (mime ?? 'png')}`
    link.click()
  }
  const useAsReference = async () => {
    if (!source || active.media !== 'image') return
    const blob = await fetch(source)
      .then((response) => response.blob())
      .catch(() => null)
    if (!blob) return
    const file = new File([blob], `muvloom-${active.id}.png`, { type: blob.type || 'image/png' })
    if (attachFilesToComposer([file])) onClose()
  }

  return createPortal(
    <aside
      className="studio-artifact-pane"
      role="dialog"
      aria-modal="true"
      aria-label={t('tool.previewTitle')}
    >
      <button
        type="button"
        className="studio-artifact-pane-back"
        onClick={onClose}
        aria-label={t('tool.backToChat')}
        title={t('tool.backToChat')}
      >
        <ArrowLeft size={21} aria-hidden="true" />
      </button>
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
        <div className="studio-artifact-pane-primary">
          <button type="button" onClick={download} disabled={!source && !active.videoUrl}>
            <Download size={18} aria-hidden="true" />
            {t('tool.downloadResult')}
          </button>
          {items.length > 1 && (
            <span>
              {items.findIndex((item) => item.id === active.id) + 1}/{items.length}
            </span>
          )}
        </div>
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
            <p className="studio-artifact-pane-prompt-text" tabIndex={0}>
              {message.prompt}
            </p>
          </section>
        )}
        <div className="studio-artifact-pane-actions">
          {active.media === 'image' && source && (
            <>
              <button type="button" onClick={() => setZoomed(true)}>
                <Expand size={15} aria-hidden="true" />
                {t('tool.zoomResult')}
              </button>
              <button type="button" onClick={() => void useAsReference()}>
                <ImagePlus size={15} aria-hidden="true" />
                {t('tool.useAsReference')}
              </button>
            </>
          )}
          {active.media === 'image' && (
            <button
              type="button"
              className="studio-artifact-pane-edit"
              onClick={() => onViewCanvas([active.id])}
            >
              <Images size={15} aria-hidden="true" />
              {t('tool.editOnCanvas')}
            </button>
          )}
          {active.media === 'image' && (
            <div className="studio-artifact-pane-tools">
              <button type="button" onClick={() => onViewCanvas([active.id], 'inpaint')}>
                <Brush size={15} />
                {t('tool.inpaint')}
              </button>
              <button type="button" onClick={() => onViewCanvas([active.id], 'erase')}>
                <Eraser size={15} />
                {t('tool.erase')}
              </button>
              <button type="button" onClick={() => onViewCanvas([active.id], 'crop')}>
                <Crop size={15} />
                {t('tool.crop')}
              </button>
              <button type="button" onClick={() => onViewCanvas([active.id], 'outpaint')}>
                <Scan size={15} />
                {t('tool.outpaint')}
              </button>
            </div>
          )}
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
