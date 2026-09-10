import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productShotJobStore } from '../../../../features/productShots/lib/jobStore'
import { matteGate } from '../../../../features/productShots/lib/matteGate'
import {
  createSourceMattes,
  type SourceMatteHost,
  type SourceMatteRef,
} from '../../../../features/productShots/lib/sourceMatte'
import type { ProductShotImage, SourceMatte } from '../../../../features/productShots/types'
import { DEFAULT_SETTINGS } from '../../../../lib/apiProfiles'
import { deleteImage, getImage, putImage } from '../../../../lib/db'
import type * as MaskAlpha from '../../../../lib/productMatte/maskAlpha'
import { alphaToDataUrl } from '../../../../lib/productMatte/maskAlpha'
import { initStore, useStore } from '../../../../store'
import { decodeRgbaPng } from '../../../helpers/png'

// Node 没有 Canvas；只替换 PNG 解码执行，agreement、扩张、极性与编码全部用真实实现。
vi.mock('../../../../lib/productMatte/maskAlpha', async (importOriginal) => ({
  ...(await importOriginal<typeof MaskAlpha>()),
  maskDataUrlToAlpha: async (dataUrl: string) => {
    const { data, width, height } = decodeRgbaPng(dataUrl)
    const alpha = new Uint8ClampedArray(width * height)
    for (let index = 0; index < alpha.length; index++) alpha[index] = data[index * 4 + 3]
    return { alpha, width, height }
  },
}))

beforeEach(() => {
  vi.stubGlobal('window', { requestIdleCallback: vi.fn() })
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ settings: DEFAULT_SETTINGS })
})

afterEach(() => vi.unstubAllGlobals())

function memoryHost(images: ProductShotImage[]): SourceMatteHost {
  return {
    read: (source) =>
      source.jobId === 'job' ? images.find((image) => image.imageId === source.imageId) : undefined,
    async update(source, transform) {
      if (source.jobId !== 'job') return
      const index = images.findIndex((image) => image.imageId === source.imageId)
      if (index >= 0) images[index] = transform(images[index])
    },
    pendingChanged() {},
  }
}

async function original(side: 'left' | 'right') {
  const width = 64
  const height = 64
  const alpha = new Uint8ClampedArray(width * height)
  const start = side === 'left' ? 4 : 40
  for (let y = 12; y < 52; y++) {
    for (let x = start; x < start + 20; x++) alpha[y * width + x] = 255
  }
  const dataUrl = alphaToDataUrl({ alpha, width, height })
  const alphaImageId = `alpha-${crypto.randomUUID()}`
  const ref: SourceMatteRef = { jobId: 'job', imageId: `source-${side}` }
  await putImage({ id: alphaImageId, dataUrl, createdAt: 1 })
  const image: ProductShotImage = {
    imageId: ref.imageId,
    versions: [],
    sourceMatte: {
      status: 'ready',
      backend: 'wasm-u2netp',
      alphaImageId,
      targetImageId: ref.imageId,
      previewImageId: 'preview',
      edited: false,
    },
  }
  return { ref, image, dataUrl, alphaImageId }
}

async function maskPixels(imageId: string) {
  const image = await getImage(imageId)
  if (!image) throw new Error('动作没有存下遮罩图片')
  return decodeRgbaPng(image.dataUrl)
}

