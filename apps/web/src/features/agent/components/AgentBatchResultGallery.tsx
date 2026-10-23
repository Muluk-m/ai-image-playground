import type { AgentToolArtifact } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { ImagePreview } from '../../../components/Lightbox'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { accountScope } from '../../../lib/authScope'
import { displayArtifactBitmap, previewArtifactBitmap } from '../lib/artifactSource'

function ResultThumbnail({
  artifact,
  index,
  onOpen,
}: {
  artifact: AgentToolArtifact
  index: number
  onOpen: (artifact: AgentToolArtifact) => void
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
      className="relative aspect-square h-auto w-full overflow-hidden rounded-md bg-muted p-0"
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
  const [preview, setPreview] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const loading = useRef(false)
  const images = artifacts.filter((artifact) => artifact.media !== 'video')
  if (images.length === 0) return null
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
