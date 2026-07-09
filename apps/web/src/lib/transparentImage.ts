import type { TaskParams } from '../types'
import { loadImage } from './canvasImage'

export const GREEN_KEY_COLOR = '#00FF00'
export const MAGENTA_KEY_COLOR = '#FF00FF'

export interface TransparentOutputMeta {
  transparentOutput: true
  effectivePrompt: string
}

interface Rgb {
  r: number
  g: number
  b: number
}

const KEY_COLORS: Record<string, Rgb> = {
  [GREEN_KEY_COLOR]: { r: 0, g: 255, b: 0 },
  [MAGENTA_KEY_COLOR]: { r: 255, g: 0, b: 255 },
}

const TRANSPARENT_PROMPT_TEMPLATE = [
  '[Background instruction]',
  'Choose a pure green (#00FF00) background unless the subject itself contains green/cyan/lime colors; in that case use pure magenta (#FF00FF).',
  'The whole canvas background must be one flat key color only, with no gradients, shadows, ground plane, environment, texture, or lighting variation.',
  'Keep a single complete subject with a clean, sharp silhouette and clear color separation from the background.',
  'Do not use the selected key color in the subject, outline, glow, reflection, or shadow.',
].join('\n')

export function buildTransparentPrompt(prompt: string): string {
  return `${prompt.trim()}\n\n${TRANSPARENT_PROMPT_TEMPLATE}`
}

export function getTransparentRequestParams(params: TaskParams): TaskParams {
  return {
    ...params,
    output_format: 'png',
    output_compression: null,
    transparent_output: true,
  }
}

export function createTransparentOutputMeta(prompt: string): TransparentOutputMeta {
  return {
    transparentOutput: true,
    effectivePrompt: buildTransparentPrompt(prompt),
  }
}

export async function removeKeyedBackgroundFromDataUrl(
  dataUrl: string,
  keyColor?: string,
): Promise<string> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 Canvas，无法执行透明背景后处理')

  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const effectiveKeyColor =
    keyColor || detectKeyColorFromPixels(pixels.data, canvas.width, canvas.height)
  removeKeyedBackgroundFromPixels(pixels.data, canvas.width, canvas.height, effectiveKeyColor)
  ctx.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

export function detectKeyColorFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  let greenScore = 0
  let magentaScore = 0
  const green = KEY_COLORS[GREEN_KEY_COLOR]
  const magenta = KEY_COLORS[MAGENTA_KEY_COLOR]

  forEachBorderPixel(width, height, (index) => {
    const offset = index * 4
    if (colorDistance(data[offset], data[offset + 1], data[offset + 2], green) < 100) greenScore++
    if (colorDistance(data[offset], data[offset + 1], data[offset + 2], magenta) < 100) {
      magentaScore++
    }
  })

  return magentaScore > greenScore ? MAGENTA_KEY_COLOR : GREEN_KEY_COLOR
}

export function removeKeyedBackgroundFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyColor: string,
): Uint8ClampedArray {
  if (data.length < width * height * 4) throw new Error('透明背景像素数据尺寸不匹配')
  const keyRgb = getKeyColorRgb(keyColor)
  const mask = buildConnectedBackgroundMask(data, width, height, keyRgb)

  for (let index = 0; index < mask.length; index++) {
    const offset = index * 4
    if (mask[index]) {
      data[offset + 3] = 0
      continue
    }

    const confidence = getBackgroundConfidence(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      keyRgb,
    )
    if (confidence > 0.42 && touchesTransparentNeighbor(mask, width, height, index)) {
      data[offset + 3] = Math.max(64, Math.round(255 * (1 - confidence * 0.65)))
      removeColorSpill(data, offset, keyRgb, confidence)
    }
  }

  return data
}

function buildConnectedBackgroundMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyRgb: Rgb,
): Uint8Array {
  const pixelCount = width * height
  const mask = new Uint8Array(pixelCount)
  const visited = new Uint8Array(pixelCount)
  const queue = new Uint32Array(pixelCount)
  let queueStart = 0
  let queueEnd = 0

  const enqueue = (index: number) => {
    if (index < 0 || index >= pixelCount || visited[index]) return
    visited[index] = 1
    const offset = index * 4
    const confidence = getBackgroundConfidence(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      keyRgb,
    )
    if (confidence < 0.18) return
    mask[index] = 1
    queue[queueEnd++] = index
  }

  forEachBorderPixel(width, height, enqueue)

  while (queueStart < queueEnd) {
    const index = queue[queueStart++]
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) enqueue(index - 1)
    if (x < width - 1) enqueue(index + 1)
    if (y > 0) enqueue(index - width)
    if (y < height - 1) enqueue(index + width)
  }

  return mask
}

function forEachBorderPixel(width: number, height: number, visit: (index: number) => void) {
  for (let x = 0; x < width; x++) {
    visit(x)
    visit((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    visit(y * width)
    visit(y * width + width - 1)
  }
}

function getKeyColorRgb(keyColor: string): Rgb {
  const rgb = KEY_COLORS[keyColor.toUpperCase()]
  if (rgb) return rgb
  throw new Error(`不支持的透明背景 key color：${keyColor}`)
}

function colorDistance(r: number, g: number, b: number, target: Rgb): number {
  return Math.sqrt((r - target.r) ** 2 + (g - target.g) ** 2 + (b - target.b) ** 2)
}

function getBackgroundConfidence(r: number, g: number, b: number, keyRgb: Rgb): number {
  const distance = colorDistance(r, g, b, keyRgb)
  return Math.max(0, 1 - distance / 190)
}

function touchesTransparentNeighbor(
  mask: Uint8Array,
  width: number,
  height: number,
  index: number,
) {
  const x = index % width
  const y = Math.floor(index / width)
  return (
    (x > 0 && mask[index - 1]) ||
    (x < width - 1 && mask[index + 1]) ||
    (y > 0 && mask[index - width]) ||
    (y < height - 1 && mask[index + width])
  )
}

function removeColorSpill(data: Uint8ClampedArray, offset: number, keyRgb: Rgb, strength: number) {
  const factor = Math.min(0.55, strength * 0.45)
  data[offset] = Math.round(data[offset] * (1 - factor) + keyRgb.r * factor * 0.2)
  data[offset + 1] = Math.round(data[offset + 1] * (1 - factor) + keyRgb.g * factor * 0.2)
  data[offset + 2] = Math.round(data[offset + 2] * (1 - factor) + keyRgb.b * factor * 0.2)
}
