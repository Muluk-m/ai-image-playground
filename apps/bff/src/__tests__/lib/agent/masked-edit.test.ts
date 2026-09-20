import { expect, it } from 'bun:test'
import sharp from 'sharp'
import { prepareMaskedEdit } from '../../../lib/agent/masked-edit'
import { imageSelection, referenceEvidence } from '../../../lib/agent/selection-preview'

async function png(pixels: number[], width = 2) {
  return `data:image/png;base64,${(
    await sharp(Buffer.from(pixels), { raw: { width, height: 1, channels: 4 } })
      .png()
      .toBuffer()
  ).toString('base64')}`
}
const dataUrl = await png([255, 0, 0, 255, 0, 255, 0, 255])
const maskDataUrl = await png([0, 0, 0, 0, 0, 0, 0, 255])
const image = { imageId: 'target', dataUrl, maskDataUrl }
const selection = (await imageSelection(image))!

it('retains original color evidence and isolates only selected reference pixels', async () => {
  const evidence = await referenceEvidence([image])
  expect(evidence.content).toHaveLength(3)
  expect(evidence.content[0]!.data).toBe(dataUrl.split(',')[1])
  expect(evidence.manifest).toContain(selection.id)
  const pixels = await sharp(Buffer.from(selection.crop.split(',')[1]!, 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer()
  expect([...pixels]).toEqual([255, 0, 0, 255])
})

it('binds the selection to actual image bytes and rejects stale or omitted bindings', async () => {
  const changed = { ...image, dataUrl: await png([0, 0, 255, 255, 0, 255, 0, 255]) }
  expect((await imageSelection(changed))!.id).not.toBe(selection.id)
  await expect(prepareMaskedEdit([image], undefined, '改选中部分')).rejects.toThrow('选区绑定')
  await expect(
    prepareMaskedEdit([changed], [{ imageId: 'target', selectionId: selection.id }], '改选中部分'),
  ).rejects.toThrow('过期')
})

it('refuses a masked edit when there is no authorization text to check it against', async () => {
  await expect(
    prepareMaskedEdit([image], [{ imageId: 'target', selectionId: selection.id }], '  '),
  ).rejects.toThrow('缺少用户原文，请重新说明要改哪里')
})

it('compiles user words and real reference ROI instead of planner embellishments', async () => {
  const reference = { ...image, imageId: 'reference' }
  const request = await prepareMaskedEdit(
    [image, reference],
    [
      { imageId: 'target', selectionId: selection.id },
      { imageId: 'reference', selectionId: selection.id },
    ],
    '修改[image 1]这个头枕位置，参考[image 2]，其他不变，',
  )
  expect(request!.inputImages).toEqual([dataUrl, selection.crop])
  expect(request!.mask).toBe(maskDataUrl)
  expect(request!.prompt).toContain('修改[image 1]这个头枕位置，参考[image 2]，其他不变，')
  expect(request!.prompt).not.toContain('更低、更贴近椅背上沿')
  expect(request!.prompt).not.toContain('参数卡片全部保持不变')
})

it('rejects empty and opaque RGB masks but accepts intentional full selections', async () => {
  const opaque = await png([0, 0, 0, 255, 0, 0, 0, 255])
  await expect(imageSelection({ dataUrl, maskDataUrl: opaque })).rejects.toThrow('没有选中')
  const rgb = `data:image/png;base64,${(
    await sharp(Buffer.from(opaque.split(',')[1]!, 'base64'))
      .removeAlpha()
      .png()
      .toBuffer()
  ).toString('base64')}`
  await expect(imageSelection({ dataUrl, maskDataUrl: rgb })).rejects.toThrow('透明选区')
  const full = await png([0, 0, 0, 0, 0, 0, 0, 0])
  expect((await imageSelection({ dataUrl, maskDataUrl: full }))!.bounds.width).toBe(2)
})

it('does not replace a disconnected selection with its entire bounding rectangle', async () => {
  const picture = await png([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], 3)
  const mask = await png([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0], 3)
  const selected = (await imageSelection({ dataUrl: picture, maskDataUrl: mask }))!
  const pixels = await sharp(Buffer.from(selected.crop.split(',')[1]!, 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer()
  expect(pixels[3]).toBe(255)
  expect(pixels[7]).toBe(0)
  expect(pixels[11]).toBe(255)
})
