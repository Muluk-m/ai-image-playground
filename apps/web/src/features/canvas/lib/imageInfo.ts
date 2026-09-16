import type { CanvasDoc, CanvasEl, ImageEl } from './canvasDoc'
import { getLoadedImage } from './imageCache'

export function canvasImageName(image: ImageEl): string {
  return image.name?.trim() || image.meta?.prompt?.trim() || (image.video ? '视频' : '未命名图片')
}

/** 原始像素与画布显示尺寸分开；缩放对象不会改变这里的尺寸。 */
export function canvasImageDimensions(
  image: ImageEl,
  doc: CanvasDoc,
): { width: number; height: number } | null {
  if (image.naturalWidth && image.naturalHeight)
    return { width: image.naturalWidth, height: image.naturalHeight }
  const loaded = getLoadedImage(image.fileId, doc.files[image.fileId], () =>
    doc.notifyAssetLoaded(),
  )
  return loaded ? { width: loaded.naturalWidth, height: loaded.naturalHeight } : null
}

export function canvasElementCreatedAt(element: CanvasEl): number {
  if (element.type === 'image' && element.createdAt) return element.createdAt
  if (element.type === 'placeholder' && element.meta.createdAt) return element.meta.createdAt
  const encoded = /^el_([0-9a-z]+)_/.exec(element.id)?.[1]
  return encoded ? Number.parseInt(encoded, 36) : 0
}
