import { expect, it } from 'bun:test'
import sharp from 'sharp'
import { inspectMaskedAlignment } from '../../../lib/agent/masked-alignment'
import { protectMaskedOutput, upstreamFit } from '../../../lib/agent/masked-output'

/** 对齐只记录、不拒收：块相关没对上，或主体轮廓整体挪了位。 */
const misaligned = (inspection: Record<string, number>) =>
  !inspection.alignmentAccepted || !inspection.translationAligned

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

it('accepts fine texture changes on a flat background and only flags a different background tone', async () => {
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
  const toned = await protect(await encode(candidate))
  expect(toned.inspection.alignmentAccepted).toBe(0)
  const tonedOutput = await sharp(toned.bytes).raw().toBuffer()
  for (let i = 0; i < source.length; i += 4)
    if (mask[i + 3] === 255 && !source.subarray(i, i + 4).equals(tonedOutput.subarray(i, i + 4)))
      throw new Error('changed protected pixel')
})

it('accepts a product edit with regenerated fine texture and flags shifted protected objects', async () => {
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
  expect(misaligned((await protect(shifted)).inspection)).toBe(true)
})

it('restores protected pixels exactly and confines feathering to the approved selection', async () => {
  const protect = await protectMaskedOutput(url(source), url(mask))
  const result = await protect(await png([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]))
  const output = (await sharp(result.bytes).raw().toBuffer()).subarray(0, 12)
  expect([...output]).toEqual([0, 0, 255, 255, 0, 255, 0, 255, 128, 0, 127, 255])
  expect(result.inspection).toMatchObject({ outsideChangedPixels: 1, insideChangedPixels: 2 })
  expect(result.mime).toBe('image/png')
})

it('resizes a candidate of any other size instead of refusing it', async () => {
  const protect = await protectMaskedOutput(url(source), url(mask))
  const result = await protect(
    await sharp({ create: { width: 1, height: 1, channels: 4, background: 'blue' } })
      .png()
      .toBuffer(),
  )
  expect(result.inspection).toMatchObject({ fit: 1, rescaled: 1 })
  const output = await sharp(result.bytes).raw().toBuffer()
  const original = await sharp(source).raw().toBuffer()
  expect([...output.subarray(0, 4)]).toEqual([0, 0, 255, 255])
  for (let i = 12; i < original.length; i++) if (output[i] !== original[i]) throw new Error('moved')
})

