import { useEffect, useState } from 'react'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../../../store'

export default function AssetThumb({ imageId, alt }: { imageId: string; alt: string }) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    let cancelled = false
    setSrc('')
    const apply = (thumbnail: { dataUrl: string }) => {
      if (!cancelled) setSrc(thumbnail.dataUrl)
    }
    const unsubscribe = subscribeImageThumbnail(imageId, apply)
    ensureImageThumbnailCached(imageId)
      .then((thumbnail) => {
        if (thumbnail) apply(thumbnail)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [imageId])

  if (!src) return <div className="h-full w-full bg-gray-100 dark:bg-white/[0.04]" />
  return (
    <img
      src={src}
      data-image-id={imageId}
      alt={alt}
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
    />
  )
}
