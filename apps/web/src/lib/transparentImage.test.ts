import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import {
  buildTransparentPrompt,
  detectKeyColorFromPixels,
  GREEN_KEY_COLOR,
  getTransparentRequestParams,
  MAGENTA_KEY_COLOR,
  removeKeyedBackgroundFromPixels,
} from './transparentImage'

describe('transparent image prompt and params', () => {
  it('adds chroma-key background instructions to the original prompt', () => {
    const prompt = buildTransparentPrompt('cute sticker')

    expect(prompt).toContain('cute sticker')
    expect(prompt).toContain('#00FF00')
    expect(prompt).toContain('#FF00FF')
  })

  it('forces PNG output without mutating the original params', () => {
    const params = { ...DEFAULT_PARAMS, output_format: 'jpeg' as const, output_compression: 80 }
    const next = getTransparentRequestParams(params)

    expect(next).toMatchObject({
      output_format: 'png',
      output_compression: null,
      transparent_output: true,
    })
    expect(params.output_format).toBe('jpeg')
  })
})

describe('transparent image chroma-key removal', () => {
  it('detects the dominant border key color', () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 20, 20, 20, 255,
    ])

    expect(detectKeyColorFromPixels(pixels, 2, 2)).toBe(MAGENTA_KEY_COLOR)
  })

  it('removes connected key-color background while keeping isolated subject pixels', () => {
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 220, 20, 20,
      255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
    ])

    removeKeyedBackgroundFromPixels(pixels, 3, 3, GREEN_KEY_COLOR)

    expect(pixels[3]).toBe(0)
    expect(pixels[5 * 4 + 3]).toBe(255)
  })
})
