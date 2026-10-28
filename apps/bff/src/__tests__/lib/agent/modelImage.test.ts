import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'

// Configuration is read for resource limits; this pure image test never opens a database.
process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''
const {
  EDIT_INPUT_MAX_EDGE,
  MODEL_IMAGE_MIMES,
  editInputSize,
  toEditInputDataUrl,
  toModelImageDataUrl,
  toNormalizedImageDataUrl,
  toPreviewDataUrl,
  toSourceImageDataUrl,
} = await import('../../../lib/agent/modelImage')

const decode = (url: string) => Buffer.from(url.split(',')[1]!, 'base64')

async function solid(
  width: number,
  height: number,
  options: { format?: 'jpeg' | 'png'; alpha?: boolean; orientation?: number } = {},
): Promise<string> {
  const format = options.format ?? 'jpeg'
  let image = sharp({
    create: {
      width,
      height,
      channels: options.alpha ? 4 : 3,
      background: options.alpha ? { r: 255, g: 0, b: 0, alpha: 0.5 } : '#3366cc',
    },
  }).toFormat(format)
  if (options.orientation) image = image.withMetadata({ orientation: options.orientation })
  const bytes = await image.toBuffer()
  return `data:image/${format};base64,${bytes.toString('base64')}`
}

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

  it('解不开的数据明确拒绝，不回退原件', async () => {
    const junk = `data:image/avif;base64,${Buffer.from('not an image').toString('base64')}`
    expect(toModelImageDataUrl(junk)).rejects.toThrow('重新添加')
    expect(toModelImageDataUrl('https://example.com/a.png')).rejects.toThrow('重新添加')
  })
})

describe('toEditInputDataUrl（BUG-35：超大图等比缩到最长边 4000 再改）', () => {
  it('尺寸计算：长边封顶 4000、像素不超准备预算、极端长宽比短边至少 1px', () => {
    expect(EDIT_INPUT_MAX_EDGE).toBe(4000)
    expect(editInputSize(8000, 8000)).toEqual({ width: 4000, height: 4000 })
    expect(editInputSize(6000, 4000)).toEqual({ width: 4000, height: 2666 })
    expect(editInputSize(4000, 3000)).toEqual({ width: 4000, height: 3000 })
    expect(editInputSize(40000, 50)).toEqual({ width: 4000, height: 5 })
    expect(editInputSize(100000, 2)).toEqual({ width: 4000, height: 1 })
    // 像素预算比 4000² 还紧时按像素收，比例不变。
    const tight = editInputSize(4000, 4000, 1_000_000)
    expect(tight.width * tight.height).toBeLessThanOrEqual(1_000_000)
    expect(tight.width).toBe(tight.height)
  })

  it('8000×8000 与 6000×4000 缩到最长边 4000，等比，转 JPEG', async () => {
    for (const [width, height, outWidth, outHeight] of [
      [8000, 8000, 4000, 4000],
      [6000, 4000, 4000, 2666],
    ] as const) {
      const out = await toEditInputDataUrl(await solid(width, height))
      expect(out).toStartWith('data:image/jpeg;base64,')
      expect(await sharp(decode(out)).metadata()).toMatchObject({
        width: outWidth,
        height: outHeight,
      })
    }
  })

  it('极端长宽比按长边收，不变形', async () => {
    const out = await toEditInputDataUrl(await solid(20000, 500))
    expect(await sharp(decode(out)).metadata()).toMatchObject({ width: 4000, height: 100 })
    const tall = await toEditInputDataUrl(await solid(500, 20000))
    expect(await sharp(decode(tall)).metadata()).toMatchObject({ width: 100, height: 4000 })
  })

  it('EXIF 方向先摆正再缩，宽高按显示方向', async () => {
    // 存储 6000×4000、方向 6（顺时针 90°）= 显示 4000×6000。
    const out = await toEditInputDataUrl(await solid(6000, 4000, { orientation: 6 }))
    const metadata = await sharp(decode(out)).metadata()
    expect(metadata).toMatchObject({ width: 2666, height: 4000 })
    expect(metadata.orientation ?? 1).toBe(1)
  })

  it('带透明的保留透明（PNG）', async () => {
    const out = await toEditInputDataUrl(await solid(5000, 1000, { format: 'png', alpha: true }))
    expect(out).toStartWith('data:image/png;base64,')
    expect(await sharp(decode(out)).metadata()).toMatchObject({
      width: 4000,
      height: 800,
      hasAlpha: true,
    })
  })

  it('不超限的原样送出，不重编码', async () => {
    const small = await solid(4000, 3000)
    expect(await toEditInputDataUrl(small)).toBe(small)
  })

  it('原样进请求的原件（视频参考）仍按准备预算拒绝超大图，不静默缩小', async () => {
    expect(toNormalizedImageDataUrl(await solid(8000, 8000))).rejects.toThrow('像素')
  })
})

/** 超出对话模型准备预算的大图不拦：模型看缩过的那份，服务端处理与改图仍用原件。 */
describe('超大原图（8000×4500，超出 agent:visual-max-pixels）', () => {
  it('送给对话模型的证据等比缩进准备预算，不报错', async () => {
    const fitted = await sharp(
      decode(await toModelImageDataUrl(await solid(8000, 4500))),
    ).metadata()
    expect(Math.max(fitted.width!, fitted.height!)).toBeLessThanOrEqual(EDIT_INPUT_MAX_EDGE)
    expect(fitted.width! * fitted.height!).toBeLessThanOrEqual(16_777_216)
    expect(fitted.width! / fitted.height!).toBeCloseTo(8000 / 4500, 2)
  })

  it('缩略图长边 ≤1024、比例不变', async () => {
    const preview = await sharp(decode(await toPreviewDataUrl(await solid(8000, 4500)))).metadata()
    expect(preview.width).toBe(1024)
    expect(preview.height).toBe(576)
  })

  it('服务端取原件逐字节不动、不按准备预算拒', async () => {
    const original = await solid(8000, 4500)
    expect(await toSourceImageDataUrl(original)).toBe(original)
  })

  it('准备预算以内的图，送给模型的那份与原来一样（不额外缩）', async () => {
    const small = await solid(1200, 800)
    expect(await toModelImageDataUrl(small)).toBe(await toNormalizedImageDataUrl(small))
  })
})
