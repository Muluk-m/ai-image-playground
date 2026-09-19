import { useEffect, useState } from 'react'
import { type ImagePreview, isMediaRef, loadImagePreview } from '../lib/imageSource'
import { subscribeImageThumbnail } from '../store'

/**
 * 读一张图的预览源，不区分本机图与平台图。本机图的缩略图缓存里没有时由 store
 * 后台生成，好了再经订阅推回来；平台图没有这一步，拿到临时 URL 就结束。
 */
export function useImagePreview(ref: string | undefined): ImagePreview | null {
  const [preview, setPreview] = useState<ImagePreview | null>(null)

  useEffect(() => {
    setPreview(null)
    if (!ref) return

    let cancelled = false
    const apply = (next: ImagePreview) => {
      if (!cancelled) setPreview(next)
    }
    const unsubscribe = isMediaRef(ref)
      ? undefined
      : subscribeImageThumbnail(ref, (thumbnail) =>
          apply({ url: thumbnail.dataUrl, width: thumbnail.width, height: thumbnail.height }),
        )
    // loadImagePreview 自己吞掉失败：读不到就保持 null，让调用方渲染占位图，
    // 绝不能把空 src 交给 <img>。
    void loadImagePreview(ref).then((next) => {
      if (next) apply(next)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [ref])

  return preview
}
