import { useEffect } from 'react'
import { useImageThumbnail } from '../../../hooks/useImageThumbnail'
import { ensureAssetImage } from '../../../lib/sync/assetImages'

export default function AssetThumb({ imageId, alt }: { imageId: string; alt: string }) {
  const thumbnail = useImageThumbnail(imageId)

  // 惰性取图的触发点：卡片看得见才取，所以启动时一张都不取。
  useEffect(() => {
    void ensureAssetImage(imageId)
  }, [imageId])

  if (!thumbnail?.dataUrl) return <div className="h-full w-full bg-gray-100 dark:bg-white/[0.04]" />
  return (
    <img
      src={thumbnail.dataUrl}
      data-image-id={imageId}
      alt={alt}
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
    />
  )
}
