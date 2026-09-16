/** Storage transfer runs before App/store imports. Never clear either origin or overwrite target data. */
type Packed = [string, unknown]
export interface StoreSchema {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[]
}
export type StorageEntry =
  | { kind: 'local'; key: string; value: string }
  | { kind: 'database'; name: string; version: number; stores: StoreSchema[] }
  | { kind: 'record'; database: string; store: string; key: Packed; value: Packed }

export function appDatabase(name: string): boolean {
  return (
    name === 'image-playground' ||
    name === 'image-playground-canvas' ||
    /^image-playground:user-[^\s]{1,256}$/.test(name)
  )
}
export function appStorageKey(key: string): boolean {
  return (
    key.startsWith('image-playground') ||
    key.startsWith('aip.') ||
    ['theme', 'canvas-shortcuts-collapsed'].includes(key)
  )
}
export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
export async function pack(value: unknown): Promise<Packed> {
  if (value === undefined) return ['undefined', null]
  if (typeof value === 'bigint') return ['bigint', String(value)]
  if (value instanceof File)
    return [
      'file',
      [
        value.name,
        value.type,
        value.lastModified,
        toBase64(new Uint8Array(await value.arrayBuffer())),
      ],
    ]
  if (value instanceof Blob)
    return ['blob', [value.type, toBase64(new Uint8Array(await value.arrayBuffer()))]]
  if (value instanceof Date) return ['date', value.toISOString()]
  if (value instanceof ArrayBuffer) return ['buffer', toBase64(new Uint8Array(value))]
  if (ArrayBuffer.isView(value))
    return [
      'view',
      [
        value.constructor.name,
        toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      ],
    ]
  if (Array.isArray(value)) return ['array', await Promise.all(value.map(pack))]
  if (value instanceof Map)
    return [
      'map',
      await Promise.all([...value].map(async ([k, v]) => [await pack(k), await pack(v)])),
    ]
  if (value instanceof Set) return ['set', await Promise.all([...value].map(pack))]
  if (value !== null && typeof value === 'object')
    return [
      'object',
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await pack(v)])),
    ]
  if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)]
  return ['value', value]
}
export function unpack([type, value]: Packed): unknown {
  switch (type) {
    case 'undefined':
      return undefined
    case 'bigint':
      return BigInt(value as string)
    case 'number':
      return Number(value)
    case 'date':
      return new Date(value as string)
    case 'buffer':
      return fromBase64(value as string).buffer
    case 'view': {
      const [name, encoded] = value as [string, string]
      const types: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
        Uint8Array,
        Uint8ClampedArray,
        Int8Array,
        Uint16Array,
        Int16Array,
        Uint32Array,
        Int32Array,
        Float32Array,
        Float64Array,
        DataView,
      }
      const Constructor = types[name as keyof typeof types]
      if (!Constructor) throw new Error('Unsupported stored binary type')
      return new Constructor(fromBase64(encoded).buffer)
    }
    case 'blob': {
      const [mime, bytes] = value as string[]
      return new Blob([fromBase64(bytes!)], { type: mime })
    }
    case 'file': {
      const [name, mime, modified, bytes] = value as [string, string, number, string]
      return new File([fromBase64(bytes)], name, { type: mime, lastModified: modified })
    }
    case 'array':
      return (value as Packed[]).map(unpack)
    case 'set':
      return new Set((value as Packed[]).map(unpack))
    case 'map':
      return new Map((value as [Packed, Packed][]).map(([k, v]) => [unpack(k), unpack(v)]))
    case 'object':
      return Object.fromEntries((value as [string, Packed][]).map(([k, v]) => [k, unpack(v)]))
    case 'value':
      return value
    default:
      throw new Error('Unsupported stored value')
  }
}
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed'))
  })
}
function open(name: string, version?: number, stores?: StoreSchema[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version)
    let cancelled = false
    r.onblocked = () => {
      cancelled = true
      reject(new Error('请关闭其他工作台标签页后重试'))
    }
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      if (cancelled) r.result.close()
      else resolve(r.result)
    }
    r.onupgradeneeded = () => {
      if (cancelled) {
        r.transaction?.abort()
        return
      }
      for (const s of stores ?? []) {
        if (r.result.objectStoreNames.contains(s.name)) continue
        const store = r.result.createObjectStore(s.name, {
          keyPath: s.keyPath,
          autoIncrement: s.autoIncrement,
        })
        for (const i of s.indexes)
          store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry })
      }
    }
  })
}
export async function* exportStorage(): AsyncGenerator<StorageEntry> {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && appStorageKey(key)) yield { kind: 'local', key, value: localStorage.getItem(key)! }
  }
  if (typeof indexedDB.databases !== 'function')
    throw new Error('此浏览器无法自动读取旧站数据，请使用原浏览器更新后重试')
  for (const info of await indexedDB.databases()) {
    if (!info.name || !appDatabase(info.name)) continue
    const db = await open(info.name)
    try {
      const stores = [...db.objectStoreNames].map((name) => {
        const s = db.transaction(name, 'readonly').objectStore(name)
        return {
          name,
          keyPath: s.keyPath,
          autoIncrement: s.autoIncrement,
          indexes: [...s.indexNames].map((n) => {
            const i = s.index(n)
            return { name: n, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }
          }),
        }
      })
      yield { kind: 'database', name: db.name, version: db.version, stores }
      for (const store of stores) {
        let after: IDBValidKey | undefined
        while (true) {
          const tx = db.transaction(store.name, 'readonly'),
            s = tx.objectStore(store.name)
          const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
          const [keys, values] = await Promise.all([
            request(s.getAllKeys(range, 1)),
            request(s.getAll(range, 1)),
          ])
          if (!keys.length) break
          for (let i = 0; i < keys.length; i++)
            yield {
              kind: 'record',
              database: db.name,
              store: store.name,
              key: await pack(keys[i]),
              value: await pack(values[i]),
            }
          after = keys[keys.length - 1]
        }
      }
    } finally {
      db.close()
    }
  }
}

