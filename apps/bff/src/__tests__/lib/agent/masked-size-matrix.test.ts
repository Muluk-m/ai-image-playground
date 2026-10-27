import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { maskedEditSettings } from '../../../lib/agent/masked-edit-settings'
import {
  cropMaskedUpstream,
  maskedEditSize,
  prepareMaskedInput,
  scaledEditCrop,
  UPSTREAM_OUTPUT_PIXELS,
} from '../../../lib/agent/masked-input'
import { protectMaskedOutput } from '../../../lib/agent/masked-output'

/**
 * 局部编辑不设尺寸门槛（线上 4032×3024、300×400 原图曾整轮报「原图尺寸超出模型支持的局部编辑
 * 范围」）：任何尺寸都要能送上游、拉回原尺寸，且选区外与原图逐像素相同。图都是合成的。
 */
const url = (bytes: Buffer, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`
const decode = (data: string) => Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
const limits = maskedEditSettings.output

function pattern(width: number, height: number, alpha = false) {
  const raw = Buffer.alloc(width * height * 4)
  for (let index = 0, pixel = 0; index < raw.length; index += 4, pixel++) {
    raw[index] = (pixel * 7) & 255
    raw[index + 1] = (pixel * 13) & 255
    raw[index + 2] = (pixel * 29) & 255
    raw[index + 3] = alpha ? (pixel % 3 === 0 ? 0 : pixel % 3 === 1 ? 128 : 255) : 255
  }
  return raw
}

type Rect = { left: number; top: number; right: number; bottom: number }

async function selection(width: number, height: number, rect: Rect) {
  const raw = Buffer.alloc(width * height * 4, 255)
  for (let y = rect.top; y < rect.bottom; y++)
    for (let x = rect.left; x < rect.right; x++) raw[(y * width + x) * 4 + 3] = 0
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
}

function acceptable(width: number, height: number) {
  return (
    width % limits.dimensionMultiple === 0 &&
    height % limits.dimensionMultiple === 0 &&
    Math.max(width, height) <= limits.maxEdge &&
    Math.max(width / height, height / width) <= limits.maxAspectRatio + 1e-9 &&
    width * height >= limits.minPixels &&
    width * height <= limits.maxPixels
  )
}

/** 走一遍提交 → 送上游 → 上游按自己的像素档位回一张纯色图 → 合成，返回检查结果。 */
async function roundTrip(sourceUrl: string, maskUrl: string) {
  const prepared = await prepareMaskedInput('gpt-image-2.5-flare', sourceUrl, maskUrl)
  const sent = prepared.crop
    ? await cropMaskedUpstream(
        { input_images: [prepared.source], mask: prepared.mask },
        prepared.crop,
        prepared.originalSize,
      )
    : { input_images: [prepared.source], mask: prepared.mask }
  const sentMeta = await sharp(decode(sent.input_images[0]!)).metadata()
  const sentMask = await sharp(decode(sent.mask)).metadata()
  const [requestedWidth, requestedHeight] = prepared.size.split('x').map(Number)
  // 上游不管请求尺寸，按输入长宽比出约 1.57MP。
  const scale = Math.sqrt(UPSTREAM_OUTPUT_PIXELS / (sentMeta.width! * sentMeta.height!))
  const candidate = await sharp({
    create: {
      width: Math.max(1, Math.round(sentMeta.width! * scale)),
      height: Math.max(1, Math.round(sentMeta.height! * scale)),
      channels: 3,
      background: '#00ff00',
    },
  })
    .png()
    .toBuffer()
  const protect = await protectMaskedOutput(
    prepared.source,
    prepared.mask,
    prepared.originalSize,
    prepared.crop,
  )
  const output = await protect(candidate)
  const result = await sharp(output.bytes).raw().toBuffer({ resolveWithObject: true })
  const original = await sharp(decode(prepared.source))
    .ensureAlpha()
    .extract({ left: 0, top: 0, ...prepared.originalSize })
    .raw()
    .toBuffer()
  return {
    prepared,
    sent: { width: sentMeta.width!, height: sentMeta.height! },
    sentMask: { width: sentMask.width!, height: sentMask.height! },
    requested: { width: requestedWidth!, height: requestedHeight! },
    output,
    result,
    original,
  }
}

function outsideChanged(
  result: { data: Buffer; info: { width: number; height: number } },
  original: Buffer,
  inside: (x: number, y: number) => boolean,
) {
  let changed = 0
  for (let y = 0; y < result.info.height; y++)
    for (let x = 0; x < result.info.width; x++) {
      if (inside(x, y)) continue
      const offset = (y * result.info.width + x) * 4
      if (result.data.compare(original, offset, offset + 4, offset, offset + 4) !== 0) changed++
    }
  return changed
}

const inRect = (rect: Rect) => (x: number, y: number) =>
  x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom

const cases: { name: string; width: number; height: number; rect: Rect; alpha?: boolean }[] = [
  // 线上报错的两种原图（#1549）。
  {
    name: '4032×3024 phone photo, one object',
    width: 4032,
    height: 3024,
    rect: { left: 1500, top: 1000, right: 2600, bottom: 2400 },
  },
  {
    name: '4032×3024 phone photo, background swap (most of the frame)',
    width: 4032,
    height: 3024,
    rect: { left: 0, top: 0, right: 4032, bottom: 2200 },
  },
  {
    name: '300×400 small upload',
    width: 300,
    height: 400,
    rect: { left: 80, top: 100, right: 220, bottom: 300 },
  },
  {
    name: '8000×4500 very large',
    width: 8000,
    height: 4500,
    rect: { left: 1000, top: 500, right: 7000, bottom: 4000 },
  },
  { name: '64×64 tiny', width: 64, height: 64, rect: { left: 16, top: 16, right: 48, bottom: 48 } },
  {
    name: '6000×1000 panorama, small object',
    width: 6000,
    height: 1000,
    rect: { left: 4200, top: 300, right: 4800, bottom: 900 },
  },
  {
    name: '6000×1000 panorama, selection spans the width',
    width: 6000,
    height: 1000,
    rect: { left: 100, top: 400, right: 5900, bottom: 700 },
  },
  {
    name: '500×4000 tall strip',
    width: 500,
    height: 4000,
    rect: { left: 100, top: 3000, right: 400, bottom: 3400 },
  },
  {
    name: '1200×300 PNG with alpha',
    width: 1200,
    height: 300,
    rect: { left: 500, top: 50, right: 700, bottom: 250 },
    alpha: true,
  },
]

describe('masked edits have no size gates', () => {
  it('reports every gpt-image-2 size as editable', () => {
    for (const { width, height } of cases)
      expect('problem' in maskedEditSize('gpt-image-2.5-flare', width, height)).toBe(false)
  })

  for (const item of cases)
    it(`${item.name}: sends an accepted size, returns the original size, outside unchanged`, async () => {
      const source = await sharp(pattern(item.width, item.height, item.alpha), {
        raw: { width: item.width, height: item.height, channels: 4 },
      })
        .png()
        .toBuffer()
      const trip = await roundTrip(
        url(source),
        url(await selection(item.width, item.height, item.rect)),
      )
      expect(acceptable(trip.requested.width, trip.requested.height)).toBe(true)
      expect(acceptable(trip.sent.width, trip.sent.height)).toBe(true)
      expect(trip.sentMask).toEqual(trip.sent)
      expect([trip.result.info.width, trip.result.info.height]).toEqual([item.width, item.height])
      expect(trip.output.inspection.outsideChangedPixels).toBeGreaterThanOrEqual(0)
      expect(outsideChanged(trip.result, trip.original, inRect(item.rect))).toBe(0)
      // 选区里确实用上了生成结果（纯绿）。
      const cx = Math.floor((item.rect.left + item.rect.right) / 2)
      const cy = Math.floor((item.rect.top + item.rect.bottom) / 2)
      const offset = (cy * item.width + cx) * 4
      if (!item.alpha)
        expect([...trip.result.data.subarray(offset, offset + 3)]).toEqual([0, 255, 0])
    }, 60_000)

  for (const [orientation, rawWidth, rawHeight] of [
    [6, 400, 300],
    [8, 400, 300],
    [3, 300, 400],
  ] as const)
    it(`EXIF orientation ${orientation} JPEG is edited upright with the outside unchanged`, async () => {
      const jpeg = await sharp(pattern(rawWidth, rawHeight), {
        raw: { width: rawWidth, height: rawHeight, channels: 4 },
      })
        .jpeg({ quality: 90 })
        .withMetadata({ orientation })
        .toBuffer()
      // metadata() 读的是原始像素尺寸；5–8 要交换宽高。
      const [width, height] = orientation >= 5 ? [rawHeight, rawWidth] : [rawWidth, rawHeight]
      const rect = { left: 50, top: 60, right: 150, bottom: 200 }
      const trip = await roundTrip(
        url(jpeg, 'image/jpeg'),
        url(await selection(width, height, rect)),
      )
      expect([trip.result.info.width, trip.result.info.height]).toEqual([width, height])
      expect(trip.prepared.originalSize).toEqual({ width, height })
      expect(outsideChanged(trip.result, trip.original, inRect(rect))).toBe(0)
      // 转正后的原图与浏览器显示的一致。
      expect(trip.original).toEqual(await sharp(jpeg).rotate().ensureAlpha().raw().toBuffer())
    }, 60_000)

  it('turns a selection drawn on the raw (not upright) pixels together with the photo', async () => {
    const jpeg = await sharp(pattern(400, 300), { raw: { width: 400, height: 300, channels: 4 } })
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const rawRect = { left: 10, top: 20, right: 60, bottom: 80 }
    const prepared = await prepareMaskedInput(
      'gpt-image-2.5-flare',
      url(jpeg, 'image/jpeg'),
      url(await selection(400, 300, rawRect)),
    )
    expect(prepared.originalSize).toEqual({ width: 300, height: 400 })
    const mask = await sharp(decode(prepared.mask))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([mask.info.width, mask.info.height]).toEqual([300, 400])
    // 方向 6 顺时针转 90°：原始 (x, y) 落到 (H-1-y, x)。
    const at = (x: number, y: number) => mask.data[(y * 300 + x) * 4 + 3]
    expect(at(300 - 1 - 50, 30)).toBe(0)
    expect(at(300 - 1 - 150, 30)).toBe(255)
  })

  it('crops an extreme panorama around the selection to the aspect limit before scaling', () => {
    const crop = scaledEditCrop(9000, 1000, { left: 7000, top: 100, right: 7400, bottom: 900 })
    expect(crop.width / crop.height).toBeLessThanOrEqual(limits.maxAspectRatio)
    expect(crop.left).toBeLessThanOrEqual(7000)
    expect(crop.left + crop.width).toBeGreaterThanOrEqual(7400)
    expect(acceptable(crop.sendWidth, crop.sendHeight)).toBe(true)
  })
})
