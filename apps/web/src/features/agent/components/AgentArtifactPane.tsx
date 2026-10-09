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
import { accountRequired, requireAccount } from '../../../auth/loginPrompt'
import { ImagePreview } from '../../../components/Lightbox'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { useStore } from '../../../store'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import type { ArtifactEditAction, ArtifactEditInput } from '../lib/artifactEdit'
import { INLINE_RESULT_THUMBNAIL_SCALE } from '../lib/artifactPreview'
import { previewArtifactBitmap } from '../lib/artifactSource'
import { attachFilesToComposer } from '../lib/attachments'
import { agentCanvasSink } from '../lib/canvasSink'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'
import AgentArtifactEditDialog from './AgentArtifactEditDialog'

interface PaneItem {
  readonly id: string
  readonly media: 'image' | 'video'
  readonly load: () => Promise<string | null>
  readonly loadPreview: () => Promise<string | null>
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
  presentation = 'overlay',
}: {
  presentation?: 'panel' | 'overlay'
  message: AgentToolMessage
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
  onViewCanvas?: (objectIds?: readonly string[]) => void
}) {
  const { t } = useTranslation('agent')
  const { t: tv } = useTranslation('video')
  const [loadedSource, setLoadedSource] = useState<{ id: string; value: string | null } | null>(
    null,
  )
  const [preview, setPreview] = useState<{ id: string; source: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [zoomed, setZoomed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [editAction, setEditAction] = useState<ArtifactEditAction | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const items: PaneItem[] = [
    ...(message.artifacts ?? []).map((artifact) => ({
      id: artifact.artifactId,
      media: artifact.media === 'video' ? ('video' as const) : ('image' as const),
      load: () => sourceOrCanvas(artifact.artifactId, () => previewArtifactBitmap(artifact)),
      loadPreview: () =>
        canvasOrSource(
          artifact.artifactId,
          () => previewArtifactBitmap(artifact),
          INLINE_RESULT_THUMBNAIL_SCALE,
        ),
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
      loadPreview: () =>
        canvasOrSource(
          fetchedCanvasId(message.toolCallId, index),
          () => resolveMediaSource(`aip-media:${image.imageId}`, 'preview', true).catch(() => null),
          INLINE_RESULT_THUMBNAIL_SCALE,
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
  const source = loadedSource?.id === active?.id ? (loadedSource?.value ?? null) : null
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (zoomed) return
      if (document.querySelector('.studio-handoff-dialog, .studio-artifact-edit-dialog')) return
      if (event.key === 'Escape') onClose()
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && items.length > 1) {
        if (!target?.closest('.studio-artifact-pane')) return
        event.preventDefault()
        const index = items.findIndex((item) => item.id === active?.id)
        onSelect(
          items[(index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].id,
        )
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [active?.id, items.length, onClose, onSelect, zoomed])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadedSource(null)
    setPreview((previous) => (previous?.id === active?.id ? previous : null))
    setZoomed(false)
    if (!active) return
    // Show the same canvas preview as the result card while the original loads independently.
    void active
      .loadPreview()
      .catch(() => null)
      .then((next) => {
        if (alive && next) setPreview({ id: active.id, source: next })
      })
    void active
      .load()
      .catch(() => null)
      .then((next) => {
        if (!alive) return
        setLoadedSource({ id: active.id, value: next })
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [active?.id, message.delivery, retry])

  if (!active) return null
  const displaySource = source ?? (preview?.id === active.id ? preview.source : null)
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
  const startEdit = (action: ArtifactEditAction) => {
    if (!source || active.media !== 'image') return
    if (isClientCapabilityEnabled('billing:credits') && !requireAccount()) {
      onClose()
      return
    }
    setEditAction(action)
  }
  const generateEdit = (input: ArtifactEditInput, customInstruction: string) => {
    if (!editAction || editBusy) return
    const agent = useAgentStore.getState()
    if (agent.historyLoading || agent.historyFailed) {
      useStore.getState().showToast(t('tool.agentUnavailable'), 'error')
      return
    }
    const instruction = customInstruction || t(`tool.${editAction}`)
    setEditBusy(true)
    let accepted = false
    void agent
      .send(
        instruction,
        [{ imageId: active.id, name: message.title, editAction, ...input }],
        () => {
          accepted = true
          setEditAction(null)
          onClose()
        },
        'image',
      )
      .then((result) => {
        if (accepted || result === 'cancelled') return
        if (accountRequired()) {
          setEditAction(null)
          onClose()
        } else useStore.getState().showToast(t('tool.agentUnavailable'), 'error')
      })
      .catch((error) => {
        useStore
          .getState()
          .showToast(error instanceof Error ? error.message : String(error), 'error')
      })
      .finally(() => setEditBusy(false))
  }

  const pane = (
    <aside
      className="studio-artifact-pane"
      data-presentation={presentation}
      data-editing={Boolean(editAction)}
      role={presentation === 'panel' ? 'region' : 'dialog'}
      aria-modal={presentation === 'panel' ? undefined : true}
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
            poster={displaySource ?? undefined}
            src={active.videoUrl}
          />
        ) : displaySource ? (
          <button
            type="button"
            className="studio-artifact-pane-image"
            onClick={() => setZoomed(true)}
            aria-label={t('tool.zoomResult')}
          >
            <img src={displaySource} alt={message.title} />
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
          {!loading && !source && displaySource && (
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              {t('tool.retryPreview')}
            </button>
          )}
          {items.length > 1 && (
            <span>
              {items.findIndex((item) => item.id === active.id) + 1}/{items.length}
            </span>
          )}
        </div>
        <p className="studio-artifact-pane-caption" title={message.title}>
          {message.title}
        </p>
        {message.prompt && (
          <section className="studio-artifact-pane-prompt">
            <div>
              <span>
                {active.media === 'video' ? tv('landing.promptAria') : t('tool.imagePrompt')}
              </span>
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
            <div className="studio-artifact-pane-quick">
              <button type="button" onClick={() => setZoomed(true)}>
                <Expand size={15} aria-hidden="true" />
                {t('tool.zoomResult')}
              </button>
              <button type="button" onClick={() => void useAsReference()}>
                <ImagePlus size={15} aria-hidden="true" />
                {t('tool.useAsReference')}
              </button>
            </div>
          )}
          {active.media === 'image' && onViewCanvas && (
            <div className="studio-artifact-pane-canvas-action">
              <button
                type="button"
                className="studio-artifact-pane-edit"
                onClick={() => onViewCanvas([active.id])}
              >
                <Images size={15} aria-hidden="true" />
                {t('tool.editOnCanvas')}
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          {active.media === 'image' && (
            <div className="studio-artifact-pane-tools">
              <button type="button" onClick={() => startEdit('inpaint')} disabled={!source}>
                <Brush size={15} />
                {t('tool.inpaint')}
              </button>
              <button type="button" onClick={() => startEdit('erase')} disabled={!source}>
                <Eraser size={15} />
                {t('tool.erase')}
              </button>
              <button type="button" onClick={() => startEdit('crop')} disabled={!source}>
                <Crop size={15} />
                {t('tool.crop')}
              </button>
              <button type="button" onClick={() => startEdit('outpaint')} disabled={!source}>
                <Scan size={15} />
                {t('tool.outpaint')}
              </button>
            </div>
          )}
        </div>
      </div>
      {zoomed && displaySource && (
        <ImagePreview
          src={displaySource}
          originalPending={!source}
          onClose={() => setZoomed(false)}
        />
      )}
      {editAction && source && (
        <AgentArtifactEditDialog
          key={`${active.id}:${editAction}`}
          presentation={presentation}
          action={editAction}
          source={source}
          busy={editBusy}
          onClose={() => setEditAction(null)}
          onGenerate={generateEdit}
        />
      )}
    </aside>
  )
  return presentation === 'panel' ? pane : createPortal(pane, document.body)
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
