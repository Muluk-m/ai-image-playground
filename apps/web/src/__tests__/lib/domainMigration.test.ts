import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  exportStorage,
  importEntry,
  pack,
  type StorageEntry,
  unpack,
} from '../../lib/domainMigration/storage'

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
    date: new Date('2026-09-16'),
    type: 'blob',
    map: new Map([['id', 3]]),
    bytes: new Uint8Array([0, 255]),
    absent: undefined,
  }
  const decoded = unpack(JSON.parse(JSON.stringify(await pack(original)))) as typeof original
  expect(await decoded.blob.text()).toBe('pixels')
  expect(decoded.blob.type).toBe('image/png')
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
