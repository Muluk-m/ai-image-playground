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
  '[背景指令]',
  '背景色选择规则：如果主体包含绿色系颜色，使用纯洋红色(#FF00FF)背景；否则一律使用纯绿色(#00FF00)背景。',
  '背景要求：整张画布仅由所选纯色填充，无渐变、纹理、阴影、地面或环境元素。',
  '主体要求：单主体、完整呈现、轮廓清晰，主体与背景之间保持干净边缘。',
  '禁止：主体本身、描边、光晕、投影或反射中不能出现所选背景色。',
].join('\n')

export function buildTransparentPrompt(prompt: string) {
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

export async function removeKeyedBackgroundFromDataUrl(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 Canvas，无法执行透明背景后处理')

  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const keyColor = detectKeyColorFromPixels(pixels.data, canvas.width, canvas.height)
  removeKeyedBackgroundFromPixels(pixels.data, canvas.width, canvas.height, keyColor)
  ctx.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

export function detectKeyColorFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  const green = KEY_COLORS[GREEN_KEY_COLOR]
  const magenta = KEY_COLORS[MAGENTA_KEY_COLOR]
  let greenScore = 0
  let magentaScore = 0

  forEachBorderIndex(width, height, (index) => {
    const offset = index * 4
    const color = { r: data[offset], g: data[offset + 1], b: data[offset + 2] }
    if (colorDistance(color, green) < 100) greenScore += 1
    if (colorDistance(color, magenta) < 100) magentaScore += 1
  })

  return magentaScore > greenScore ? MAGENTA_KEY_COLOR : GREEN_KEY_COLOR
}

export function removeKeyedBackgroundFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyColor: string,
) {
  if (data.length < width * height * 4) throw new Error('透明背景像素数据尺寸不匹配')
  const keyRgb = KEY_COLORS[keyColor.toUpperCase()]
  if (!keyRgb) throw new Error('透明背景键色不支持')

  const mask = buildConnectedBackgroundMask(data, width, height, keyRgb)
  const distance = computeDistanceToBackground(mask, width, height, 4)

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    const red = data[offset]
    const green = data[offset + 1]
    const blue = data[offset + 2]
    const confidence = getBackgroundConfidence(red, green, blue, keyRgb)

    if (mask[index]) {
      data[offset + 3] = 0
      continue
    }

    const edgeDistance = distance[index]
    if (edgeDistance > 0) {
      const spill = getKeyChannelMix(red, green, blue, keyRgb)
      const transparency = clamp01(Math.max(confidence - 0.12, spill) * (1 / edgeDistance))
      if (transparency > 0) {
        const alpha = Math.max(edgeDistance === 1 ? 48 : 128, Math.round(255 * (1 - transparency)))
        data[offset + 3] = alpha
        const cleaned = removeColorSpill(red, green, blue, keyRgb, transparency)
        data[offset] = cleaned.r
        data[offset + 1] = cleaned.g
        data[offset + 2] = cleaned.b
      }
    }
  }

  return data
}

function buildConnectedBackgroundMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyRgb: Rgb,
) {
  const pixelCount = width * height
  const mask = new Uint8Array(pixelCount)
  const visited = new Uint8Array(pixelCount)
  const queue = new Uint32Array(pixelCount)
  let queueStart = 0
  let queueEnd = 0

  const enqueue = (index: number) => {
    if (visited[index]) return
    visited[index] = 1
    const offset = index * 4
    if (getBackgroundConfidence(data[offset], data[offset + 1], data[offset + 2], keyRgb) < 0.18)
      return
    mask[index] = 1
    queue[queueEnd] = index
    queueEnd += 1
  }

  forEachBorderIndex(width, height, enqueue)

  while (queueStart < queueEnd) {
    const index = queue[queueStart]
    queueStart += 1
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) enqueue(index - 1)
    if (x < width - 1) enqueue(index + 1)
    if (y > 0) enqueue(index - width)
    if (y < height - 1) enqueue(index + width)
  }

  return mask
}

function computeDistanceToBackground(
  mask: Uint8Array,
  width: number,
  height: number,
  maxDistance: number,
) {
  const pixelCount = width * height
  const distance = new Uint8Array(pixelCount)
  let frontier: number[] = []

  for (let index = 0; index < pixelCount; index += 1) {
    if (mask[index]) continue
    const x = index % width
    const y = Math.floor(index / width)
    const touchesBackground =
      (x > 0 && mask[index - 1]) ||
      (x < width - 1 && mask[index + 1]) ||
      (y > 0 && mask[index - width]) ||
      (y < height - 1 && mask[index + width])
    if (touchesBackground) {
      distance[index] = 1
      frontier.push(index)
    }
  }

  for (let currentDistance = 1; currentDistance < maxDistance; currentDistance += 1) {
    const nextFrontier: number[] = []
    for (const index of frontier) {
      const x = index % width
      const y = Math.floor(index / width)
      addDistanceNeighbor(distance, mask, nextFrontier, x > 0 ? index - 1 : -1, currentDistance)
      addDistanceNeighbor(
        distance,
        mask,
        nextFrontier,
        x < width - 1 ? index + 1 : -1,
        currentDistance,
      )
      addDistanceNeighbor(distance, mask, nextFrontier, y > 0 ? index - width : -1, currentDistance)
      addDistanceNeighbor(
        distance,
        mask,
        nextFrontier,
        y < height - 1 ? index + width : -1,
        currentDistance,
      )
    }
    frontier = nextFrontier
    if (!frontier.length) break
  }

  return distance
}

function addDistanceNeighbor(
  distance: Uint8Array,
  mask: Uint8Array,
  nextFrontier: number[],
  neighborIndex: number,
  currentDistance: number,
) {
  if (neighborIndex < 0 || mask[neighborIndex] || distance[neighborIndex] !== 0) return
  distance[neighborIndex] = currentDistance + 1
  nextFrontier.push(neighborIndex)
}

function forEachBorderIndex(width: number, height: number, callback: (index: number) => void) {
  for (let x = 0; x < width; x += 1) {
    callback(x)
    callback((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    callback(y * width)
    callback(y * width + width - 1)
  }
}

function colorDistance(a: Rgb, b: Rgb) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

function getBackgroundConfidence(red: number, green: number, blue: number, keyRgb: Rgb) {
  return clamp01((150 - colorDistance({ r: red, g: green, b: blue }, keyRgb)) / 150)
}

function getKeyChannelMix(red: number, green: number, blue: number, keyRgb: Rgb) {
  if (keyRgb.g === 255) return clamp01((green - Math.min(red, blue)) / 255)
  return clamp01((Math.min(red, blue) - green * 0.65) / 255)
}

function removeColorSpill(red: number, green: number, blue: number, keyRgb: Rgb, mix: number): Rgb {
  const backgroundMix = clamp01(mix * 0.7)
  const foregroundMix = Math.max(0.08, 1 - backgroundMix)
  return {
    r: clampByte((red - keyRgb.r * backgroundMix) / foregroundMix),
    g: clampByte((green - keyRgb.g * backgroundMix) / foregroundMix),
    b: clampByte((blue - keyRgb.b * backgroundMix) / foregroundMix),
  }
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}
