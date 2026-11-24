import { type DragEvent, type MouseEvent, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { BATCH_GENERATE_MAX, batchSharedMax } from '../../lib/batchGenerate'
import { cn } from '../../lib/utils'
import type { InputImage } from '../../types'
import { Hint } from '../assistant-ui/elements/tooltip-icon-button'
import MediaImage from '../MediaImage'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

type BatchZoneKind = 'loop' | 'shared'
const DRAG_MIME = 'application/x-aip-batch-zone'

interface DragPayload {
  zone: BatchZoneKind
  index: number
}

/**
 * 批量生图双分区参考区：
 * - 左区「遍历原图」：每张图独立生成 1 张（最多 50 张），提示词里以 `@当前图` 指代。
 * - 右区「共用参考」：可选，每条任务均附带（最多单次上限 - 1 张），以 `@参考1..k` 指代。
 * 两区之间靠 1px 发丝线分隔，支持缩略图双向拖拽互移，以及点左图 `@` 自动移入共用参考并插入引用。
 */
export function BatchDualZone({
  loopImages,
  sharedImages,
  mergeLimit,
  oversizedLoopIndexes,
  oversizedSharedIndexes,
  failedLoopIndexes,
  failedSharedIndexes,
  disabled = false,
  canAttach = true,
  justMovedSharedId,
  onAddLoop,
  onAddShared,
  onRemoveLoop,
  onRemoveShared,
  onClearLoop,
  onClearShared,
  onInsertCurrentMention,
  onInsertSharedMention,
  onPromoteLoopToShared,
  onDemoteSharedToLoop,
  onPreviewImage,
  onDropFiles,
}: {
  loopImages: readonly InputImage[]
  sharedImages: readonly InputImage[]
  mergeLimit: number
  oversizedLoopIndexes: readonly number[]
  oversizedSharedIndexes: readonly number[]
  failedLoopIndexes: readonly number[]
  failedSharedIndexes: readonly number[]
  disabled?: boolean
  canAttach?: boolean
  justMovedSharedId?: string | null
  onAddLoop: (event: MouseEvent<HTMLButtonElement>) => void
  onAddShared: (event: MouseEvent<HTMLButtonElement>) => void
  onRemoveLoop: (index: number) => void
  onRemoveShared: (index: number) => void
  onClearLoop: () => void
  onClearShared: () => void
  onInsertCurrentMention: () => void
  onInsertSharedMention: (sharedIndex: number) => void
  onPromoteLoopToShared: (loopIndex: number, insertMention: boolean) => void
  onDemoteSharedToLoop: (sharedIndex: number) => void
  onPreviewImage: (imageId: string, list: string[]) => void
  onDropFiles?: (zone: BatchZoneKind, files: FileList) => void
}) {
  const { t } = useTranslation('composer')
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  const [dropZone, setDropZone] = useState<BatchZoneKind | null>(null)
  const [sharedPickOpen, setSharedPickOpen] = useState(false)
  const suppressFocusReturnRef = useRef(false)

  const sharedMax = batchSharedMax(mergeLimit)
  const allPreviewIds = [...loopImages.map((img) => img.id), ...sharedImages.map((img) => img.id)]

  const isLoopBad = (index: number) =>
    oversizedLoopIndexes.includes(index) || failedLoopIndexes.includes(index)
  const isSharedBad = (index: number) =>
    oversizedSharedIndexes.includes(index) || failedSharedIndexes.includes(index)

  const startDrag = (zone: BatchZoneKind, index: number) => (event: DragEvent<HTMLDivElement>) => {
    const payload: DragPayload = { zone, index }
    setDragging(payload)
    event.dataTransfer.effectAllowed = 'move'
    try {
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
    } catch {
      // jsdom or restricted environments may not support custom MIME types
    }
  }

  const endDrag = () => {
    setDragging(null)
    setDropZone(null)
  }

  const handleZoneDragOver = (target: BatchZoneKind) => (event: DragEvent<HTMLDivElement>) => {
    if (disabled) return
    const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files')
    if (dragging && dragging.zone !== target) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      if (dropZone !== target) setDropZone(target)
      return
    }
    if (hasFiles && onDropFiles) {
      event.preventDefault()
      event.stopPropagation()
      if (dropZone !== target) setDropZone(target)
    }
  }

  const handleZoneDragLeave = (target: BatchZoneKind) => (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    if (dropZone === target) setDropZone(null)
  }

  const handleZoneDrop = (target: BatchZoneKind) => (event: DragEvent<HTMLDivElement>) => {
    if (disabled) return
    let payload = dragging
    if (!payload) {
      try {
        const raw = event.dataTransfer?.getData(DRAG_MIME)
        if (raw) payload = JSON.parse(raw) as DragPayload
      } catch {
        payload = null
      }
    }
    setDragging(null)
    setDropZone(null)

    if (payload && payload.zone !== target) {
      event.preventDefault()
      event.stopPropagation()
      if (target === 'shared') onPromoteLoopToShared(payload.index, false)
      else onDemoteSharedToLoop(payload.index)
      return
    }

    const files = event.dataTransfer?.files
    if (files && files.length > 0 && onDropFiles) {
      event.preventDefault()
      event.stopPropagation()
      onDropFiles(target, files)
    }
  }

  const loopFull = loopImages.length >= BATCH_GENERATE_MAX || !canAttach
  const sharedFull = sharedImages.length >= sharedMax || !canAttach

  return (
    <div className="creation-batch-zones" data-testid="batch-dual-zone">
      {/* 左区：遍历原图 */}
      <div
        className={cn(
          'creation-batch-pane creation-batch-pane-loop',
          dropZone === 'loop' && 'creation-batch-pane-drop',
        )}
        data-testid="batch-zone-loop"
        onDragOver={handleZoneDragOver('loop')}
        onDragLeave={handleZoneDragLeave('loop')}
        onDrop={handleZoneDrop('loop')}
      >
        {dropZone === 'loop' && (
          <div className="creation-batch-drop-veil" aria-hidden="true">
            {t('batch.dropToLoop')}
          </div>
        )}
        <div className="creation-batch-pane-head">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-xs font-medium text-foreground">
              {t('batch.loopTitle')}
            </span>
            <span className="font-mono text-label-sm tabular-nums text-muted-foreground">
              {loopImages.length}/{BATCH_GENERATE_MAX}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              className="creation-batch-cite-btn"
              onClick={onInsertCurrentMention}
            >
              {t('batch.currentMention')}
            </Button>
            {loopImages.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                className="creation-batch-quiet-btn"
                onClick={onClearLoop}
              >
                {t('batch.clearZone')}
              </Button>
            )}
          </div>
        </div>
        <div className="creation-batch-strip">
          {loopImages.map((img, idx) => {
            const bad = isLoopBad(idx)
            const isDraggingThis = dragging?.zone === 'loop' && dragging.index === idx
            return (
              <div
                key={img.id}
                draggable={!disabled}
                onDragStart={startDrag('loop', idx)}
                onDragEnd={endDrag}
                data-batch-loop-index={idx}
                className={cn(
                  'creation-batch-thumb group',
                  isDraggingThis && 'opacity-40',
                  bad && 'ring-2 ring-destructive',
                )}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="h-full w-full rounded-none p-0"
                  aria-label={t('batch.loopThumbAria', { index: idx + 1 })}
                  onClick={() => onPreviewImage(img.id, allPreviewIds)}
                >
                  <MediaImage
                    src={img.dataUrl}
                    alt=""
                    className="pointer-events-none h-full w-full object-cover"
                  />
                </Button>
                {bad && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-background/60 text-destructive"
                  >
                    <Icon name="error" size="sm" />
                  </span>
                )}
                {!disabled && !bad && (
                  <Hint tooltip={t('batch.promoteHint')} side="bottom">
                    <Button
                      type="button"
                      variant="ghost"
                      className="creation-batch-thumb-cite"
                      aria-label={t('batch.promoteThumbAria', { index: idx + 1 })}
                      onClick={(event) => {
                        event.stopPropagation()
                        onPromoteLoopToShared(idx, true)
                      }}
                    >
                      {t('batch.citeAction')}
                    </Button>
                  </Hint>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  className="creation-reference-remove opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={t('studio.removeReference', { index: idx + 1 })}
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemoveLoop(idx)
                  }}
                >
                  <Icon name="close" size="xs" />
                </Button>
              </div>
            )
          })}
          <Button
            type="button"
            variant="ghost"
            className="creation-add creation-batch-add"
            aria-label={t('batch.addLoop')}
            aria-disabled={loopFull || disabled || undefined}
            title={
              !canAttach
                ? t('image.addFailed', { reason: t('param.modelUnavailable') })
                : loopFull
                  ? t('batch.loopLimitReached', { max: BATCH_GENERATE_MAX })
                  : undefined
            }
            onClick={(event) => !loopFull && !disabled && onAddLoop(event)}
          >
            <Icon name="add" />
          </Button>
        </div>
      </div>

      <div className="creation-batch-divider" aria-hidden="true" />

      {/* 右区：共用参考 */}
      <div
        className={cn(
          'creation-batch-pane creation-batch-pane-shared',
          dropZone === 'shared' && 'creation-batch-pane-drop',
        )}
        data-testid="batch-zone-shared"
        onDragOver={handleZoneDragOver('shared')}
        onDragLeave={handleZoneDragLeave('shared')}
        onDrop={handleZoneDrop('shared')}
      >
        {dropZone === 'shared' && (
          <div className="creation-batch-drop-veil" aria-hidden="true">
            {t('batch.dropToShared')}
          </div>
        )}
        <div className="creation-batch-pane-head">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-xs font-medium text-muted-foreground">
              {t('batch.sharedTitle')}
            </span>
            <span className="font-mono text-label-sm tabular-nums text-muted-foreground">
              {sharedImages.length > 0
                ? `${sharedImages.length}/${sharedMax}`
                : t('batch.sharedOptional')}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {sharedImages.length === 1 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                className="creation-batch-cite-btn"
                onClick={() => onInsertSharedMention(0)}
              >
                {t('batch.sharedMention', { n: 1 })}
              </Button>
            )}
            {sharedImages.length > 1 && (
              <Popover open={sharedPickOpen} onOpenChange={setSharedPickOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={disabled}
                    className="creation-batch-cite-btn gap-0.5"
                  >
                    <span>{t('batch.sharedMentionPick')}</span>
                    <Icon name="chevronDown" size="xs" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  collisionPadding={12}
                  onCloseAutoFocus={(event) => {
                    if (suppressFocusReturnRef.current) {
                      suppressFocusReturnRef.current = false
                      event.preventDefault()
                    }
                  }}
                  className="w-44 rounded-xl p-1.5 shadow-popover"
                >
                  <div className="flex flex-col gap-0.5">
                    {sharedImages.map((img, idx) => (
                      <Button
                        key={img.id}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start gap-2 px-2 text-xs font-normal"
                        onClick={() => {
                          suppressFocusReturnRef.current = true
                          setSharedPickOpen(false)
                          onInsertSharedMention(idx)
                        }}
                      >
                        <MediaImage
                          src={img.dataUrl}
                          alt=""
                          className="h-5 w-4 shrink-0 rounded-sm object-cover"
                        />
                        <span className="truncate">{t('batch.sharedMention', { n: idx + 1 })}</span>
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {sharedImages.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                className="creation-batch-quiet-btn"
                onClick={onClearShared}
              >
                {t('batch.clearZone')}
              </Button>
            )}
          </div>
        </div>
        <div className="creation-batch-strip items-center">
          {sharedImages.map((img, idx) => {
            const bad = isSharedBad(idx)
            const isDraggingThis = dragging?.zone === 'shared' && dragging.index === idx
            const isHighlighted = justMovedSharedId === img.id
            return (
              <div
                key={img.id}
                draggable={!disabled}
                onDragStart={startDrag('shared', idx)}
                onDragEnd={endDrag}
                data-batch-shared-index={idx}
                className={cn(
                  'creation-batch-thumb group',
                  isDraggingThis && 'opacity-40',
                  isHighlighted && 'ring-2 ring-primary',
                  bad && 'ring-2 ring-destructive',
                )}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="h-full w-full rounded-none p-0"
                  aria-label={t('batch.sharedThumbAria', { n: idx + 1 })}
                  onClick={() => onPreviewImage(img.id, allPreviewIds)}
                >
                  <MediaImage
                    src={img.dataUrl}
                    alt=""
                    className="pointer-events-none h-full w-full object-cover"
                  />
                </Button>
                {bad && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-background/60 text-destructive"
                  >
                    <Icon name="error" size="sm" />
                  </span>
                )}
                <span className="creation-batch-ref-badge">
                  {t('batch.sharedShortBadge', { n: idx + 1 })}
                </span>
                {!disabled && !bad && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="creation-batch-thumb-cite"
                    aria-label={t('batch.insertSharedAria', { n: idx + 1 })}
                    onClick={(event) => {
                      event.stopPropagation()
                      onInsertSharedMention(idx)
                    }}
                  >
                    {t('batch.sharedMention', { n: idx + 1 })}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  className="creation-reference-remove opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={t('batch.removeSharedAria', { n: idx + 1 })}
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemoveShared(idx)
                  }}
                >
                  <Icon name="close" size="xs" />
                </Button>
              </div>
            )
          })}
          <Button
            type="button"
            variant="ghost"
            className="creation-add creation-batch-add"
            aria-label={t('batch.addShared')}
            aria-disabled={sharedFull || disabled || undefined}
            title={
              !canAttach
                ? t('image.addFailed', { reason: t('param.modelUnavailable') })
                : sharedFull
                  ? t('batch.sharedLimitReached', { max: sharedMax })
                  : undefined
            }
            onClick={(event) => !sharedFull && !disabled && onAddShared(event)}
          >
            <Icon name="add" />
          </Button>
          {sharedImages.length === 0 && (
            <span className="pl-1 text-label-sm leading-snug text-muted-foreground">
              {t('batch.sharedEmptyHint')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
