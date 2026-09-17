import { expect, it } from 'bun:test'
import sharp from 'sharp'
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

it('preserves source alpha outside the selection and blends transparent candidates correctly', async () => {
  const transparent = await png([80, 40, 20, 128, 0, 255, 0, 255])
  const selection = await png([0, 0, 0, 255, 0, 0, 0, 128], true)
  const protect = await protectMaskedOutput(url(transparent), url(selection))
  const result = await protect(await png([255, 255, 255, 255, 255, 0, 0, 0]))
  expect([...(await sharp(result.bytes).raw().toBuffer()).subarray(0, 8)]).toEqual([
    80, 40, 20, 128, 0, 255, 0, 128,
  ])
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
