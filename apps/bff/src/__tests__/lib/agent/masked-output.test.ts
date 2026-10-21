import { expect, it } from 'bun:test'
import sharp from 'sharp'
import { inspectMaskedAlignment } from '../../../lib/agent/masked-alignment'
import { protectMaskedOutput } from '../../../lib/agent/masked-output'

async function png(values: number[], mask = false) {
  const raw = Buffer.alloc(96 * 96 * 4)
  for (let i = 0; i < raw.length; i += 4)
    raw.set(mask ? [0, 0, 0, 255] : [i % 251, (i * 7) % 253, (i * 3) % 249, 255], i)
  raw.set(values)
  return sharp(raw, { raw: { width: 96, height: 96, channels: 4 } })
    .png()
    .toBuffer()
}
const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`
const source = await png([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255])
const mask = await png([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 128], true)

it('accepts fine texture changes on a flat background but rejects a different background tone', async () => {
  const width = 768,
    height = 768
  const source = Buffer.alloc(width * height * 4),
    candidate = Buffer.alloc(source.length),
    mask = Buffer.alloc(source.length, 255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const texture = (x + y) % 2 ? 30 : -30
      source.set([128 + texture, 128 + texture, 128 + texture, 255], i)
      candidate.set([128 - texture, 128 - texture, 128 - texture, 255], i)
      if (x > 390 && y > 390) mask[i + 3] = 0
    }
  const encode = (data: Buffer) =>
    sharp(data, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
  const protect = await protectMaskedOutput(url(await encode(source)), url(await encode(mask)))
  const result = await protect(await encode(candidate))
  expect(result.inspection.texturedRegions).toBe(0)
  const output = await sharp(result.bytes).raw().toBuffer()
  for (let i = 0; i < source.length; i += 4)
    if (mask[i + 3] === 255 && !source.subarray(i, i + 4).equals(output.subarray(i, i + 4)))
      throw new Error('changed protected pixel')
  for (let i = 0; i < candidate.length; i += 4)
    for (let channel = 0; channel < 3; channel++) candidate[i + channel]! += 20
  await expect(protect(await encode(candidate))).rejects.toThrow('位置对应无法确认')
})

it('accepts a product edit with regenerated fine texture but rejects shifted protected objects', async () => {
  const width = 768,
    height = 768
  const source = Buffer.alloc(width * height * 4),
    candidate = Buffer.alloc(source.length),
    mask = Buffer.alloc(source.length, 255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const selected = x > 390 && y > 390
      const object = x > 80 && x < 680 && y > 80 && y < 680
      const tone = object ? 110 + 45 * Math.sin(x / 35) * Math.cos(y / 30) : 255
      const texture = object ? ((x + y) % 2 ? 30 : -30) : 0
      source.set([tone + texture, tone + texture, tone + texture, 255], i)
      candidate.set(
        selected ? [20, 160, 120, 255] : [tone - texture, tone - texture, tone - texture, 255],
        i,
      )
      if (selected) mask[i + 3] = 0
    }
  const encode = (data: Buffer) =>
    sharp(data, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
  // 原逐像素相关性会被反相的细纹理击穿，即使商品轮廓仍在原位。
  expect(inspectMaskedAlignment(source, candidate, mask, width, height).accepted).toBe(true)
  const protect = await protectMaskedOutput(url(await encode(source)), url(await encode(mask)))
  const result = await protect(
    await sharp(await encode(candidate))
      .jpeg({ quality: 85 })
      .toBuffer(),
  )
  const output = await sharp(result.bytes).ensureAlpha().raw().toBuffer()
  for (let i = 0; i < source.length; i += 4)
    if (mask[i + 3] === 255 && !source.subarray(i, i + 4).equals(output.subarray(i, i + 4)))
      throw new Error('changed protected pixel')
  expect(result.inspection.insideChangedPixels).toBeGreaterThan(0)
  const shifted = await sharp(await encode(candidate))
    .extract({ left: 24, top: 0, width: width - 24, height })
    .extend({ left: 0, right: 24, top: 0, bottom: 0, background: '#fff' })
    .png()
    .toBuffer()
  await expect(protect(shifted)).rejects.toThrow('位置对应无法确认')
})

it('restores protected pixels exactly and confines feathering to the approved selection', async () => {
  const protect = await protectMaskedOutput(url(source), url(mask))
  const result = await protect(await png([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]))
  const output = (await sharp(result.bytes).raw().toBuffer()).subarray(0, 12)
  expect([...output]).toEqual([0, 0, 255, 255, 0, 255, 0, 255, 128, 0, 127, 255])
  expect(result.inspection).toMatchObject({ outsideChangedPixels: 1, insideChangedPixels: 2 })
  expect(result.mime).toBe('image/png')
})

it('does not resize a generated candidate to fit a different coordinate system', async () => {
  const protect = await protectMaskedOutput(url(source), url(mask))
  await expect(
    protect(
      await sharp({ create: { width: 1, height: 1, channels: 4, background: 'blue' } })
        .png()
        .toBuffer(),
    ),
  ).rejects.toThrow('尺寸与原图不一致')
})

it('rejects same-size candidates whose protected landmarks have shifted', async () => {
  const protect = await protectMaskedOutput(url(source), url(mask))
  const shifted = await sharp(source)
    .extract({ left: 8, top: 0, width: 88, height: 96 })
    .extend({ left: 0, right: 8, top: 0, bottom: 0, background: '#fff' })
    .png()
    .toBuffer()
  await expect(protect(shifted)).rejects.toThrow('位置对应无法确认')
})

it('preserves source alpha outside the selection and treats candidate alpha as opaque colour', async () => {
  const transparent = await png([80, 40, 20, 128, 0, 255, 0, 255])
  const selection = await png([0, 0, 0, 255, 0, 0, 0, 128], true)
  const protect = await protectMaskedOutput(url(transparent), url(selection))
  // 上游回的透明度不进结果：选区里只取它的颜色，结果不会因此变成半透明。
  const result = await protect(await png([255, 255, 255, 255, 255, 0, 0, 0]))
  expect([...(await sharp(result.bytes).raw().toBuffer()).subarray(0, 8)]).toEqual([
    80, 40, 20, 128, 127, 128, 0, 255,
  ])
  expect(result.inspection.translucentPixels).toBe(1)
})

it('corrects a small uniform scale only when protected texture still matches across the image', async () => {
  const width = 256,
    height = 256
  const raw = Buffer.alloc(width * height * 4),
    selection = Buffer.alloc(raw.length, 255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      raw.set(
        [
          128 + 80 * Math.sin(x / 9),
          128 + 80 * Math.cos(y / 11),
          128 + 70 * Math.sin((x + y) / 7),
          255,
        ],
        i,
      )
      if (x > 105 && x < 150 && y > 105 && y < 150) selection[i + 3] = 0
    }
  const original = await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  const m = await sharp(selection, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  const protect = await protectMaskedOutput(url(original), url(m))
  const result = await protect(await sharp(original).resize(248, 248).png().toBuffer())
  expect(result.inspection.rescaled).toBe(1)
  expect(result.inspection.matchedQuadrants).toBe(4)
  const delivered = await sharp(result.bytes).raw().toBuffer()
  for (let i = 0; i < raw.length; i += 4)
    if (selection[i + 3] === 255 && !raw.subarray(i, i + 4).equals(delivered.subarray(i, i + 4)))
      throw new Error('changed protected pixel')
  const moved = await sharp(original)
    .extract({ left: 20, top: 0, width: 236, height })
    .extend({ left: 0, top: 0, right: 20, bottom: 0, background: '#fff' })
    .png()
    .toBuffer()
  const shifted = await sharp(moved).resize(248, 248).png().toBuffer()
  await expect(protect(shifted)).rejects.toThrow('位置对应无法确认')
})

it('does not infer a scale correction from an untextured background', async () => {
  const blank = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#fff' } })
    .png()
    .toBuffer()
  const protect = await protectMaskedOutput(url(blank), url(mask))
  await expect(protect(await sharp(blank).resize(95, 95).png().toBuffer())).rejects.toThrow(
    '位置对应无法确认',
  )
})

it('smooths only inward while retaining full edits in the interior and original outside pixels', async () => {
  const width = 256,
    height = 256
  const source = Buffer.alloc(width * height * 4),
    candidate = Buffer.alloc(source.length),
    mask = Buffer.alloc(source.length, 255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const selected = x >= 50 && x < 206 && y >= 50 && y < 206
      source.set([255, 0, 0, 255], i)
      candidate.set(selected ? [0, 0, 255, 255] : [255, 0, 0, 255], i)
      if (selected) mask[i + 3] = 0
    }
  const encode = (data: Buffer) =>
    sharp(data, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
  const protect = await protectMaskedOutput(url(await encode(source)), url(await encode(mask)))
  const result = await protect(await encode(candidate))
  const output = await sharp(result.bytes).raw().toBuffer()
  const pixel = (x: number, y: number) => [
    ...output.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
  ]
  expect(pixel(49, 100)).toEqual([255, 0, 0, 255])
  expect(pixel(50, 100)).toEqual([191, 0, 64, 255])
  expect(pixel(100, 100)).toEqual([0, 0, 255, 255])
})

/** 256² 带纹理的原图，选区是两个 40×40 的方块（A 在左上、B 在右下）。 */
async function twoRegionFixture() {
  const width = 256,
    height = 256
  const raw = Buffer.alloc(width * height * 4),
    selection = Buffer.alloc(raw.length, 255)
  const inA = (x: number, y: number) => x >= 40 && x < 80 && y >= 40 && y < 80
  const inB = (x: number, y: number) => x >= 170 && x < 210 && y >= 170 && y < 210
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      raw.set(
        [
          128 + 80 * Math.sin(x / 9),
          128 + 80 * Math.cos(y / 11),
          128 + 70 * Math.sin((x + y) / 7),
          255,
        ],
        i,
      )
      if (inA(x, y) || inB(x, y)) selection[i + 3] = 0
    }
  const encode = (data: Buffer) =>
    sharp(data, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
  /** 原图的一份拷贝，只把给定方块涂成纯色。 */
  const paint = (regions: ((x: number, y: number) => boolean)[], alpha = 255) => {
    const copy = Buffer.from(raw)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        copy[i + 3] = alpha
        if (regions.some((inside) => inside(x, y))) copy.set([10, 10, 10], i)
      }
    return encode(copy)
  }
  return { width, height, raw, selection, inA, inB, encode, paint }
}

it('accepts a candidate whose every pixel is translucent and composites it opaque', async () => {
  const { raw, selection, inA, inB, encode, paint, width } = await twoRegionFixture()
  const protect = await protectMaskedOutput(url(await encode(raw)), url(await encode(selection)))
  const result = await protect(await paint([inA, inB], 200))
  expect(result.inspection.translucentPixels).toBe(width * width)
  const delivered = await sharp(result.bytes).raw().toBuffer()
  for (let i = 0; i < raw.length; i += 4) {
    expect(delivered[i + 3]).toBe(255)
    if (selection[i + 3] === 255 && !raw.subarray(i, i + 4).equals(delivered.subarray(i, i + 4)))
      throw new Error('changed protected pixel')
  }
})

it('regenerates only the region the model left unchanged and composites it in', async () => {
  const { width, raw, selection, inA, inB, encode, paint } = await twoRegionFixture()
  const masks: Buffer[] = []
  const protect = await protectMaskedOutput(
    url(await encode(raw)),
    url(await encode(selection)),
    undefined,
    {
      repair: async (mask) => {
        masks.push(
          await sharp(Buffer.from(mask.split(',')[1]!, 'base64'))
            .raw()
            .toBuffer(),
        )
        // 重试的这张把 A 也画回原样、只改了 B：A 不能被它覆盖。
        return paint([inB])
      },
    },
  )
  const result = await protect(await paint([inA]))
  expect(masks).toHaveLength(1)
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++)
      expect(masks[0]![(y * width + x) * 4 + 3]).toBe(inB(x, y) ? 0 : 255)
  expect(result.inspection).toMatchObject({
    regions: 2,
    regionsUnchanged: 1,
    regionRetries: 1,
    regionsStillUnchanged: 0,
    outsideChangedPixels: 0,
  })
  const delivered = await sharp(result.bytes).raw().toBuffer()
  const at = (x: number, y: number) => [
    ...delivered.subarray((y * width + x) * 4, (y * width + x) * 4 + 3),
  ]
  expect(at(60, 60)).toEqual([10, 10, 10])
  expect(at(190, 190)).toEqual([10, 10, 10])
  for (let i = 0; i < raw.length; i += 4)
    if (selection[i + 3] === 255 && !raw.subarray(i, i + 4).equals(delivered.subarray(i, i + 4)))
      throw new Error('changed protected pixel')
})

it('caps region retries and still delivers the composited candidate', async () => {
  const { raw, selection, inA, encode, paint } = await twoRegionFixture()
  let calls = 0
  const protect = await protectMaskedOutput(
    url(await encode(raw)),
    url(await encode(selection)),
    undefined,
    {
      repair: async () => {
        calls++
        return encode(raw)
      },
    },
  )
  const candidate = await paint([inA])
  const result = await protect(candidate)
  expect(calls).toBe(2)
  expect(result.inspection).toMatchObject({
    regionsUnchanged: 1,
    regionRetries: 2,
    regionsStillUnchanged: 1,
  })
  // 归档重试时同一张候选再合成一次，不再向上游要图。
  await protect(candidate)
  expect(calls).toBe(2)
})

it('ignores a retry whose protected area moved', async () => {
  const { width, raw, selection, inA, inB, encode, paint } = await twoRegionFixture()
  const protect = await protectMaskedOutput(
    url(await encode(raw)),
    url(await encode(selection)),
    undefined,
    {
      repair: async () =>
        sharp(await paint([inB]))
          .extract({ left: 12, top: 0, width: width - 12, height: width })
          .extend({ right: 12, extendWith: 'copy' })
          .png()
          .toBuffer(),
    },
  )
  const result = await protect(await paint([inA]))
  expect(result.inspection).toMatchObject({ regionRetries: 2, regionsStillUnchanged: 1 })
})

it('only reports unchanged regions when no retry is available', async () => {
  const { raw, selection, inA, encode, paint } = await twoRegionFixture()
  const protect = await protectMaskedOutput(url(await encode(raw)), url(await encode(selection)))
  const result = await protect(await paint([inA]))
  expect(result.inspection).toMatchObject({ regions: 2, regionsUnchanged: 1, regionRetries: 0 })
})
