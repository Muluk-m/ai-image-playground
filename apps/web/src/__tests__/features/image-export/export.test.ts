import { describe, expect, it, vi } from 'vitest'
import { exportSize, prepareExports } from '../../../features/image-export/export'

const encode = vi.fn(async (_canvas, type: string) => ({
  blob: new Blob(['encoded'], { type }),
  type,
}))
const releaseCanvas = { width: 0, height: 0 }
const draw = vi.fn()
vi.mock('../../../features/toolbox/lib/encode', () => ({
  encodeCanvas: (canvas: HTMLCanvasElement, type: string) => encode(canvas, type),
}))
vi.mock('../../../features/toolbox/lib/render', () => ({
  createOutputCanvas: (width: number, height: number) => {
    releaseCanvas.width = width
    releaseCanvas.height = height
    return { canvas: releaseCanvas, ctx: { drawImage: draw } }
  },
}))

describe('image export dimensions', () => {
  it('preserves portrait, landscape and square ratios in a mixed width batch', () => {
    expect(exportSize(1440, 1080, 'width', 720, 1)).toEqual({ width: 720, height: 540 })
    expect(exportSize(1080, 1440, 'width', 720, 2)).toEqual({ width: 1440, height: 1920 })
    expect(exportSize(1024, 1024, 'width', 720, 1)).toEqual({ width: 720, height: 720 })
  })
  it('supports linked height, percent and fractional density without zero pixels', () => {
    expect(exportSize(4000, 3000, 'height', 750, 3)).toEqual({ width: 3000, height: 2250 })
    expect(exportSize(1920, 1080, 'percent', 50, 2)).toEqual({ width: 1920, height: 1080 })
    expect(exportSize(1, 1, 'original', 100, 0.5)).toEqual({ width: 1, height: 1 })
  })
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid size %s', (value) => {
    expect(() => exportSize(1440, 1080, 'width', value, 1)).toThrow()
  })
})
describe('export pipeline', () => {
  it('decodes once, renders each density from the original and releases resources', async () => {
    const close = vi.fn()
    const bitmap = { width: 1440, height: 1080, close }
    const decode = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', decode)
    const files = await prepareExports(
      [{ id: 'one', name: 'photo.jpg', media: 'image', load: async () => new Blob(['original']) }],
      {
        mode: 'width',
        value: 720,
        quality: 92,
        rows: [
          { id: 'a', scale: 1, format: 'image/png' },
          { id: 'b', scale: 2, format: 'image/jpeg' },
        ],
      },
      new AbortController().signal,
      vi.fn(),
    )
    expect(files.map((file) => file.name)).toEqual(['photo.png', 'photo@2x.jpg'])
    expect(decode).toHaveBeenCalledTimes(1)
    expect(draw).toHaveBeenNthCalledWith(1, bitmap, 0, 0, 720, 540)
    expect(draw).toHaveBeenNthCalledWith(2, bitmap, 0, 0, 1440, 1080)
    expect(close).toHaveBeenCalledOnce()
    expect(releaseCanvas.width).toBe(0)
    vi.unstubAllGlobals()
  })
  it('cancels an in-flight source request when the export is closed', async () => {
    const controller = new AbortController()
    const load = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<Blob>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const pending = prepareExports(
      [{ id: 'video', name: 'video', media: 'video', load }],
      { mode: 'original', value: 100, quality: 92, rows: [] },
      controller.signal,
      vi.fn(),
    )
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(load).toHaveBeenCalledWith(controller.signal)
  })
  it('stops before loading if cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const load = vi.fn()
    await expect(
      prepareExports(
        [{ id: 'one', name: 'video', media: 'video', load }],
        { mode: 'original', value: 100, quality: 92, rows: [] },
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toThrow()
    expect(load).not.toHaveBeenCalled()
  })
})
