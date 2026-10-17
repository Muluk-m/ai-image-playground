import { useEffect, useState } from 'react'
import { accountRequired, requireAccount } from '../../../auth/loginPrompt'
import { ImagePreview } from '../../../components/Lightbox'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { OverflowText } from '../../../components/ui/overflowTitle'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { useStore } from '../../../store'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import type { ArtifactEditAction, ArtifactEditInput } from '../lib/artifactEdit'
import { INLINE_RESULT_THUMBNAIL_SCALE } from '../lib/artifactPreview'
import { previewArtifactBitmap } from '../lib/artifactSource'
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

/** 返回和翻页的固定尺寸由 Button 档位给出；样式表里的同权重单类会被工具类盖住。 */
const BACK_BUTTON = 'hover:bg-muted hover:text-foreground'
/** 翻页钮是圆的。默认 rounded-md 会把它们变成方钮。 */
const PAGER_BUTTON = 'rounded-full bg-muted/70 hover:bg-muted/70 hover:text-foreground'
/** 大图本身就是按钮。固定高度和内边距会压扁图片；inline-flex 会盖住 grid，宽图就撑出查看器。 */
const IMAGE_BUTTON = 'grid h-auto w-auto max-h-full max-w-full p-0 font-normal hover:bg-transparent'
/** 加载失败的重试是一行字。颜色由 .studio-artifact-pane-loading button 决定。 */
const RETRY_LINK = 'h-auto px-0 py-0 text-xs font-normal hover:bg-transparent hover:text-primary'
/** 字号、字重和悬停色由 .studio-artifact-pane-primary button 决定。 */
const PRIMARY_ACTION = 'h-auto bg-transparent px-0 py-0 hover:bg-transparent'
/** 30px 热区由 .studio-artifact-pane-prompt > div button 决定。 */
const COPY_BUTTON = 'p-0'
/** 高度、内边距和悬停由 .studio-artifact-pane-actions button 决定。 */
const TOOL_ACTION = 'h-auto'
/** 缩略图原为 58px。Button 的 h-9 和样式表单类同一权重，后写的工具类会赢，所以用相邻的 56px 档。 */
const THUMB_BUTTON = 'h-14 w-14 basis-14 shrink-0 p-0 hover:bg-muted'

