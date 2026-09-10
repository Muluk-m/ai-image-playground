import { useEffect, useState } from 'react'
import { useImageThumbnail } from '../../../hooks/useImageThumbnail'
import type { ProductShotVersion } from '../types'
import { renderKitImage } from './render'

export default function WorkflowImage({
  imageId,
  version,
  alt,
  className = 'w-full rounded-lg',
}: {
  imageId?: string
  version?: ProductShotVersion
  alt: string
  className?: string
}) {
  const thumbnail = useImageThumbnail(imageId)
  const [rendered, setRendered] = useState<{ key: string; url: string } | null>(null)
  const spec = version?.workflow?.spec
  const key = spec?.kind === 'kit' ? `${imageId}:${spec.format}:${spec.title}` : ''
  useEffect(() => {
    if (!imageId || !version || !key) return
    let cancelled = false,
      url: string | undefined
    void renderKitImage(imageId, version)
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setRendered({ key, url })
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [imageId, key, version])
  const src = rendered?.key === key ? rendered.url : thumbnail?.dataUrl
  return src ? (
    <img draggable={false} src={src} alt={alt} className={className} />
  ) : (
    <div className="flex aspect-square items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500 dark:bg-gray-800">
      图片加载中
    </div>
  )
}