it('flags same-size candidates whose protected landmarks have shifted, still delivering them', async () => {
  const protect = await protectMaskedOutput(url(source), url(mask))
  const shifted = await sharp(source)
    .extract({ left: 8, top: 0, width: 88, height: 96 })
    .extend({ left: 0, right: 8, top: 0, bottom: 0, background: '#fff' })
    .png()
    .toBuffer()
  const result = await protect(shifted)
  expect(misaligned(result.inspection)).toBe(true)
  expect(result.inspection.outsideChangedPixels).toBeGreaterThan(0)
  expect([...(await sharp(result.bytes).raw().toBuffer()).subarray(4, 8)]).toEqual([0, 255, 0, 255])
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

it('corrects a small uniform scale and flags a candidate whose texture moved', async () => {
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
  expect(misaligned((await protect(shifted)).inspection)).toBe(true)
})

it('rescales over an untextured background too, protected pixels staying the original', async () => {
  const blank = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#fff' } })
    .png()
    .toBuffer()
  const protect = await protectMaskedOutput(url(blank), url(mask))
  const result = await protect(await sharp(blank).resize(95, 95).png().toBuffer())
  expect(result.inspection).toMatchObject({
    rescaled: 1,
    texturedRegions: 0,
    outsideChangedPixels: 0,
  })
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

it('counts a subtle edit (a slight warm tint) as changed, measured against the redraw noise', async () => {
  const { width, raw, selection, inA, inB, encode } = await twoRegionFixture()
  const protect = await protectMaskedOutput(url(await encode(raw)), url(await encode(selection)))
  const copy = Buffer.from(raw)
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (inA(x, y)) copy.set([10, 10, 10], i)
      // B 只偏暖一点：每个像素红通道 +8，远低于 24 的大色差阈值。
      if (inB(x, y)) copy[i] = Math.min(255, copy[i]! + 8)
    }
  const result = await protect(await encode(copy))
  expect(result.inspection).toMatchObject({ regions: 2, regionsUnchanged: 0 })
})

it('only reports unchanged regions: no second request to the upstream', async () => {
  const { raw, selection, inA, encode, paint } = await twoRegionFixture()
  const protect = await protectMaskedOutput(url(await encode(raw)), url(await encode(selection)))
  const result = await protect(await paint([inA]))
  expect(result.inspection).toMatchObject({ regions: 2, regionsUnchanged: 1 })
  expect(result.inspection).not.toHaveProperty('regionRetries')
})

/** 一张处处有纹理的图，中间一块是选区；与上面的等比校正用例同一做法。 */
async function texturedCase(width: number, height: number) {
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
      if (x > width * 0.4 && x < width * 0.6 && y > height * 0.4 && y < height * 0.6)
        selection[i + 3] = 0
    }
  const original = await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  const m = await sharp(selection, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  return { raw, selection, original, mask: m }
}

function expectProtectedUnchanged(raw: Buffer, selection: Buffer, delivered: Buffer) {
  let changed = 0
  for (let i = 0; i < raw.length; i += 4)
    if (selection[i + 3] === 255 && !raw.subarray(i, i + 4).equals(delivered.subarray(i, i + 4)))
      changed++
  expect(changed).toBe(0)
}

it('accepts an upstream output at its own pixel tier when the aspect ratio matches (912→1254)', async () => {
  // 上游不按请求尺寸出图：方图一律回 1254×1254。缩回原尺寸后照常核对，蒙版外一个像素不变。
  const { raw, selection, original, mask: m } = await texturedCase(304, 304)
  const protect = await protectMaskedOutput(url(original), url(m))
  const result = await protect(await sharp(original).resize(418, 418).png().toBuffer())
  expect(result.inspection.rescaled).toBe(1)
  expect(result.inspection).toMatchObject({ width: 304, height: 304 })
  expectProtectedUnchanged(raw, selection, await sharp(result.bytes).raw().toBuffer())
})

it('upscales an output 2× smaller than the original (a large upload) instead of refusing it', async () => {
  const { raw, selection, original, mask: m } = await texturedCase(480, 320)
  const protect = await protectMaskedOutput(url(original), url(m))
  const result = await protect(await sharp(original).resize(240, 160).png().toBuffer())
  expect(result.inspection).toMatchObject({ fit: 1, width: 480, height: 320, scaleX: 2 })
  expectProtectedUnchanged(raw, selection, await sharp(result.bytes).raw().toBuffer())
})

it('accepts an output larger than requested at the known tiers and scales it down', async () => {
  const { raw, selection, original, mask: m } = await texturedCase(480, 320)
  const protect = await protectMaskedOutput(url(original), url(m))
  // 768×1024 → 1086×1448 那一档：1.41×。
  const result = await protect(await sharp(original).resize(679, 453).png().toBuffer())
  expect(result.inspection.rescaled).toBe(1)
  expectProtectedUnchanged(raw, selection, await sharp(result.bytes).raw().toBuffer())
})

it('tolerates rounding in the upstream size and crops around the selection for another aspect ratio', async () => {
  const { raw, selection, original, mask: m } = await texturedCase(304, 304)
  const protect = await protectMaskedOutput(url(original), url(m))
  // 418×419 只是取整差（0.24%），照常缩回。
  const rounded = await protect(await sharp(original).resize(418, 419).png().toBuffer())
  expect(rounded.inspection.rescaled).toBe(1)
  expect(rounded.inspection.fit).toBe(1)
  // 宽高比差 3%：等比铺满后以选区为中心裁出原尺寸，照常交付，选区外仍是原图。
  const cropped = await protect(
    await sharp(original).resize(418, 406, { fit: 'fill' }).png().toBuffer(),
  )
  expect(cropped.inspection).toMatchObject({
    fit: 2,
    width: 304,
    height: 304,
  })
  expectProtectedUnchanged(raw, selection, await sharp(cropped.bytes).raw().toBuffer())
})

it('flags (but delivers) a same-aspect output whose content moved after the rescale', async () => {
  const { original, mask: m } = await texturedCase(304, 304)
  const protect = await protectMaskedOutput(url(original), url(m))
  const moved = await sharp(original)
    .extract({ left: 24, top: 0, width: 280, height: 304 })
    .extend({ left: 0, top: 0, right: 24, bottom: 0, background: '#fff' })
    .png()
    .toBuffer()
  expect(
    misaligned((await protect(await sharp(moved).resize(418, 418).png().toBuffer())).inspection),
  ).toBe(true)
})

it('scales the sizes prod upstreams actually return, cropping only when the aspect ratio differs', () => {
  const focus = (w: number, h: number) => ({ x: w / 2, y: h / 2 })
  // 请求尺寸 → 付费版近 60 天上游实际回的尺寸（只读统计），以及 4K 原图只回的 1672×941。
  for (const [w, h, gw, gh, fit] of [
    [1024, 1024, 1024, 1024, 0],
    [1024, 1024, 1254, 1254, 1],
    [912, 912, 1254, 1254, 1],
    [720, 1280, 941, 1672, 1],
    [720, 1280, 940, 1672, 1],
    [1280, 720, 1671, 941, 1],
    [768, 1024, 1086, 1448, 1],
    [3840, 2160, 1672, 941, 1],
    [1024, 1024, 2048, 2048, 1],
    [96, 96, 1, 1, 1],
    [1248, 1280, 1240, 1268, 2],
    [1280, 720, 1774, 887, 2],
    [1920, 816, 1916, 821, 2],
  ] as const)
    expect(upstreamFit(w, h, gw, gh, focus(w, h)).fit).toBe(fit)
})

it('crops around the selection: centred when the selection is centred, never past the edge', () => {
  // 1000×500 原图，上游回了方图：等比铺满成 1000×1000，再纵向裁出 500。
  expect(upstreamFit(1000, 500, 1000, 1000, { x: 500, y: 250 })).toMatchObject({
    fit: 2,
    coverWidth: 1000,
    coverHeight: 1000,
    left: 0,
    top: 250,
  })
  expect(upstreamFit(1000, 500, 1000, 1000, { x: 500, y: 100 }).top).toBe(100)
  expect(upstreamFit(1000, 500, 1000, 1000, { x: 500, y: 500 }).top).toBe(500)
  expect(upstreamFit(1000, 500, 500, 1000, { x: 0, y: 0 })).toMatchObject({ left: 0, top: 0 })
})

/**
 * 换背景的典型：保护区只剩画面中下部一个小而平滑的主体（浴缸），往里收过一圈；主体以外全部重绘。
 * 与 results-v5 那一单同一种形状：保护区里有纹理的格只有个位数、落在两个象限。
 */
async function smoothSubjectCase(size = 480) {
  const raw = Buffer.alloc(size * size * 4),
    subject = new Uint8Array(size * size)
  const cx = size * 0.5,
    cy = size * 0.66,
    rx = size * 0.3,
    ry = size * 0.17
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
      subject[y * size + x] = inside ? 1 : 0
      // 背景是带纹理的墙；主体是平滑明暗加几道竖向反光。
      raw.set(
        inside
          ? [
              // 平滑的明暗加几道竖向反光：块内有起伏，但整块主体只占几格。
              150 + 50 * Math.cos(((y - cy) / ry) * 1.4) + 30 * Math.sin(x / 9),
              148 + 50 * Math.cos(((y - cy) / ry) * 1.4) + 30 * Math.sin(x / 9),
              145 + 50 * Math.cos(((y - cy) / ry) * 1.4) + 30 * Math.sin(x / 9),
              255,
            ]
          : [
              150 + 30 * Math.sin(x / 7) * Math.cos(y / 9),
              130 + 25 * Math.sin((x + y) / 11),
              110,
              255,
            ],
        i,
      )
    }
  // 反选：主体以外都重绘，并往主体里吃进 8px（与网页 invertInset 同一用意）。
  const inset = 8
  const selection = Buffer.alloc(raw.length, 255)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let keep = subject[y * size + x] === 1
      for (let dy = -inset; keep && dy <= inset; dy += 2)
        for (let dx = -inset; dx <= inset; dx += 2) {
          const yy = y + dy,
            xx = x + dx
          if (dx * dx + dy * dy > inset * inset) continue
          if (yy < 0 || yy >= size || xx < 0 || xx >= size || !subject[yy * size + xx]) {
            keep = false
            break
          }
        }
      if (!keep) selection[(y * size + x) * 4 + 3] = 0
    }
  const original = await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
  const mask = await sharp(selection, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
  // 换了背景、主体原样的候选：主体以外涂成「海边」的蓝，主体连同轮廓保留。
  const edited = Buffer.from(raw)
  for (let i = 0; i < subject.length; i++)
    if (!subject[i]) edited.set([70 + ((i % size) % 13), 140, 205 - ((i / size) % 17), 255], i * 4)
  const candidate = await sharp(edited, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
  return { raw, selection, original, mask, candidate, size }
}

it('accepts a rescaled background swap whose small smooth subject gives only local evidence', async () => {
  const { raw, selection, original, mask: m, candidate, size } = await smoothSubjectCase()
  const protect = await protectMaskedOutput(url(original), url(m))
  // 上游按自己的档位出图：480 → 483（0.6% 放大，宽高比一致）。
  const result = await protect(await sharp(candidate).resize(483, 483).png().toBuffer())
  expect(result.inspection.rescaled).toBe(1)
  // 证据只在局部：格数不到 12、象限不到 3，但每一格都对得上。
  expect(result.inspection.texturedRegions).toBeGreaterThanOrEqual(4)
  expect(result.inspection.texturedRegions).toBeLessThan(12)
  expect(result.inspection.matchedRegions).toBe(result.inspection.texturedRegions)
  expect(result.inspection.matchedQuadrants).toBeLessThan(3)
  expect(result.inspection).toMatchObject({ width: size, height: size })
  expectProtectedUnchanged(raw, selection, await sharp(result.bytes).raw().toBuffer())
})

it('flags (but delivers) a background swap whose content moved, rescaled or not', async () => {
  const { original, mask: m, candidate, size } = await smoothSubjectCase()
  const protect = await protectMaskedOutput(url(original), url(m))
  for (const [dx, dy] of [
    [8, 0],
    [0, 8],
    [12, 6],
  ] as const) {
    const moved = await sharp(candidate)
      .extract({ left: dx, top: dy, width: size - dx, height: size - dy })
      .extend({ right: dx, bottom: dy, background: '#4682cd' })
      .png()
      .toBuffer()
    for (const edge of [size, 483])
      expect(
        misaligned(
          (await protect(await sharp(moved).resize(edge, edge).png().toBuffer())).inspection,
        ),
      ).toBe(true)
  }
})
