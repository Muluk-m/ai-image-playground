// @vitest-environment jsdom
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { restoreLocalStorage } from '../../../lib/localCompatibility/bridge'
import {
  exportStorage,
  importEntry,
  pack,
  type StorageEntry,
  unpack,
} from '../../../lib/localCompatibility/storage'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('returns an unresolved visitor to the legacy domain once, then completes the import', async () => {
  const config = { sourceOrigin: 'https://old.example', targetOrigin: location.origin }
  const meta: StorageEntry = {
    kind: 'database',
    name: 'image-playground-canvas',
    version: 1,
    stores: [{ name: 'scene', keyPath: null, autoIncrement: false, indexes: [] }],
  }
  await importEntry(meta)
  const key = await pack('canvas:user-owner:project:one')
  await importEntry({
    kind: 'record',
    database: meta.name,
    store: 'scene',
    key,
    value: await pack({ version: 2, elements: [], files: {}, camera: { x: 0, y: 0, zoom: 1 } }),
  })
  const source: StorageEntry = {
    kind: 'record',
    database: meta.name,
    store: 'scene',
    key,
    value: await pack({
      version: 2,
      elements: [{ id: 'photo', type: 'image', fileId: 'pixels' }],
      files: { pixels: 'data:image/png;base64,b2xk' },
      camera: { x: 1, y: 1, zoom: 2 },
    }),
  }
  // Plays the source origin's half of the bridge: take the port, stream one entry, then finish.
  const migrate = async () => {
    const done = restoreLocalStorage(config)
    const frame = await vi.waitFor(() => {
      const found = document.querySelector('iframe')
      if (!found) throw new Error('no frame yet')
      return found
    })
    const ports: MessagePort[] = []
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((
      _data: unknown,
      _origin: unknown,
      transfer: MessagePort[],
    ) => {
      ports.push(transfer[0]!)
    }) as never)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: 'muvloom-local-storage-v1',
        origin: config.sourceOrigin,
        source: frame.contentWindow,
      }),
    )
    const port = ports[0]!
    port.start()
    const acked = new Promise<void>((resolve) => {
      port.onmessage = () => resolve()
    })
    port.postMessage({ entry: source })
    await acked
    port.postMessage({ done: true })
    return done
  }
  expect(await migrate()).toBe(false)
  expect(await migrate()).toBe(true)
  // The completion marker is written, so later visits skip the import instead of bouncing again.
  expect(await restoreLocalStorage(config)).toBe(true)
  const values: unknown[] = []
  for await (const entry of exportStorage())
    if (entry.kind === 'record') values.push(unpack(entry.value))
  expect(
    values.some((v) => !!v && typeof v === 'object' && 'name' in v && v.name === '旧站画布'),
  ).toBe(true)
})
