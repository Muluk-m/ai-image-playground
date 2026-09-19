import { useEffect } from 'react'
import { useImagePreview } from '../../../hooks/useImagePreview'
import { ensureAssetImage } from '../../../lib/sync/assetImages'

export default function AssetThumb({ imageId, alt }: { imageId: string; alt: string }) {
  const preview = useImagePreview(imageId)

  // 惰性取图的触发点：卡片看得见才取，所以启动时一张都不取。
  useEffect(() => {
    void ensureAssetImage(imageId)
  }, [imageId])

  if (!preview?.url) return <div className="h-full w-full bg-muted" />
  return (
    <img
      src={preview.url}
      data-image-id={imageId}
      alt={alt}
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
    />
  )
}
