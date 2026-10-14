import { useEffect } from 'react'
import { Icon } from '../../../components/ui/icon'
import { useImagePreview } from '../../../hooks/useImagePreview'
import { ensureAssetImage } from '../../../lib/sync/assetImages'

export default function AssetThumb({
  imageId,
  alt,
  className = 'h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]',
}: {
  imageId: string
  alt: string
  className?: string
}) {
  const preview = useImagePreview(imageId)

  // 惰性取图的触发点：卡片看得见才取，所以启动时一张都不取。
  useEffect(() => {
    void ensureAssetImage(imageId)
  }, [imageId])

  if (!preview?.url)
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
        <Icon name="layers" size="lg" />
      </div>
    )
  return <img src={preview.url} data-image-id={imageId} alt={alt} className={className} />
}
