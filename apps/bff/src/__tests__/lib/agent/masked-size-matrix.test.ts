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
  // 候选内容按位置编码（R=横向、G=纵向比例），用来核对拉回原尺寸后选区内没有错位或被裁掉。
  const candidateWidth = Math.max(1, Math.round(sentMeta.width! * scale))
  const candidateHeight = Math.max(1, Math.round(sentMeta.height! * scale))
  const candidateRaw = Buffer.alloc(candidateWidth * candidateHeight * 3)
  for (let y = 0; y < candidateHeight; y++)
    for (let x = 0; x < candidateWidth; x++) {
      const offset = (y * candidateWidth + x) * 3
      candidateRaw[offset] = Math.round((255 * (x + 0.5)) / candidateWidth)
      candidateRaw[offset + 1] = Math.round((255 * (y + 0.5)) / candidateHeight)
    }
  const candidate = await sharp(candidateRaw, {
    raw: { width: candidateWidth, height: candidateHeight, channels: 3 },
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
      // 选区里用上了生成结果，且位置对得上：截图（或整图）里的相对位置 = 候选里的相对位置。
      if (!item.alpha) {
        const area = trip.prepared.crop ?? {
          left: 0,
          top: 0,
          width: item.width,
          height: item.height,
        }
        const inset = 8
        for (const [x, y] of [
          [item.rect.left + inset, item.rect.top + inset],
          [item.rect.right - 1 - inset, item.rect.bottom - 1 - inset],
          [
            Math.floor((item.rect.left + item.rect.right) / 2),
            Math.floor((item.rect.top + item.rect.bottom) / 2),
          ],
        ] as const) {
          const offset = (y * item.width + x) * 4
          const expectedR = (255 * (x - area.left + 0.5)) / area.width
          const expectedG = (255 * (y - area.top + 0.5)) / area.height
          expect(Math.abs(trip.result.data[offset]! - expectedR)).toBeLessThanOrEqual(6)
          expect(Math.abs(trip.result.data[offset + 1]! - expectedG)).toBeLessThanOrEqual(6)
          expect(trip.result.data[offset + 2]).toBe(0)
        }
      }
    }, 60_000)

  for (const [orientation, rawWidth, rawHeight] of [
    [2, 300, 400],
    [3, 300, 400],
    [4, 300, 400],
    [5, 400, 300],
    [6, 400, 300],
    [7, 400, 300],
    [8, 400, 300],
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

  for (const orientation of [5, 6, 7, 8])
    it(`orientation ${orientation}: turns a selection drawn on the raw pixels together with the photo`, async () => {
      const jpeg = await sharp(pattern(400, 300), { raw: { width: 400, height: 300, channels: 4 } })
        .jpeg({ quality: 90 })
        .withMetadata({ orientation })
        .toBuffer()
      // 非对称选区，转错方向一定对不上。
      const rawMask = await selection(400, 300, { left: 10, top: 20, right: 60, bottom: 140 })
      const prepared = await prepareMaskedInput(
        'gpt-image-2.5-flare',
        url(jpeg, 'image/jpeg'),
        url(rawMask),
      )
      expect(prepared.originalSize).toEqual({ width: 300, height: 400 })
      const mask = await sharp(decode(prepared.mask))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      // 期望值：给蒙版打上同一个 EXIF 方向，让 sharp 自动转正。
      const expected = await sharp(
        await sharp(rawMask).tiff({ compression: 'none' }).withMetadata({ orientation }).toBuffer(),
      )
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect([mask.info.width, mask.info.height]).toEqual([
        expected.info.width,
        expected.info.height,
      ])
      const alpha = (data: Buffer) => data.filter((_, index) => index % 4 === 3)
      expect(alpha(mask.data)).toEqual(alpha(expected.data))
    })

  it('crops an extreme panorama around the selection to the aspect limit before scaling', () => {
    const crop = scaledEditCrop(9000, 1000, { left: 7000, top: 100, right: 7400, bottom: 900 })
    expect(crop.width / crop.height).toBeLessThanOrEqual(limits.maxAspectRatio)
    expect(crop.left).toBeLessThanOrEqual(7000)
    expect(crop.left + crop.width).toBeGreaterThanOrEqual(7400)
    expect(acceptable(crop.sendWidth, crop.sendHeight)).toBe(true)
  })
  it('keeps tiny far-apart selections visible to upstream when the crop is scaled down', async () => {
    // 8000×4500 上两个相隔很远的 3×3 小点：截图覆盖大片、缩到 ~1.5MP 后最近邻会把它们整块丢掉。
    const width = 8000
    const height = 4500
    const raw = Buffer.alloc(width * height * 4, 255)
    const dots = [
      { x: 1001, y: 1203 },
      { x: 6997, y: 3301 },
    ]
    for (const dot of dots)
      for (let y = dot.y; y < dot.y + 3; y++)
        for (let x = dot.x; x < dot.x + 3; x++) raw[(y * width + x) * 4 + 3] = 0
    const mask = await sharp(raw, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
    const source = await sharp(pattern(width, height), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
    const prepared = await prepareMaskedInput('gpt-image-2.5-flare', url(source), url(mask))
    const crop = prepared.crop!
    expect(crop.sendWidth).toBeDefined()
    const sent = await cropMaskedUpstream(
      { input_images: [prepared.source], mask: prepared.mask },
      crop,
      prepared.originalSize,
    )
    const sentMask = await sharp(decode(sent.mask)).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    })
    const { width: sw, height: sh } = sentMask.info
    for (const dot of dots) {
      const x = Math.floor(((dot.x + 1 - crop.left) / crop.width) * sw)
      const y = Math.floor(((dot.y + 1 - crop.top) / crop.height) * sh)
      expect(sentMask.data[(y * sw + x) * 4 + 3]).toBe(0)
    }
  })
})