export default function AgentArtifactPane({
  message,
  selectedId,
  initialPreview,
  onSelect,
  onClose,
  onViewCanvas: _onViewCanvas,
  presentation = 'overlay',
}: {
  presentation?: 'panel' | 'overlay'
  message: AgentToolMessage
  selectedId?: string
  initialPreview?: { readonly id: string; readonly source: string } | null
  onSelect: (id: string) => void
  onClose: () => void
  onViewCanvas?: (objectIds?: readonly string[]) => void
}) {
  const { t } = useTranslation('agent')
  const { t: tv } = useTranslation('video')
  const [loadedSource, setLoadedSource] = useState<{ id: string; value: string | null } | null>(
    null,
  )
  const [preview, setPreview] = useState<{ id: string; source: string } | null>(
    initialPreview ?? null,
  )
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
  useEffect(() => setZoomed(false), [active?.id])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (zoomed) return
      if (document.querySelector('.studio-handoff-dialog, .studio-artifact-edit-dialog')) return
      if (event.key === 'Escape' && presentation === 'panel') onClose()
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
  }, [active?.id, items.length, onClose, onSelect, zoomed, presentation])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadedSource(null)
    const visiblePreview = initialPreview?.id === active?.id ? initialPreview : null
    setPreview((previous) => visiblePreview ?? (previous?.id === active?.id ? previous : null))
    if (!active) return
    // Show the same canvas preview as the result card while the original loads independently.
    if (!visiblePreview)
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
  }, [active?.id, message.delivery, retry, initialPreview])

  if (!active) return null
  const displaySource =
    source ??
    (preview?.id === active.id ? preview.source : null) ??
    (initialPreview?.id === active.id ? initialPreview.source : null)
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
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className={`studio-artifact-pane-back ${BACK_BUTTON}`}
        onClick={onClose}
        aria-label={t('tool.backToChat')}
        title={t('tool.backToChat')}
      >
        <Icon name="chevronLeft" />
      </Button>
      <div className="studio-artifact-pane-viewer">
        {items.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className={`studio-artifact-pane-prev ${PAGER_BUTTON}`}
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
            <Icon name="chevronLeft" />
          </Button>
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
          <Button
            type="button"
            variant="ghost"
            className={`studio-artifact-pane-image ${IMAGE_BUTTON}`}
            onClick={() => setZoomed(true)}
            aria-label={t('tool.zoomResult')}
          >
            <img src={displaySource} alt={message.title} />
          </Button>
        ) : (
          <div className="studio-artifact-pane-loading" role="status">
            {loading ? (
              t('tool.loadingPreview')
            ) : (
              <>
                <span>{t('tool.previewUnavailable')}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className={RETRY_LINK}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  {t('tool.retryPreview')}
                </Button>
              </>
            )}
          </div>
        )}
        {items.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className={`studio-artifact-pane-next ${PAGER_BUTTON}`}
            aria-label={t('tool.nextResult')}
            onClick={() =>
              onSelect(
                items[(items.findIndex((item) => item.id === active.id) + 1) % items.length].id,
              )
            }
          >
            <Icon name="chevronRight" />
          </Button>
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
          {!loading && !source && displaySource && (
            <Button
              type="button"
              variant="ghost"
              className={PRIMARY_ACTION}
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('tool.retryPreview')}
            </Button>
          )}
          {items.length > 1 && (
            <span>
              {items.findIndex((item) => item.id === active.id) + 1}/{items.length}
            </span>
          )}
        </div>
        <OverflowText as="p" text={message.title} className="studio-artifact-pane-caption" />
        {message.prompt && (
          <section className="studio-artifact-pane-prompt">
            <div>
              <span>
                {active.media === 'video' ? tv('landing.promptAria') : t('tool.imagePrompt')}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={COPY_BUTTON}
                onClick={() => {
                  void copyTextToClipboard(message.prompt ?? '').then(
                    () => useStore.getState().showToast(t('promptDialog.copied'), 'success'),
                    (error) =>
                      useStore
                        .getState()
                        .showToast(
                          getClipboardFailureMessage(t('promptDialog.copyFailed'), error),
                          'error',
                        ),
                  )
                }}
                aria-label={t('tool.copyPrompt')}
                title={t('tool.copyPrompt')}
              >
                <Icon name="copy" />
              </Button>
            </div>
            <p className="studio-artifact-pane-prompt-text" tabIndex={0}>
              {message.prompt}
            </p>
          </section>
        )}
        <div className="studio-artifact-pane-actions">
          {active.media === 'image' && source && (
            <div className="studio-artifact-pane-quick">
              <Button
                type="button"
                variant="ghost"
                className={TOOL_ACTION}
                onClick={() => setZoomed(true)}
              >
                <Icon name="zoomIn" />
                {t('tool.zoomResult')}
              </Button>
            </div>
          )}
          {active.media === 'image' && (
            <div className="studio-artifact-pane-tools">
              <Button
                type="button"
                variant="ghost"
                className={TOOL_ACTION}
                onClick={() => startEdit('erase')}
                disabled={!source}
              >
                <Icon name="erase" />
                {t('tool.erase')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={TOOL_ACTION}
                onClick={() => startEdit('crop')}
                disabled={!source}
              >
                <Icon name="crop" />
                {t('tool.crop')}
              </Button>
            </div>
          )}
        </div>
      </div>
      {zoomed && displaySource && (
        <ImagePreview
          tier="artifact"
          src={displaySource}
          originalPending={!source && loading}
          originalFailed={!source && !loading}
          onRetryOriginal={() => setRetry((value) => value + 1)}
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
  return presentation === 'panel' ? (
    pane
  ) : (
    <Overlay onClose={onClose} tier="review" layout="fill" backdrop="none" role="none">
      {pane}
    </Overlay>
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
    <Button
      type="button"
      variant="ghost"
      className={`studio-artifact-pane-thumb ${THUMB_BUTTON}`}
      aria-label={`${index + 1}`}
      aria-pressed={selected}
      onClick={() => onSelect(item.id)}
    >
      {source && <img src={source} alt="" />}
      <span>{index + 1}</span>
    </Button>
  )
}
