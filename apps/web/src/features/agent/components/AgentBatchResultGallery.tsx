import type { AgentBatchItemExecution, AgentToolArtifact } from '@image-playground/shared'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { ImageGeneration } from '../../../components/assistant-ui/elements/image-generation'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { ImagePreview } from '../../../components/Lightbox'
import { ModelLogo } from '../../../components/ModelIdentity'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { accountScope } from '../../../lib/authScope'
import { displayArtifactBitmap, previewArtifactBitmap } from '../lib/artifactSource'
import { type BatchDisplayStatus, batchItemStatus } from '../lib/batchStatusGroups'

function ResultThumbnail({
  artifact,
  index,
  onOpen,
  className = 'relative aspect-square h-auto w-full overflow-hidden rounded-md bg-muted p-0',
}: {
  artifact: AgentToolArtifact
  index: number
  onOpen: (artifact: AgentToolArtifact) => void
  className?: string
}) {
  const { t } = useTranslation(['agent', 'errors'])
  const [source, setSource] = useState<string | null | undefined>(undefined)
  // 批次跑着时卡片每次轮询都换一份新 JSON，产物对象身份跟着变；按取图用到的字段认同一张图，
  // 不然每拍都把已显示的缩略图重取一遍（没有媒体身份的产物取的是原图，还会挤掉 12 张的缓存）。
  const latest = useRef(artifact)
  latest.current = artifact
  const identity = `${artifact.artifactId}|${artifact.mediaId ?? ''}|${artifact.taskId}|${artifact.outputIndex}|${artifact.mime}`
  useEffect(() => {
    if (!identity) return
    let live = true
    const current = accountScope()
    void displayArtifactBitmap(latest.current).then(
      (bitmap) => {
        if (live && current()) setSource(bitmap)
      },
      () => {
        if (live && current()) setSource(null)
      },
    )
    return () => {
      live = false
    }
  }, [identity])
  const label = t('batch.viewResult', { index: index + 1 })
  return (
    <Button
      type="button"
      variant="outline"
      data-batch-result={artifact.artifactId}
      aria-label={label}
      title={label}
      className={className}
      onClick={() => onOpen(artifact)}
    >
      {source ? (
        <img src={source} alt={label} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Icon name={source === null ? 'warning' : 'image'} />
        </span>
      )}
    </Button>
  )
}

function useArtifactPreview() {
  const [preview, setPreview] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const loading = useRef(false)
  const open = async (artifact: AgentToolArtifact) => {
    if (loading.current) return
    loading.current = true
    const current = accountScope()
    setFailed(false)
    try {
      const source = await previewArtifactBitmap(artifact)
      if (current()) {
        setPreview(source)
        setFailed(source === null)
      }
    } finally {
      loading.current = false
    }
  }
  return { preview, setPreview, failed, open }
}

/**
 * 批量计划里已完成的产物，直接摊成缩略图。
 *
 * 之前产物只藏在每一项折叠行里的「查看结果 n」按钮后面，对话里一张图都不露：
 * 助手说「5 张都已生成」，用户看到的只有状态和提示词（台盆五个角度那次就是这样）。
 */
