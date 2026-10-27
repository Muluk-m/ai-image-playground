import { encodeCanvas } from './encode'
import { createOutputCanvas } from './render'
import type { ToolOutput, ToolSource } from './tool'

export interface RotationSettings {
  angle: number
  flipH: boolean
  flipV: boolean
  expand: boolean
}

export const DEFAULT_ROTATION: RotationSettings = {
  angle: 0,
  flipH: false,
  flipV: false,
  expand: true,
}

export function normalizeAngle(angle: number): number {
  return Math.round((((((angle + 180) % 360) + 360) % 360) - 180) * 10) / 10
}

export function rotationSize(width: number, height: number, settings: RotationSettings) {
  if (!settings.expand) return { width, height }
  const radians = (settings.angle * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  // Quarter turns must not gain a pixel from floating-point trigonometry.
  return {
    width: Math.ceil(width * cos + height * sin - 1e-8),
    height: Math.ceil(width * sin + height * cos - 1e-8),
  }
}

export function renderRotation(
  bitmap: ImageBitmap,
  settings: RotationSettings,
  maxEdge = Number.POSITIVE_INFINITY,
): HTMLCanvasElement {
  const size = rotationSize(bitmap.width, bitmap.height, settings)
  const scale = Math.min(1, maxEdge / Math.max(size.width, size.height))
  const { canvas, ctx } = createOutputCanvas(
    Math.max(1, Math.round(size.width * scale)),
    Math.max(1, Math.round(size.height * scale)),
    'image/png',
  )
  ctx.translate(canvas.width / 2, canvas.height / 2)
  // Mirror the visible result, so horizontal stays horizontal after a quarter turn.
  ctx.scale((settings.flipH ? -1 : 1) * scale, (settings.flipV ? -1 : 1) * scale)
  ctx.rotate((settings.angle * Math.PI) / 180)
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)
  return canvas
}

export async function rotateImage(
  source: ToolSource,
  settings: RotationSettings,
): Promise<ToolOutput> {
  const canvas = renderRotation(source.bitmap, settings)
  try {
    const encoded = await encodeCanvas(canvas, 'image/png')
    return { ...encoded, width: canvas.width, height: canvas.height }
  } finally {
    canvas.width = canvas.height = 0
  }
}
