import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { MODEL_IMAGE_MIMES, toModelImageDataUrl } from '../../../lib/agent/modelImage'

async function pixel(format: 'png' | 'jpeg' | 'webp' | 'tiff' | 'gif'): Promise<string> {
  const image = sharp({ create: { width: 2, height: 2, channels: 4, background: '#f00' } })
  const bytes = await image.toFormat(format).toBuffer()
  return `data:image/${format};base64,${bytes.toString('base64')}`
}

describe('toModelImageDataUrl', () => {
  it('上游认的位图原样返回', async () => {
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const url = await pixel(format)
      expect(await toModelImageDataUrl(url)).toBe(url)
    }
    expect([...MODEL_IMAGE_MIMES].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
  })

  it('上游不认的格式（TIFF、SVG）转成 PNG，尺寸不变', async () => {
    const tiff = await pixel('tiff')
    const svg = `data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>',
    ).toString('base64')}`
    for (const [url, width, height] of [
      [tiff, 2, 2],
      [svg, 24, 16],
    ] as const) {
      const converted = await toModelImageDataUrl(url)
      expect(converted).toStartWith('data:image/png;base64,')
      expect(await sharp(Buffer.from(converted.split(',')[1]!, 'base64')).metadata()).toMatchObject(
        { format: 'png', width, height },
      )
    }
  })

  it('解不开的数据保留原样，让上游报它自己的错', async () => {
    const junk = `data:image/avif;base64,${Buffer.from('not an image').toString('base64')}`
    expect(await toModelImageDataUrl(junk)).toBe(junk)
    expect(await toModelImageDataUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })
})