export default function AgentBatchResultGallery({
  artifacts,
}: {
  artifacts: readonly AgentToolArtifact[]
}) {
  const { t } = useTranslation(['agent', 'errors'])
  const { preview, setPreview, failed, open } = useArtifactPreview()
  const images = artifacts.filter((artifact) => artifact.media !== 'video')
  if (images.length === 0) return null
  return (
    <div className="grid gap-1" data-batch-results={images.length}>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${Math.min(images.length, 4)}, minmax(0, 1fr))` }}
      >
        {images.map((artifact, index) => (
          <ResultThumbnail
            key={artifact.artifactId}
            artifact={artifact}
            index={index}
            onOpen={(one) => void open(one)}
          />
        ))}
      </div>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t('errors:agentBatch.output_unavailable')}
        </p>
      )}
      {preview && <ImagePreview src={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

/** 生成中超过这么久就在图块上提示「比平时慢」。正常一张 30–90 秒（2026-10-30 线上 flare 中位 34 秒）。 */
export const BATCH_TILE_SLOW_AFTER_MS = 3 * 60_000

export interface AgentBatchTile {
  readonly key: string
  /** 计划里的第几项，从 1 起。 */
  readonly position: number
  readonly progress?: string
  readonly execution?: AgentBatchItemExecution
}

function tileIcon(status: BatchDisplayStatus) {
  if (status === 'in_flight' || status === 'in_progress') return 'loading' as const
  if (status === 'failed' || status === 'blocked' || status === 'reconciling')
    return 'warning' as const
  if (status === 'cancelled') return 'blocked' as const
  return 'clock' as const
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** 只有确实有项在跑时才每秒走一次，用来刷新图块上的已用时间。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

export interface AgentBatchRunMeta {
  readonly model?: { readonly id: string; readonly name: string }
  /** 尺寸、比例等，按出现顺序用分隔点排开。 */
  readonly tags: readonly string[]
}

/**
 * 确认之后对话里那一排生成卡：每张一个同尺寸的格子，各自显示排队、生成中（含已用时间）、
 * 比平时慢、失败、已取消，出图后原位换成图。外观与单次生图的结果行同一套（`studio-agent-inline-*`），
 * 计划卡只留确认前查看、修改提示词。生成中的格子悬停时中间的进度换成取消键（只撤这一张），
 * 触屏没有悬停，右上角常驻一个小取消键。
 */
export function AgentBatchRunRow({
  tiles,
  meta,
  cancelling,
  cancelFailed,
  onCancel,
  actions,
}: {
  tiles: readonly AgentBatchTile[]
  meta: AgentBatchRunMeta
  cancelling: ReadonlySet<string>
  cancelFailed?: boolean
  onCancel?: (key: string) => void
  actions?: ReactNode
}) {
  const { t } = useTranslation(['agent', 'errors'])
  const { preview, setPreview, failed, open } = useArtifactPreview()
  const running = tiles.some(
    (tile) => batchItemStatus(tile) === 'in_progress' || batchItemStatus(tile) === 'in_flight',
  )
  const now = useNow(running)
  if (tiles.length === 0) return null
  const done = tiles.filter((tile) => batchItemStatus(tile) === 'completed').length
  const cells = tiles.flatMap((tile) => {
    const status = batchItemStatus(tile)
    const images =
      status === 'completed'
        ? (tile.execution?.artifacts ?? []).filter((artifact) => artifact.media !== 'video')
        : []
    if (images.length > 0)
      return images.map((artifact, index) => (
        <div
          key={`${tile.key}:${artifact.artifactId}`}
          className="studio-agent-inline-tile-wrap"
          data-batch-tile={tile.key}
          data-batch-status={status}
        >
          <ResultThumbnail
            artifact={artifact}
            index={tile.position - 1 + index}
            onOpen={(one) => void open(one)}
            className="studio-agent-inline-tile h-auto border-0 p-0"
          />
        </div>
      ))
    const live = status === 'in_progress' || status === 'in_flight'
    const startedAt = live ? tile.execution?.startedAt : undefined
    const elapsed = typeof startedAt === 'number' ? now - startedAt : null
    const slow = elapsed !== null && elapsed >= BATCH_TILE_SLOW_AFTER_MS
    const urgent = status === 'failed' || status === 'blocked' || status === 'reconciling'
    const label = live
      ? tile.execution?.status === 'queued'
        ? t('job.phase.queued')
        : t('batch.itemStatus.in_progress')
      : t(`batch.itemStatus.${status}`)
    const stopping = cancelling.has(tile.key)
    return [
      <div
        key={tile.key}
        className="studio-agent-inline-tile-wrap"
        data-batch-tile={tile.key}
        data-batch-status={status}
      >
        <div
          className="studio-agent-inline-tile"
          data-pending="true"
          // group 而不是 img：img 会把后代当成图像内容，读屏发现不了里面的取消按钮。
          role="group"
          aria-label={t('batch.tileLabel', { index: tile.position, status: label })}
        >
          {live && (
            <ImageGeneration
              generating
              className="pointer-events-none absolute inset-0 aspect-auto h-full w-full rounded-none"
            />
          )}
          <span className="absolute left-2 top-2 z-[1] rounded-sm bg-black/55 px-1 font-mono text-label-sm text-white">
            {tile.position}
          </span>
          <div className="studio-agent-tile-face">
            <Icon
              name={tileIcon(status)}
              className={
                live
                  ? 'animate-spin text-muted-foreground motion-reduce:animate-none'
                  : urgent
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              }
            />
            <span className={`studio-agent-tile-caption${urgent ? ' text-destructive' : ''}`}>
              {label}
            </span>
            {elapsed !== null && (
              <span className="font-mono text-label-sm tabular-nums text-muted-foreground">
                {formatElapsed(elapsed)}
              </span>
            )}
            {slow && (
              <span role="status" className="px-1 text-center text-label-sm text-warning">
                {t('batch.tileSlow')}
              </span>
            )}
          </div>
          {live && onCancel && (
            <TooltipIconButton
              tooltip={
                stopping ? t('job.cancelling') : t('batch.cancelTile', { index: tile.position })
              }
              disabled={stopping}
              className="studio-agent-tile-cancel"
              data-batch-cancel={tile.key}
              onClick={() => onCancel(tile.key)}
            >
              <Icon
                name={stopping ? 'loading' : 'close'}
                className={stopping ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
            </TooltipIconButton>
          )}
        </div>
      </div>,
    ]
  })
  return (
    <div
      className="studio-agent-inline-result studio-agent-inline-result--generated studio-agent-inline-result--batch"
      data-batch-run={tiles.length}
      style={{ '--batch-count': String(cells.length) } as CSSProperties}
    >
      <div className="studio-agent-batch-meta">
        {meta.model && (
          <span className="inline-flex items-center gap-1">
            <ModelLogo model={meta.model.id} />
            <span>{meta.model.name}</span>
          </span>
        )}
        {meta.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
        <span>{t('job.doneCount', { done, total: tiles.length })}</span>
      </div>
      <div
        className="studio-agent-inline-gallery"
        data-count={cells.length}
        aria-label={t('batch.tiles')}
        data-batch-tiles={tiles.length}
      >
        {cells}
      </div>
      {cancelFailed && (
        <p role="alert" className="text-xs text-destructive">
          {t('job.cancelFailed')}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t('errors:agentBatch.output_unavailable')}
        </p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      {preview && <ImagePreview src={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
