import type { AgentBatchItemExecution, AgentToolArtifact } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { ImagePreview } from '../../../components/Lightbox'
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

const TILE = 'relative aspect-square w-24 shrink-0 overflow-hidden rounded-md sm:w-28'

/**
 * 多张生成排成一横排同尺寸的占位图块：每块各自显示排队、生成中（含已用时间）、失败，
 * 出图后原位换成缩略图。取代原来逐项展开的表单式列表，计划细节收进卡片下方的折叠区。
 */
export function AgentBatchTileStrip({ tiles }: { tiles: readonly AgentBatchTile[] }) {
  const { t } = useTranslation(['agent', 'errors'])
  const { preview, setPreview, failed, open } = useArtifactPreview()
  const running = tiles.some(
    (tile) => batchItemStatus(tile) === 'in_progress' || batchItemStatus(tile) === 'in_flight',
  )
  const now = useNow(running)
  if (tiles.length === 0) return null
  return (
    <div className="grid gap-1">
      <ul
        className="flex gap-2 overflow-x-auto pb-1"
        aria-label={t('batch.tiles')}
        data-batch-tiles={tiles.length}
      >
        {tiles.flatMap((tile) => {
          const status = batchItemStatus(tile)
          const images =
            status === 'completed'
              ? (tile.execution?.artifacts ?? []).filter((artifact) => artifact.media !== 'video')
              : []
          if (images.length > 0)
            return images.map((artifact, index) => (
              <li
                key={`${tile.key}:${artifact.artifactId}`}
                className="shrink-0"
                data-batch-tile={tile.key}
                data-batch-status={status}
              >
                <ResultThumbnail
                  artifact={artifact}
                  index={tile.position - 1 + index}
                  onOpen={(one) => void open(one)}
                  className={`${TILE} h-auto bg-muted p-0`}
                />
              </li>
            ))
          const live = status === 'in_progress' || status === 'in_flight'
          const startedAt = live ? tile.execution?.startedAt : undefined
          const elapsed = typeof startedAt === 'number' ? now - startedAt : null
          const slow = elapsed !== null && elapsed >= BATCH_TILE_SLOW_AFTER_MS
          const urgent = status === 'failed' || status === 'blocked' || status === 'reconciling'
          const label = t(`batch.itemStatus.${status}`)
          return [
            <li
              key={tile.key}
              data-batch-tile={tile.key}
              data-batch-status={status}
              aria-label={t('batch.tileLabel', { index: tile.position, status: label })}
              className={`${TILE} flex flex-col items-center justify-center gap-1 border border-border bg-muted text-xs ${live ? 'animate-pulse motion-reduce:animate-none' : ''}`}
            >
              <span className="absolute left-1 top-1 rounded-sm bg-black/55 px-1 font-mono text-label-sm text-white">
                {tile.position}
              </span>
              <Icon
                name={tileIcon(status)}
                className={
                  live
                    ? 'animate-spin text-foreground motion-reduce:animate-none'
                    : urgent
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                }
              />
              <span className={urgent ? 'text-destructive' : 'text-muted-foreground'}>{label}</span>
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
            </li>,
          ]
        })}
      </ul>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t('errors:agentBatch.output_unavailable')}
        </p>
      )}
      {preview && <ImagePreview src={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
