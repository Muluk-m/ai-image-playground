import type { GenerationDetail } from '@image-playground/shared'
import { Download, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { scopedStorageName } from '../lib/authScope'
import { resolveMediaSource } from '../lib/cloudMedia'
import { downloadBlob } from '../lib/downloadImages'
import { reuseCloudGeneration } from '../lib/reuseCloudGeneration'
import MediaImage from './MediaImage'
import { Button } from './ui/button'

export default function CloudGenerationDetail({ detail }: { detail: GenerationDetail }) {
  const { t } = useTranslation('task')
  const controller = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'reuseFailed' | 'modelUnavailable' | 'downloadFailed' | null>(
    null,
  )
  useEffect(() => () => controller.current?.abort(), [])
  async function reuse() {
    controller.current?.abort()
    const operation = new AbortController()
    controller.current = operation
    setBusy(true)
    setError(null)
    try {
      await reuseCloudGeneration(detail, operation.signal)
    } catch (cause) {
      if (!operation.signal.aborted)
        setError(
          cause instanceof Error && cause.message === 'model_unavailable'
            ? 'modelUnavailable'
            : 'reuseFailed',
        )
    } finally {
      if (!operation.signal.aborted) setBusy(false)
    }
  }
  async function download(image: GenerationDetail['outputs'][number]) {
    const operation = new AbortController()
    controller.current?.abort()
    controller.current = operation
    const scope = scopedStorageName('generation-history')
    setBusy(true)
    setError(null)
    try {
      const data = await resolveMediaSource(`aip-media:${image.mediaId}`)
      const blob = await (await fetch(data, { signal: operation.signal })).blob()
      operation.signal.throwIfAborted()
      if (scope !== scopedStorageName('generation-history')) return
      const extension = image.contentType.split('/')[1] ?? 'png'
      downloadBlob(blob, `muvloom-${detail.id.slice(0, 8)}-${image.index + 1}.${extension}`)
    } catch {
      if (!operation.signal.aborted && scope === scopedStorageName('generation-history'))
        setError('downloadFailed')
    } finally {
      if (!operation.signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {detail.archiveStatus === 'unavailable' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('cloudHistory.unavailable')}
        </p>
      )}
      <p className="whitespace-pre-wrap break-words text-sm">{detail.prompt}</p>
      {detail.outputs.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {detail.outputs.map((image) => (
            <figure
              key={image.index}
              className="overflow-hidden rounded-xl border border-border bg-muted/30"
            >
              <MediaImage
                src={`aip-media:${image.mediaId}`}
                alt={t('cloudHistory.output', { number: image.index + 1 })}
                loading="lazy"
                className="aspect-square w-full object-contain"
              />
              <figcaption className="flex items-center justify-between gap-2 p-3">
                <span className="text-xs text-muted-foreground">
                  {image.width && image.height
                    ? `${image.width} × ${image.height}`
                    : image.contentType}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void download(image)}
                >
                  <Download size={14} />
                  {t('cloudHistory.download')}
                </Button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {detail.inputs.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('cloudHistory.references')}</p>
          <div className="flex flex-wrap gap-2">
            {detail.inputs.map((image) => (
              <MediaImage
                key={image.index}
                src={`aip-media:${image.mediaId}`}
                alt={t('cloudHistory.reference', { number: image.index + 1 })}
                loading="lazy"
                className="h-16 w-16 rounded-lg bg-muted object-cover"
              />
            ))}
            {detail.mask && (
              <MediaImage
                src={`aip-media:${detail.mask.mediaId}`}
                alt={t('cloudHistory.mask')}
                loading="lazy"
                className="h-16 w-16 rounded-lg bg-muted object-contain"
              />
            )}
          </div>
        </div>
      )}
      <Button variant="outline" disabled={busy} onClick={() => void reuse()}>
        <RotateCcw size={16} />
        {t(busy ? 'cloudHistory.preparing' : 'cloudHistory.reuse')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`cloudHistory.${error}`)}
        </p>
      )}
    </div>
  )
}
