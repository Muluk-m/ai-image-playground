import { i18next } from '../../../i18n'
import { assertUsableMaskCoverage, classifyMaskAlpha } from '../../../lib/mask'
import { calculateMaskWorkingSize } from '../../../lib/maskPreprocess'

export type ArtifactEditAction = 'inpaint' | 'erase' | 'crop' | 'outpaint'

export interface CropRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ArtifactEditInput {
  readonly dataUrl: string
  readonly maskDataUrl?: string
}

/** The mask contract is opaque = keep, transparent = regenerate. */
export function exportMarkedImage(
  source: string,
  mask: HTMLCanvasElement,
  image: HTMLImageElement,
): ArtifactEditInput {
  if (
    !image.naturalWidth ||
    image.naturalWidth !== mask.width ||
    image.naturalHeight !== mask.height
  )
    throw new Error(i18next.t('mask.sizeMismatch', { ns: 'composer' }))
  const context = mask.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Mask canvas is unavailable')
  assertUsableMaskCoverage(classifyMaskAlpha(context.getImageData(0, 0, mask.width, mask.height)))
  return { dataUrl: source, maskDataUrl: mask.toDataURL('image/png') }
}

export function cropImage(image: HTMLImageElement, rect: CropRect): ArtifactEditInput {
  const canvas = document.createElement('canvas')
  const sx = Math.round(rect.x * image.naturalWidth)
  const sy = Math.round(rect.y * image.naturalHeight)
  const width = Math.max(1, Math.round(rect.width * image.naturalWidth))
  const height = Math.max(1, Math.round(rect.height * image.naturalHeight))
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image canvas is unavailable')
  context.drawImage(image, sx, sy, width, height, 0, 0, width, height)
  return { dataUrl: canvas.toDataURL('image/png') }
}

export function extendImage(image: HTMLImageElement, amount: number): ArtifactEditInput {
  const paddingX = Math.round((image.naturalWidth * amount) / 16) * 16
  const paddingY = Math.round((image.naturalHeight * amount) / 16) * 16
  const width = image.naturalWidth + paddingX * 2
  const height = image.naturalHeight + paddingY * 2
  const target = document.createElement('canvas')
  const mask = document.createElement('canvas')
  const working = calculateMaskWorkingSize(width, height)
  target.width = mask.width = working.width
  target.height = mask.height = working.height
  const targetContext = target.getContext('2d')
  const maskContext = mask.getContext('2d')
  if (!targetContext || !maskContext) throw new Error('Image canvas is unavailable')
  const x = Math.round(paddingX * working.scale)
  const y = Math.round(paddingY * working.scale)
  const imageWidth = Math.round(image.naturalWidth * working.scale)
  const imageHeight = Math.round(image.naturalHeight * working.scale)
  targetContext.drawImage(image, x, y, imageWidth, imageHeight)
  maskContext.fillStyle = '#fff'
  maskContext.fillRect(x, y, imageWidth, imageHeight)
  return {
    dataUrl: target.toDataURL('image/png'),
    maskDataUrl: mask.toDataURL('image/png'),
  }
}
