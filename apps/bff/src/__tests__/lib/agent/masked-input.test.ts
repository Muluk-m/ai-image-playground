import { expect, it } from 'bun:test'
import sharp from 'sharp'
import { prepareMaskedInput } from '../../../lib/agent/masked-input'
import { protectMaskedOutput } from '../../../lib/agent/masked-output'

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
