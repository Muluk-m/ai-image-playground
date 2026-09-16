import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  exportStorage,
  importEntry,
  pack,
  type StorageEntry,
  unpack,
} from '../../lib/localCompatibility/storage'

function storage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v)
    },
    removeItem: (k) => {
      data.delete(k)
    },
    clear: () => data.clear(),
  }
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  vi.stubGlobal('localStorage', storage())
})
afterEach(() => vi.unstubAllGlobals())
const database: StorageEntry = {
  kind: 'database',
  name: 'image-playground:user-owner',
  version: 11,
  stores: [{ name: 'images', keyPath: 'id', autoIncrement: false, indexes: [] }],
}
it('roundtrips binary images and structured values without collisions with user object fields', async () => {
  const original = {
    id: 'image',
    blob: new Blob(['pixels'], { type: 'image/png' }),
    file: new File(['draft pixels'], 'reference.png', { type: 'image/png', lastModified: 12345 }),
    date: new Date('2026-09-16'),
    type: 'blob',
    map: new Map([['id', 3]]),
    bytes: new Uint8Array([0, 255]),
    absent: undefined,
  }
  const decoded = unpack(JSON.parse(JSON.stringify(await pack(original)))) as typeof original
  expect(await decoded.blob.text()).toBe('pixels')
  expect(decoded.blob.type).toBe('image/png')
  expect(decoded.file.name).toBe('reference.png')
  expect(decoded.file.lastModified).toBe(12345)
  expect(await decoded.file.text()).toBe('draft pixels')
  expect(decoded.date).toEqual(original.date)
  expect(decoded.map).toEqual(original.map)
  expect(decoded.bytes).toEqual(original.bytes)
  expect(decoded.type).toBe('blob')
  expect('absent' in decoded).toBe(true)
})
it('exports all app scopes, preserves destination collisions and can repeat an interrupted import', async () => {
  localStorage.setItem('image-playground:user-owner', 'legacy settings')
  localStorage.setItem('unrelated', 'do not move')
  await importEntry(database)
  const row: StorageEntry = {
    kind: 'record',
    database: database.name,
    store: 'images',
    key: await pack('image'),
    value: await pack({ id: 'image', bytes: new Blob(['original']) }),
  }
  await importEntry(row)
  const entries: StorageEntry[] = []
  for await (const e of exportStorage()) entries.push(e)
  expect(entries.some((e) => e.kind === 'local' && e.key === 'unrelated')).toBe(false)
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('localStorage', storage())
  localStorage.setItem('image-playground:user-owner', 'new settings')
  for (const e of entries) await importEntry(e)
  for (const e of entries) await importEntry(e)
  expect(localStorage.getItem('image-playground:user-owner')).toBe('new settings')
  const again: StorageEntry[] = []
  for await (const e of exportStorage()) again.push(e)
  const rows = again.filter(
    (e): e is Extract<StorageEntry, { kind: 'record' }> => e.kind === 'record',
  )
  expect(rows).toHaveLength(1)
  expect(await (unpack(rows[0]!.value) as { bytes: Blob }).bytes.text()).toBe('original')
})
it('does not import foreign storage or database namespaces', async () => {
  await expect(importEntry({ kind: 'local', key: 'another-app', value: 'x' })).rejects.toThrow()
  await expect(importEntry({ ...database, name: 'another-app' })).rejects.toThrow()
})

it.each([
  ['image-playground-canvas', 'scene'],
  ['image-playground-agent-drafts', 'drafts'],
])('preserves the fixed v1 schema of %s without duplicate retry backups', async (databaseName, storeName) => {
  const meta: StorageEntry = {
    kind: 'database',
    name: databaseName,
    version: 1,
    stores: [{ name: storeName, keyPath: null, autoIncrement: false, indexes: [] }],
  }
  await importEntry(meta)
  const row: StorageEntry = {
    kind: 'record',
    database: meta.name,
    store: storeName,
    key: await pack('scene'),
    value: await pack({ version: 2, elements: [{ id: 'legacy' }], files: {} }),
  }
  await importEntry(row)
  await importEntry(row)
  const opened = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(databaseName, 1)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  expect(opened.version).toBe(1)
  opened.close()
  expect((await indexedDB.databases()).some((d) => d.name === 'muvloom-legacy-backup')).toBe(false)
})