async function archiveConflict(entry: StorageEntry): Promise<void> {
  const database = await open('muvloom-legacy-backup', 1, [
    { name: 'conflicts', keyPath: null, autoIncrement: false, indexes: [] },
  ])
  try {
    const tx = database.transaction('conflicts', 'readwrite'),
      store = tx.objectStore('conflicts')
    const done = completed(tx)
    const key =
      entry.kind === 'local'
        ? `local:${entry.key}`
        : JSON.stringify(
            entry.kind === 'record' ? [entry.database, entry.store, entry.key] : entry.name,
          )
    const existing = store.count(key)
    existing.onsuccess = () => {
      if (!existing.result) store.add(entry, key)
    }
    await done
  } finally {
    database.close()
  }
}

function mergeCheckpoint(sourceText: string, targetText: string): string {
  const source = JSON.parse(sourceText),
    target = JSON.parse(targetText)
  const merged = { ...target, version: 0, lastSyncedAt: null }
  for (const key of ['assets', 'templates', 'unsyncedImages', 'imagelessAssets']) {
    merged[key] = [
      ...new Set([
        ...(Array.isArray(target[key]) ? target[key] : []),
        ...(Array.isArray(source[key]) ? source[key] : []),
      ]),
    ]
  }
  return JSON.stringify(merged)
}

export async function importEntry(entry: StorageEntry): Promise<void> {
  if (entry.kind === 'local') {
    if (!appStorageKey(entry.key)) throw new Error('Unknown storage key')
    const current = localStorage.getItem(entry.key)
    if (current === null) localStorage.setItem(entry.key, entry.value)
    else if (current !== entry.value) {
      await archiveConflict(entry)
      if (entry.key === 'image-playground-sync' || entry.key.startsWith('image-playground-sync:')) {
        localStorage.setItem(entry.key, mergeCheckpoint(entry.value, current))
      }
    }
    return
  }
  if (entry.kind === 'database') {
    if (!appDatabase(entry.name)) throw new Error('Unknown database')
    const current = await open(entry.name, undefined, entry.stores)
    const missing = entry.stores.some((s) => !current.objectStoreNames.contains(s.name))
    const version = Math.max(entry.version, current.version + (missing ? 1 : 0))
    current.close()
    const target = await open(entry.name, version, entry.stores)
    target.close()
    return
  }
  if (!appDatabase(entry.database)) throw new Error('Unknown database')
  const db = await open(entry.database)
  try {
    const tx = db.transaction(entry.store, 'readwrite'),
      s = tx.objectStore(entry.store)
    const done = completed(tx),
      key = unpack(entry.key) as IDBValidKey
    let collision = false
    const existingValue = s.get(key)
    const count = s.count(key)
    count.onsuccess = () => {
      try {
        collision = count.result !== 0
        if (count.result === 0) {
          const v = unpack(entry.value)
          if (s.keyPath === null) s.add(v, key)
          else s.add(v)
        }
      } catch {
        tx.abort()
      }
    }
    await done
    if (
      collision &&
      JSON.stringify(await pack(existingValue.result)) !== JSON.stringify(entry.value)
    ) {
      await archiveConflict(entry)
    }
  } finally {
    db.close()
  }
}
