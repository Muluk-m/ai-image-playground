import { describe, expect, it } from 'vitest'
import {
  buildTransparentPrompt,
  detectKeyColorFromPixels,
  GREEN_KEY_COLOR,
  getTransparentRequestParams,
  MAGENTA_KEY_COLOR,
  removeKeyedBackgroundFromPixels,
} from '../../lib/transparentImage'
import { DEFAULT_PARAMS } from '../../types'

describe('transparent image prompt and params', () => {
  it('builds a transparent workflow prompt with both key colors', () => {
    const prompt = buildTransparentPrompt('单主体贴纸素材')

    expect(prompt).toContain('单主体贴纸素材')
    expect(prompt).toContain('#00FF00')
    expect(prompt).toContain('#FF00FF')
    expect(prompt).toContain('纯色')
  })

  it('forces transparent requests to PNG without mutating original params', () => {
    const params = {
      ...DEFAULT_PARAMS,
      output_format: 'jpeg' as const,
      output_compression: 80,
      transparent_output: true,
    }

    expect(getTransparentRequestParams(params)).toMatchObject({
      output_format: 'png',
      output_compression: null,
      transparent_output: true,
    })
    expect(params.output_format).toBe('jpeg')
    expect(params.output_compression).toBe(80)
  })
})

describe('key color detection and removal', () => {
  it('detects green key color from border pixels', () => {
    const pixels = createImagePixels(5, 5, [0, 255, 0, 255])
    setPixel(pixels, 2, 2, 5, [180, 20, 20, 255])

    expect(detectKeyColorFromPixels(pixels, 5, 5)).toBe(GREEN_KEY_COLOR)
  })

  it('detects magenta key color from border pixels', () => {
    const pixels = createImagePixels(5, 5, [255, 0, 255, 255])
    setPixel(pixels, 2, 2, 5, [20, 190, 60, 255])

    expect(detectKeyColorFromPixels(pixels, 5, 5)).toBe(MAGENTA_KEY_COLOR)
  })

  it('removes connected green background while keeping foreground', () => {
    const pixels = createImagePixels(3, 3, [0, 255, 0, 255])
    setPixel(pixels, 1, 1, 3, [180, 20, 20, 255])

    removeKeyedBackgroundFromPixels(pixels, 3, 3, GREEN_KEY_COLOR)

    expect(getPixel(pixels, 0, 0, 3)[3]).toBe(0)
    expect(getPixel(pixels, 1, 1, 3)[3]).toBe(255)
  })
})

function createImagePixels(width: number, height: number, rgba: [number, number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(rgba, index * 4)
  }
  return pixels
}

function setPixel(
  pixels: Uint8ClampedArray,
  x: number,
  y: number,
  width: number,
  rgba: [number, number, number, number],
) {
  pixels.set(rgba, (y * width + x) * 4)
}

function getPixel(pixels: Uint8ClampedArray, x: number, y: number, width: number) {
  return Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4))
}
