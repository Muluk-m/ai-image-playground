/** 头像裁切。预览圆和导出的 512 图共用这一套缩放、旋转、位移。 */

export const AVATAR_OUTPUT_SIZE = 512
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export interface CropImageSize {
  width: number
  height: number
}

export interface CropOffset {
  x: number
  y: number
}

export type AvatarFileIssue = 'type' | 'size'

export function avatarFileIssue(file: { type: string; size: number }): AvatarFileIssue | null {
  if (!AVATAR_TYPES.includes(file.type as (typeof AVATAR_TYPES)[number])) return 'type'
  if (file.size > AVATAR_MAX_BYTES) return 'size'
  return null
}

export function normalizedRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360
}

export function rotatedSize(size: CropImageSize, rotation: number): CropImageSize {
  const quarter = normalizedRotation(rotation)
  if (quarter === 90 || quarter === 270) return { width: size.height, height: size.width }
  return size
}

/** 让旋转后的图至少盖住圆的缩放。1 倍是刚好盖住。 */
export function coverScale(size: CropImageSize, viewport: number, rotation: number): number {
  const box = rotatedSize(size, rotation)
  if (box.width <= 0 || box.height <= 0 || viewport <= 0) return 1
  return Math.max(viewport / box.width, viewport / box.height)
}

export function clampCropOffset(
  offset: CropOffset,
  size: CropImageSize,
  viewport: number,
  zoom: number,
  rotation: number,
): CropOffset {
  const scale = coverScale(size, viewport, rotation) * zoom
  const box = rotatedSize(size, rotation)
  const maxX = Math.max(0, (box.width * scale - viewport) / 2)
  const maxY = Math.max(0, (box.height * scale - viewport) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  }
}

export function drawCroppedAvatar(
  image: CanvasImageSource,
  size: CropImageSize,
  offset: CropOffset,
  viewport: number,
  zoom: number,
  rotation: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_OUTPUT_SIZE
  canvas.height = AVATAR_OUTPUT_SIZE
  const context = canvas.getContext('2d')
  if (!context) return canvas
  const ratio = AVATAR_OUTPUT_SIZE / viewport
  const scale = coverScale(size, viewport, rotation) * zoom * ratio
  context.clearRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE)
  context.save()
  context.translate(
    AVATAR_OUTPUT_SIZE / 2 + offset.x * ratio,
    AVATAR_OUTPUT_SIZE / 2 + offset.y * ratio,
  )
  context.rotate((normalizedRotation(rotation) * Math.PI) / 180)
  context.drawImage(
    image,
    (-size.width * scale) / 2,
    (-size.height * scale) / 2,
    size.width * scale,
    size.height * scale,
  )
  context.restore()
  return canvas
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('avatar_export_failed'))
    }, 'image/png')
  })
}
