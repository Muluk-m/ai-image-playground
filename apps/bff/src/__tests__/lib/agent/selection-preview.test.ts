import { expect, it } from 'bun:test'
import sharp from 'sharp'
import { selectionPreview } from '../../../lib/agent/selection-preview'

it('highlights only transparent mask pixels without modifying the reference bytes', async () => {
  const dataUrl = `data:image/png;base64,${(
    await sharp({ create: { width: 2, height: 1, channels: 4, background: '#ffffff' } })
      .png()
      .toBuffer()
  ).toString('base64')}`
  const maskDataUrl = `data:image/png;base64,${(
    await sharp(Buffer.from([0, 0, 0, 0, 0, 0, 0, 255]), {
      raw: { width: 2, height: 1, channels: 4 },
    })
      .png()
      .toBuffer()
  ).toString('base64')}`
  const result = await selectionPreview({ dataUrl, maskDataUrl })
  const pixels = await sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer()
  expect(pixels[0]).toBeLessThan(255)
  expect(pixels[2]).toBeGreaterThan(pixels[0]!)
  expect([...pixels.subarray(4)]).toEqual([255, 255, 255, 255])
  expect((await selectionPreview({ dataUrl })).data).toBe(dataUrl.split(',')[1])
})

it('rejects mismatched masks rather than guessing selection coordinates', async () => {
  const image = async (width: number) =>
    `data:image/png;base64,${(
      await sharp({ create: { width, height: 1, channels: 4, background: '#ffffff' } })
        .png()
        .toBuffer()
    ).toString('base64')}`
  await expect(
    selectionPreview({ dataUrl: await image(2), maskDataUrl: await image(1) }),
  ).rejects.toThrow('dimensions')
})
