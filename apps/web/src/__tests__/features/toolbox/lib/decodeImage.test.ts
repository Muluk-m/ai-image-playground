// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { decodeToolboxImage } from '../../../../features/toolbox/lib/decodeImage'

const workers: FakeWorker[] = []
class FakeWorker {
  onmessage?: (event: { data: { error: string } }) => void
  onerror?: () => void
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() {
    workers.push(this)
  }
}

afterEach(() => {
  workers.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('a stalled HEIC decode releases its worker and does not block the next photo', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))
  const first = decodeToolboxImage(new File(['heic'], 'first.HEIC'))
  const second = decodeToolboxImage(new File(['heic'], 'second.HEIC'))
  const firstFailure = expect(first).rejects.toThrow('heic_decode_timeout')
  const secondFailure = expect(second).rejects.toThrow('heic_decode_failed')
  await vi.advanceTimersByTimeAsync(0)
  expect(workers).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(45_000)
  await firstFailure
  expect(workers[0]?.terminate).toHaveBeenCalledOnce()
  expect(workers).toHaveLength(2)
  workers[1]?.onerror?.()
  await secondFailure
  expect(workers[1]?.terminate).toHaveBeenCalledOnce()
})

it('normal images keep their original preview without loading a HEIC worker', async () => {
  const bitmap = { width: 320, height: 180, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  vi.stubGlobal('Worker', FakeWorker)
  const file = new File(['png'], 'photo.png', { type: 'image/png' })
  const decoded = await decodeToolboxImage(file)
  expect(decoded.bitmap).toBe(bitmap)
  expect(decoded.preview).toBe(file)
  expect(workers).toHaveLength(0)
})
