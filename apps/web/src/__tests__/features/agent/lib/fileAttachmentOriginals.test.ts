// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { filesToReferences } from '../../../../features/agent/lib/attachments'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { loadRuntimeConfig } from '../../../../lib/runtimeConfig'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

it('keeps a large supported original instead of reducing it for inline transport', async () => {
  setClientStorageScope('file-original-test')
  vi.stubGlobal('fetch', async () => Response.json({ 'agent:attachments': true }))
  await loadRuntimeConfig(async () => Response.json({ bff: { enabled: true, baseUrl: '' } }))
  await bootstrapClientCapabilities(true, '')
  class LoadedImage {
    naturalWidth = 4096
    naturalHeight = 4096
    onload: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', LoadedImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/')
  const bytes = new Uint8Array(300_000)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const [reference] = await filesToReferences([
    new File([bytes], 'original.png', { type: 'image/png' }),
  ])
  const expected = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
  expect(reference?.dataUrl.length).toBe(expected.length)
  expect(reference?.dataUrl === expected).toBe(true)
})

it('rejects the entire selected group when one file cannot be read', async () => {
  class FileReaderFixture {
    result = 'data:image/png;base64,iVBORw0KGgoAAAAAAAAA'
    error = new Error('unreadable')
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(file: File) {
      queueMicrotask(() => (file.name === 'bad.png' ? this.onerror?.() : this.onload?.()))
    }
  }
  vi.stubGlobal('FileReader', FileReaderFixture)
  await expect(
    filesToReferences([new File([], 'good.png'), new File([], 'bad.png')]),
  ).rejects.toThrow('unreadable')
})
