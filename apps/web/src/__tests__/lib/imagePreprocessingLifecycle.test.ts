// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { preprocessImageFile } from '../../lib/imagePreprocessing'
import { IMAGE_PREPROCESSING } from '../../lib/imagePreprocessing/policy'

const image = {
  data: new Uint8Array([1, 2, 3]).buffer,
  contentType: 'image/png',
  width: 1,
  height: 1,
  originalBytes: 3,
}
function reader() {
  vi.stubGlobal(
    'FileReader',
    class {
      result = new ArrayBuffer(1)
      onload?: () => void
      readAsArrayBuffer() {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
}
function workers() {
  reader()
  const instances: { onmessage?: (event: unknown) => void; terminate: ReturnType<typeof vi.fn> }[] =
    []
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: unknown) => void
      terminate = vi.fn()
      postMessage() {}
      constructor() {
        instances.push(this)
      }
    },
  )
  return instances
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('decodes one file at a time and cancels removed work before processing the next file', async () => {
  const instances = workers()
  const control = new AbortController()
  const first = preprocessImageFile(new File(['one'], 'one.png'), undefined, control.signal)
  const rejection = expect(first).rejects.toThrow('removed')
  const second = preprocessImageFile(new File(['two'], 'two.png'))
  await vi.waitFor(() => expect(instances).toHaveLength(1))
  control.abort(new Error('removed'))
  await rejection
  await vi.waitFor(() => expect(instances).toHaveLength(2))
  expect(instances[0]!.terminate).toHaveBeenCalledOnce()
  instances[1]!.onmessage?.({ data: { image } })
  expect(await second).toEqual(image)
  expect(instances[1]!.terminate).toHaveBeenCalledOnce()
})
it('terminates a hung worker on timeout and frees the processing queue', async () => {
  vi.useFakeTimers()
  const instances = workers()
  const first = preprocessImageFile(new File(['one'], 'one.png'))
  const rejection = expect(first).rejects.toThrow('attachment_compression_timeout')
  await vi.advanceTimersByTimeAsync(IMAGE_PREPROCESSING.timeoutMs + 1)
  await rejection
  expect(instances[0]!.terminate).toHaveBeenCalledOnce()
  const second = preprocessImageFile(new File(['two'], 'two.png'))
  await vi.advanceTimersByTimeAsync(1)
  instances[1]!.onmessage?.({ data: { image } })
  expect(await second).toEqual(image)
})
it('applies the same timeout and cancels the image source in the main-thread fallback', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', undefined)
  vi.stubGlobal('OffscreenCanvas', undefined)
  const bytes = new Uint8Array(57)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, 1)
  view.setUint32(20, 1)
  bytes.set([73, 68, 65, 84], 37)
  bytes.set([73, 69, 78, 68], 49)
  vi.stubGlobal(
    'FileReader',
    class {
      result = bytes.buffer
      onload?: () => void
      readAsArrayBuffer() {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:prepared', revokeObjectURL: revoke })
  const pictures: { src: string }[] = []
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      constructor() {
        pictures.push(this)
      }
      decode() {
        return new Promise(() => {})
      }
    },
  )
  const first = preprocessImageFile(new File(['one'], 'one.png'))
  const rejected = expect(first).rejects.toThrow('attachment_compression_timeout')
  await vi.advanceTimersByTimeAsync(IMAGE_PREPROCESSING.timeoutMs + 1)
  await rejected
  expect(pictures[0]!.src).toBe('')
  expect(revoke).toHaveBeenCalled()
})