describe('tall strip when upstream ignores the requested aspect ratio', () => {
  it('sends at most 2:1 and maps a stretched 1024×1536 reply back onto the selection', async () => {
    // 线上 500×4000：送 736×2160，上游回 1024×1536，按铺满裁切贴回后选区里内容错位。
    const width = 500,
      height = 4000
    const raw = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        raw[offset] = Math.round((255 * x) / width)
        raw[offset + 1] = Math.round((255 * (y % 500)) / 500)
        raw[offset + 2] = 90
        raw[offset + 3] = 255
      }
    const source = await sharp(raw, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
    const rect = { left: 40, top: 1900, right: 320, bottom: 2380 }
    const prepared = await prepareMaskedInput(
      'gpt-image-2.5-flare',
      url(source),
      url(await selection(width, height, rect)),
    )
    expect(prepared.crop?.sendWidth).toBeDefined()
    const crop = prepared.crop!
    const sent = await cropMaskedUpstream(
      { input_images: [prepared.source], mask: prepared.mask },
      crop,
      prepared.originalSize,
    )
    const sentMeta = await sharp(decode(sent.input_images[0]!)).metadata()
    expect(Math.max(sentMeta.width! / sentMeta.height!, sentMeta.height! / sentMeta.width!)).toBe(
      Math.max(crop.sendWidth! / crop.sendHeight!, crop.sendHeight! / crop.sendWidth!),
    )
    expect(sentMeta.height! / sentMeta.width!).toBeLessThanOrEqual(2)
    // 上游把整张送图拉伸进 1024×1536，并把选区（换算到送图坐标）涂成红绿相间的四条竖带：
    // 按铺满裁切对回去，离选区中心远的分界会横向错开十几像素。
    const stretched = await sharp(decode(sent.input_images[0]!))
      .removeAlpha()
      .resize(1024, 1536, { fit: 'fill' })
      .raw()
      .toBuffer()
    const band = (rect.right - rect.left) / 4
    /** 原图横坐标落在第几条竖带。 */
    const stripe = (x: number) => Math.floor((x - rect.left) / band)
    const sx = 1024 / crop.width,
      sy = 1536 / crop.height
    for (let y = Math.ceil((rect.top - crop.top) * sy); y < (rect.bottom - crop.top) * sy; y++)
      for (
        let x = Math.ceil((rect.left - crop.left) * sx);
        x < (rect.right - crop.left) * sx;
        x++
      ) {
        const offset = (y * 1024 + x) * 3
        const left = stripe(x / sx + crop.left) % 2 === 0
        stretched[offset] = left ? 255 : 0
        stretched[offset + 1] = left ? 0 : 255
        stretched[offset + 2] = 0
      }
    const candidate = await sharp(stretched, { raw: { width: 1024, height: 1536, channels: 3 } })
      .png()
      .toBuffer()
    const protect = await protectMaskedOutput(
      prepared.source,
      prepared.mask,
      prepared.originalSize,
      prepared.crop,
    )
    const output = await protect(candidate)
    expect(output.inspection.fit).toBe(2)
    expect(output.inspection.fitStretched).toBe(1)
    const result = await sharp(output.bytes).raw().toBuffer({ resolveWithObject: true })
    expect(result.info.width).toBe(width)
    expect(result.info.height).toBe(height)
    // 选区外（离选区 40px 以外）逐像素与原图相同。
    let outsideDiff = 0
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (
          x >= rect.left - 40 &&
          x < rect.right + 40 &&
          y >= rect.top - 40 &&
          y < rect.bottom + 40
        )
          continue
        const offset = (y * width + x) * result.info.channels
        const original = (y * width + x) * 4
        if (
          result.data[offset] !== raw[original] ||
          result.data[offset + 1] !== raw[original + 1] ||
          result.data[offset + 2] !== raw[original + 2]
        )
          outsideDiff++
      }
    expect(outsideDiff).toBe(0)
    // 选区内部（离边、离分界 8px 以内的羽化/取整带除外）红绿竖带都在原位：没有错位。
    let wrong = 0,
      total = 0
    for (let y = rect.top + 8; y < rect.bottom - 8; y++)
      for (let x = rect.left + 8; x < rect.right - 8; x++) {
        const into = (x - rect.left) % band
        if (into < 8 || band - into < 8) continue
        const offset = (y * width + x) * result.info.channels
        const red = result.data[offset]!,
          green = result.data[offset + 1]!
        total++
        if (stripe(x) % 2 === 0 ? red < 240 || green > 15 : green < 240 || red > 15) wrong++
      }
    expect(wrong / total).toBeLessThan(0.01)
  })
})
