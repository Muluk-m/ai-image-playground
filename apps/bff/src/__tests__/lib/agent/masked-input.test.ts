import { describe, expect, it } from 'bun:test'
import sharp, { type OutputInfo } from 'sharp'
import {
  cropMaskedUpstream,
  type MaskedCrop,
  maskedEditCrop,
  paddedEditSize,
  prepareMaskedInput,
  UPSTREAM_OUTPUT_PIXELS,
} from '../../../lib/agent/masked-input'
import { placeCrop, protectMaskedOutput } from '../../../lib/agent/masked-output'

const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`
const decode = (data: string) => Buffer.from(data.split(',')[1]!, 'base64')

it('pads only right and bottom without resampling source pixels or moving the selection', async () => {
  const width = 1001,
    height = 769
  const source = await sharp({ create: { width, height, channels: 4, background: '#6386a3' } })
    .png()
    .toBuffer()
  const rawMask = Buffer.alloc(width * height * 4, 255)
  rawMask[(390 * width + 500) * 4 + 3] = 0
  const mask = await sharp(rawMask, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  const prepared = await prepareMaskedInput('gpt-image-2.5-flare', url(source), url(mask))
  expect(prepared.size).toBe('1008x784')
  expect(prepared.originalSize).toEqual({ width, height })
  const cropped = await sharp(decode(prepared.source))
    .extract({ left: 0, top: 0, width, height })
    .raw()
    .toBuffer()
  expect(cropped).toEqual(await sharp(source).raw().toBuffer())
  const { data, info } = await sharp(decode(prepared.mask))
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect(data[(390 * info.width + 500) * 4 + 3]).toBe(0)
  expect(data[(390 * info.width + 1004) * 4 + 3]).toBe(255)
  expect(data[(775 * info.width + 500) * 4 + 3]).toBe(255)
  const protect = await protectMaskedOutput(prepared.source, prepared.mask, prepared.originalSize)
  const delivered = await protect(decode(prepared.source))
  expect(await sharp(delivered.bytes).raw().toBuffer()).toEqual(
    await sharp(source).raw().toBuffer(),
  )
  expect(delivered.inspection).toMatchObject({ width, height })
})

it('rejects unsupported models and impossible output sizes before generation', async () => {
  const source = await sharp({
    create: { width: 800, height: 800, channels: 4, background: '#fff' },
  })
    .png()
    .toBuffer()
  await expect(prepareMaskedInput('gpt-image-2.5-flare', url(source), url(source))).rejects.toThrow(
    '原图尺寸',
  )
  await expect(prepareMaskedInput('gemini-image', url(source), url(source))).rejects.toThrow(
    '当前模型',
  )
})

describe('crop around the selection', () => {
  const contains = (
    crop: MaskedCrop,
    box: { left: number; top: number; right: number; bottom: number },
  ) =>
    crop.left <= box.left &&
    crop.top <= box.top &&
    crop.left + crop.width >= box.right &&
    crop.top + crop.height >= box.bottom

  it('crops the 4K armchair to about the upstream size so the selection is not upscaled', () => {
    // 测试环境的真实选区：3840×2160 里的扶手椅，贴着下边。
    const box = { left: 1204, top: 1207, right: 2536, bottom: 2160 }
    const crop = maskedEditCrop(3840, 2160, box)!
    expect(crop).not.toBeNull()
    expect(contains(crop, box)).toBe(true)
    expect(crop.left + crop.width).toBeLessThanOrEqual(3840)
    expect(crop.top + crop.height).toBeLessThanOrEqual(2160)
    expect(crop.width * crop.height).toBeLessThanOrEqual(UPSTREAM_OUTPUT_PIXELS)
    // 选区左右各留出至少 32px 上下文。
    expect(box.left - crop.left).toBeGreaterThanOrEqual(32)
    expect(crop.left + crop.width - box.right).toBeGreaterThanOrEqual(32)
  })

  it('grows a small selection to the upstream budget around it, keeping it centred', () => {
    const box = { left: 1900, top: 1000, right: 2000, bottom: 1100 }
    const crop = maskedEditCrop(3840, 2160, box)!
    expect(contains(crop, box)).toBe(true)
    expect(crop.width * crop.height).toBeLessThanOrEqual(UPSTREAM_OUTPUT_PIXELS)
    expect(crop.width * crop.height).toBeGreaterThan(UPSTREAM_OUTPUT_PIXELS * 0.99)
    expect(Math.abs(crop.left + crop.width / 2 - 1950)).toBeLessThanOrEqual(1)
    expect(Math.abs(crop.top + crop.height / 2 - 1050)).toBeLessThanOrEqual(1)
  })

  it('shifts the crop inside the image for a selection in a corner', () => {
    const box = { left: 0, top: 2000, right: 150, bottom: 2160 }
    const crop = maskedEditCrop(3840, 2160, box)!
    expect(crop.left).toBe(0)
    expect(crop.top + crop.height).toBe(2160)
    expect(contains(crop, box)).toBe(true)
  })

  it('keeps a long thin selection within the upstream aspect limit', () => {
    const box = { left: 200, top: 1000, right: 3600, bottom: 1040 }
    // 3400px 宽的细条：截图按 3:1 补高，仍比整图小（放大倍数从 2.3 降到约 1.7）。
    const crop = maskedEditCrop(3840, 2160, box)!
    expect(contains(crop, box)).toBe(true)
    expect(crop.width / crop.height).toBeLessThanOrEqual(3)
    const shorter = maskedEditCrop(3840, 2160, {
      left: 1500,
      top: 1000,
      right: 2400,
      bottom: 1010,
    })!
    expect(shorter.width / shorter.height).toBeLessThanOrEqual(3)
    expect(shorter.height / shorter.width).toBeLessThanOrEqual(3)
  })

  it('does not crop images that already fit the upstream size or selections covering most of it', () => {
    expect(
      maskedEditCrop(1248, 1248, { left: 300, top: 500, right: 1000, bottom: 1000 }),
    ).toBeNull()
    expect(maskedEditCrop(3840, 2160, { left: 0, top: 0, right: 3840, bottom: 2160 })).toBeNull()
    expect(
      maskedEditCrop(3840, 2160, { left: 100, top: 100, right: 3000, bottom: 2000 }),
    ).toBeNull()
  })

  it('places the generated crop back at its original coordinates', () => {
    const source = {
      data: Buffer.alloc(10 * 8 * 4, 7),
      info: { width: 10, height: 8, channels: 4 } as OutputInfo,
    }
    const generated = {
      data: Buffer.alloc(16 * 16 * 4),
      info: { width: 16, height: 16, channels: 4 } as OutputInfo,
    }
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        generated.data.fill(y * 16 + x, (y * 16 + x) * 4, (y * 16 + x) * 4 + 4)
    const placed = placeCrop(source, generated, { left: 3, top: 2, width: 4, height: 3 })
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 10; x++) {
        const inside = x >= 3 && x < 7 && y >= 2 && y < 5
        expect(placed.data[(y * 10 + x) * 4]).toBe(inside ? (y - 2) * 16 + (x - 3) : 7)
      }
  })

  it('sends only the crop upstream and composites it back with the outside untouched', async () => {
    const width = 3200,
      height = 1800
    const raw = Buffer.alloc(width * height * 4)
    for (let index = 0; index < raw.length; index += 4) {
      raw[index] = (index * 7) & 255
      raw[index + 1] = (index * 13) & 255
      raw[index + 2] = (index * 29) & 255
      raw[index + 3] = 255
    }
    const original = await sharp(raw, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
    const rawMask = Buffer.alloc(width * height * 4, 255)
    for (let y = 900; y < 1300; y++)
      for (let x = 2000; x < 2600; x++) rawMask[(y * width + x) * 4 + 3] = 0
    const selection = await sharp(rawMask, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()

    const prepared = await prepareMaskedInput('gpt-image-2.5-flare', url(original), url(selection))
    const crop = prepared.crop!
    expect(crop).toBeDefined()
    // 落库的是整张原图与选区，size 是补边后的截图。
    expect(prepared.source).toBe(url(original))
    expect(prepared.mask).toBe(url(selection))
    const padded = paddedEditSize(crop.width, crop.height)
    expect(prepared.size).toBe(`${padded.width}x${padded.height}`)

    const upstream = await cropMaskedUpstream(
      {
        input_images: [prepared.source, 'data:image/png;base64,cmVm'],
        mask: prepared.mask,
        prompt: '把选区里的椅子换成绿色，选区原图位置 {"left":2000}',
      },
      crop,
      prepared.originalSize,
    )
    expect(upstream.input_images[1]).toBe('data:image/png;base64,cmVm')
    // 提示词里的位置按整张原图写：补上截图在原图里的偏移，原文不动。
    expect(upstream.prompt).toStartWith('把选区里的椅子换成绿色，选区原图位置 {"left":2000}')
    expect(upstream.prompt).toContain(`(${crop.left}, ${crop.top})`)
    expect(upstream.prompt).toContain(`${crop.width}×${crop.height}`)
    expect(
      (await cropMaskedUpstream({ input_images: [prepared.source], mask: prepared.mask }, crop))
        .prompt,
    ).toBeUndefined()
    const sent = await sharp(decode(upstream.input_images[0]!))
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([sent.info.width, sent.info.height]).toEqual([padded.width, padded.height])
    expect(
      await sharp(decode(upstream.input_images[0]!))
        .extract({ left: 0, top: 0, width: crop.width, height: crop.height })
        .raw()
        .toBuffer(),
    ).toEqual(await sharp(original).extract(crop).raw().toBuffer())
    const sentMask = await sharp(decode(upstream.mask)).raw().toBuffer({ resolveWithObject: true })
    expect(
      sentMask.data[((1000 - crop.top) * sentMask.info.width + (2100 - crop.left)) * 4 + 3],
    ).toBe(0)
    expect(
      sentMask.data[((900 - crop.top - 1) * sentMask.info.width + (2100 - crop.left)) * 4 + 3],
    ).toBe(255)

    // 上游原样大小回一张全白的；再试一张缩小到 0.7 倍的。
    const protect = await protectMaskedOutput(
      prepared.source,
      prepared.mask,
      prepared.originalSize,
      crop,
    )
    for (const scale of [1, 0.7]) {
      const candidate = await sharp({
        create: {
          width: Math.round(padded.width * scale),
          height: Math.round(padded.height * scale),
          channels: 3,
          background: '#ffffff',
        },
      })
        .png()
        .toBuffer()
      const delivered = await protect(candidate)
      const out = await sharp(delivered.bytes).raw().toBuffer({ resolveWithObject: true })
      expect([out.info.width, out.info.height]).toEqual([width, height])
      let outsideChanged = 0
      for (let index = 0; index < out.data.length; index += 4)
        if (rawMask[index + 3] === 255 && out.data.readUInt32BE(index) !== raw.readUInt32BE(index))
          outsideChanged++
      expect(outsideChanged).toBe(0)
      // 选区内部（离边界远一点）是生成的白色。
      const inner = (1100 * width + 2300) * 4
      expect([...out.data.subarray(inner, inner + 3)]).toEqual([255, 255, 255])
      expect(delivered.inspection).toMatchObject({
        maskedCrop: 1,
        maskedCropLeft: crop.left,
        maskedCropTop: crop.top,
      })
      expect(delivered.inspection.scaleX).toBeCloseTo(1 / scale, 1)
    }
  })
})