it('preserves destination edits and recovers a conflicting drawing as a separate local project', async () => {
  const meta: StorageEntry = {
    kind: 'database',
    name: 'image-playground-canvas',
    version: 1,
    stores: [{ name: 'scene', keyPath: null, autoIncrement: false, indexes: [] }],
  }
  await importEntry(meta)
  await importEntry({
    kind: 'record',
    database: meta.name,
    store: 'scene',
    key: await pack('canvas-project:user-owner:project:one'),
    value: await pack({
      id: 'one',
      name: 'Current project',
      sceneKey: 'canvas:user-owner:project:one',
    }),
  })
  const key = await pack('canvas:user-owner:project:one')
  await importEntry({
    kind: 'record',
    database: meta.name,
    store: 'scene',
    key,
    value: await pack({
      version: 2,
      elements: [{ id: 'text', type: 'text', text: 'new edit' }],
      files: {},
      camera: { x: 0, y: 0, zoom: 1 },
    }),
  })
  await importEntry({
    kind: 'record',
    database: meta.name,
    store: 'scene',
    key,
    value: await pack({
      version: 2,
      elements: [
        { id: 'text', type: 'text', text: 'old text' },
        { id: 'photo', type: 'image', fileId: 'pixels' },
      ],
      files: { pixels: 'data:image/png;base64,b2xk' },
      camera: { x: 1, y: 1, zoom: 2 },
    }),
  })
  const rows: StorageEntry[] = []
  for await (const entry of exportStorage()) rows.push(entry)
  const row = rows.find(
    (e) => e.kind === 'record' && JSON.stringify(e.key) === JSON.stringify(key),
  )!
  if (row.kind !== 'record') throw new Error('Missing scene')
  const scene = unpack(row.value) as { elements: unknown[]; files: Record<string, string> }
  expect(scene.elements).toEqual([{ id: 'text', type: 'text', text: 'new edit' }])
  const recovered = rows
    .filter((e) => e.kind === 'record')
    .map((e) => unpack((e as Extract<StorageEntry, { kind: 'record' }>).value)) as Record<
    string,
    any
  >[]
  const copy = recovered.find(
    (v) => v.version === 2 && v.elements.some((e: { id: string }) => e.id === 'photo'),
  )!
  expect(copy.elements.map((e: { id: string }) => e.id)).toEqual(['text', 'photo'])
  expect(copy.files.pixels).toBe('data:image/png;base64,b2xk')
  expect(recovered.some((v) => v.name === '旧站画布' && !v.cloud)).toBe(true)
})

it('streams original unpartitioned canvas and native images locally, retaining source data', async () => {
  const { serveStorage } = await import('../../lib/localCompatibility/bridge')
  await importEntry(database)
  await importEntry({
    kind: 'record',
    database: database.name,
    store: 'images',
    key: await pack('original'),
    value: await pack({
      id: 'original',
      file: new File(['pixels'], 'photo.png', { type: 'image/png', lastModified: 12 }),
    }),
  })
  const source = { indexedDB, localStorage }
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('localStorage', storage())
  const fetcher = vi.fn(() => {
    throw new Error('Data must not use the network')
  })
  vi.stubGlobal('fetch', fetcher)
  const channel = new MessageChannel()
  const received = new Promise<void>((resolve, reject) => {
    channel.port1.onmessage = async (event) => {
      try {
        if (event.data.done) {
          channel.port1.close()
          resolve()
          return
        }
        await importEntry(event.data.entry)
        channel.port1.postMessage('ack')
      } catch (e) {
        channel.port1.close()
        reject(e)
      }
    }
  })
  await Promise.all([serveStorage(channel.port2, source), received])
  const targetRows: StorageEntry[] = []
  for await (const entry of exportStorage()) targetRows.push(entry)
  const row = targetRows.find((e) => e.kind === 'record')!
  if (row.kind !== 'record') throw new Error('Missing image')
  const data = unpack(row.value) as { file: File }
  expect(data.file.name).toBe('photo.png')
  expect(data.file.lastModified).toBe(12)
  expect(await data.file.text()).toBe('pixels')
  const sourceRows: StorageEntry[] = []
  for await (const entry of exportStorage(source)) sourceRows.push(entry)
  expect(sourceRows.filter((e) => e.kind === 'record')).toHaveLength(1)
  expect(fetcher).not.toHaveBeenCalled()
})

it('never requests storage permission when silent access is unavailable', async () => {
  const { originalStorage } = await import('../../lib/localCompatibility/bridge')
  const requestStorageAccess = vi.fn()
  const result = await originalStorage({
    hasStorageAccess: async () => false,
    requestStorageAccess,
  } as unknown as Parameters<typeof originalStorage>[0])
  expect(result).toBeNull()
  expect(requestStorageAccess).not.toHaveBeenCalled()
})