describe('原图蒙版 interface 的真实像素', () => {
  it('两张原图分别使用自己的 alpha，不混用最后一次解码的原图', async () => {
    const left = await original('left')
    const right = await original('right')
    const mattes = createSourceMattes(memoryHost([left.image, right.image]))
    const first = await mattes.prepare(left.ref, {
      dataUrl: left.dataUrl,
      productBox: null,
      side: 'background',
    })
    const second = await mattes.prepare(right.ref, {
      dataUrl: right.dataUrl,
      productBox: null,
      side: 'background',
    })
    const firstPixels = await maskPixels(first.mask!.imageId)
    const secondPixels = await maskPixels(second.mask!.imageId)
    expect(firstPixels.data[(32 * 64 + 14) * 4 + 3]).toBe(255)
    expect(firstPixels.data[(32 * 64 + 50) * 4 + 3]).toBe(0)
    expect(secondPixels.data[(32 * 64 + 14) * 4 + 3]).toBe(0)
    expect(secondPixels.data[(32 * 64 + 50) * 4 + 3]).toBe(255)
  })

  it('每次动作按本次产品框重新判一致性，不沿用上次失败缓存或改变原始 alpha', async () => {
    const source = await original('left')
    const host = memoryHost([source.image])
    const mattes = createSourceMattes(host)
    const mismatch = await mattes.prepare(source.ref, {
      dataUrl: source.dataUrl,
      productBox: { x: 40 / 64, y: 12 / 64, w: 20 / 64, h: 40 / 64 },
      side: 'background',
    })
    expect(mismatch.mask).toBeNull()
    expect(mismatch.matte).toEqual({ ok: false, reason: 'box-mismatch' })
    const matched = await mattes.prepare(source.ref, {
      dataUrl: source.dataUrl,
      productBox: { x: 4 / 64, y: 12 / 64, w: 20 / 64, h: 40 / 64 },
      side: 'background',
    })
    const pixels = await maskPixels(matched.mask!.imageId)
    expect(pixels.data[(32 * 64 + 14) * 4 + 3]).toBe(255)
    expect(pixels.data[(32 * 64 + 50) * 4 + 3]).toBe(0)
    expect(host.read(source.ref)?.sourceMatte).toMatchObject({
      alphaImageId: source.alphaImageId,
      agreement: 'ok',
    })
    expect((await getImage(source.alphaImageId))?.dataUrl).toBe(source.dataUrl)
  })

  it('手改后忽略冲突的产品框，换背景与换产品输出相反极性且配对正确目标图', async () => {
    const source = await original('left')
    const mattes = createSourceMattes(memoryHost([source.image]))
    const targetImageId = `resized-${crypto.randomUUID()}`
    await putImage({ id: targetImageId, dataUrl: source.dataUrl, createdAt: 1 })
    const editor = await mattes.edit(source.ref)
    await editor!.onSave({ maskDataUrl: source.dataUrl, targetImageId })
    const input = {
      dataUrl: source.dataUrl,
      productBox: { x: 40 / 64, y: 12 / 64, w: 20 / 64, h: 40 / 64 },
    }
    const background = await mattes.prepare(source.ref, { ...input, side: 'background' })
    const product = await mattes.prepare(source.ref, { ...input, side: 'product' })
    const backgroundPixels = await maskPixels(background.mask!.imageId)
    const productPixels = await maskPixels(product.mask!.imageId)
    expect(backgroundPixels.data[(32 * 64 + 14) * 4 + 3]).toBe(255)
    expect(backgroundPixels.data[(32 * 64 + 50) * 4 + 3]).toBe(0)
    expect(productPixels.data[(32 * 64 + 14) * 4 + 3]).toBe(0)
    expect(productPixels.data[(32 * 64 + 50) * 4 + 3]).toBe(255)
    expect(product.image).toEqual({ id: targetImageId, dataUrl: source.dataUrl })
    expect(product.mask?.targetImageId).toBe(targetImageId)
  })

  it('占比不对的那份留着 alpha：编辑器照开，手改完就是可用蒙版', async () => {
    const source = await original('left')
    const ready = source.image.sourceMatte as Extract<SourceMatte, { status: 'ready' }>
    source.image.sourceMatte = { ...ready, status: 'unusable', reason: 'too-small' }
    const host = memoryHost([source.image])
    const mattes = createSourceMattes(host)
    const input = { dataUrl: source.dataUrl, productBox: null, side: 'background' } as const

    const blocked = await mattes.prepare(source.ref, input)
    expect(blocked.mask).toBeNull()
    expect(blocked.matte).toEqual({ ok: false, reason: 'too-small' })

    const editor = await mattes.edit(source.ref)
    expect(editor?.targetImageId).toBe(source.ref.imageId)
    await editor!.onSave({ maskDataUrl: source.dataUrl, targetImageId: source.ref.imageId })

    expect(host.read(source.ref)?.sourceMatte).toMatchObject({ status: 'ready', edited: true })
    const usable = await mattes.prepare(source.ref, input)
    expect(usable.mask).not.toBeNull()
  })

  it('刷新后的图片清理不能删掉手改蒙版，下一次换背景仍使用它', async () => {
    const source = await original('left')
    source.image.sourceMatte = {
      ...(source.image.sourceMatte as Extract<SourceMatte, { status: 'ready' }>),
      edited: true,
    }
    await putImage({ id: source.ref.imageId, dataUrl: source.dataUrl, createdAt: 1 })
    await productShotJobStore.put({
      id: source.ref.jobId,
      name: '商品图 2',
      images: [source.image],
      preference: '户外场景',
      versionsPerImage: 1,
      createdAt: 1,
      updatedAt: 1,
    })

    await initStore()

    const mattes = createSourceMattes(memoryHost([source.image]))
    const prepared = await mattes.prepare(source.ref, {
      dataUrl: source.dataUrl,
      productBox: null,
      side: 'background',
    })
    expect(prepared.notice).toBeNull()
    const pixels = await maskPixels(prepared.mask!.imageId)
    expect(pixels.data[(32 * 64 + 14) * 4 + 3]).toBe(255)
    expect(pixels.data[(32 * 64 + 50) * 4 + 3]).toBe(0)
  })

  it('已丢失的手改蒙版阻止提交，并提供重试而不是继续按无蒙版生成', async () => {
    const source = await original('left')
    source.image.sourceMatte = {
      ...(source.image.sourceMatte as Extract<SourceMatte, { status: 'ready' }>),
      edited: true,
    }
    const host = memoryHost([source.image])
    const mattes = createSourceMattes(host)
    await deleteImage(source.alphaImageId)

    await expect(
      mattes.prepare(source.ref, {
        dataUrl: source.dataUrl,
        productBox: null,
        side: 'background',
      }),
    ).rejects.toThrow('本地蒙版数据已丢失')
    expect(
      matteGate({
        matte: host.read(source.ref)?.sourceMatte,
        matting: false,
        maskSupported: true,
        modelKnown: true,
      }),
    ).toMatchObject({ retry: true, edit: false })
  })

  it('打开已丢失的蒙版也能退出伪就绪状态，让用户重新抠图', async () => {
    const source = await original('left')
    const host = memoryHost([source.image])
    const mattes = createSourceMattes(host)
    await deleteImage(source.alphaImageId)

    await expect(mattes.edit(source.ref)).rejects.toThrow('本地蒙版数据已丢失')
    expect(host.read(source.ref)?.sourceMatte).toMatchObject({
      status: 'failed',
      reason: 'missing',
    })
  })

  it('手改目标图丢失时拒绝准备，不能把遮罩配到另一张原图', async () => {
    const source = await original('left')
    const mattes = createSourceMattes(memoryHost([source.image]))
    const editor = await mattes.edit(source.ref)
    await editor!.onSave({ maskDataUrl: source.dataUrl, targetImageId: 'missing-resized-target' })
    await expect(
      mattes.prepare(source.ref, {
        dataUrl: source.dataUrl,
        productBox: null,
        side: 'background',
      }),
    ).rejects.toThrow()
  })
})
