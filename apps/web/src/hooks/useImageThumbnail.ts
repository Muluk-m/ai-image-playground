import { useEffect, useState } from 'react'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../store'

export interface ImageThumbnail {
  dataUrl: string
  width?: number
  height?: number
}

/** 读一张已存图片的缩略图；缓存里没有时由 store 后台生成，好了再经订阅推回来。 */
export function useImageThumbnail(imageId: string | undefined): ImageThumbnail | null {
  const [thumbnail, setThumbnail] = useState<ImageThumbnail | null>(null)

  useEffect(() => {
    setThumbnail(null)
    if (!imageId) return

    let cancelled = false
    const apply = (next: ImageThumbnail) => {
      if (!cancelled) setThumbnail(next)
    }
    const unsubscribe = subscribeImageThumbnail(imageId, apply)
    ensureImageThumbnailCached(imageId)
      .then((next) => {
        if (next) apply(next)
      })
      .catch(() => apply({ dataUrl: '' }))

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [imageId])

  return thumbnail
}
