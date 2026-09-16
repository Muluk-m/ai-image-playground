// @vitest-environment jsdom

import { Blob, File } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, expect, it, vi } from 'vitest'
import { migrateDomain } from '../../lib/domainMigration/bootstrap'
import {
  exportStorage,
  importEntry,
  pack,
  type StorageEntry,
  unpack,
} from '../../lib/domainMigration/storage'

function storage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v)
    },
    removeItem: (k) => {
      m.delete(k)
    },
    clear: () => m.clear(),
  }
}
afterEach(() => vi.unstubAllGlobals())
it('automatically navigates legacy storage, imports encrypted images and finishes session handoff before app startup', async () => {
  const source = { local: storage(), session: storage(), db: new IDBFactory() }
  const target = { local: storage(), session: storage(), db: new IDBFactory() }
  const config = {
    sourceOrigin: 'https://old.example',
    targetOrigin: 'https://new.example',
    sourceApi: 'https://api.old.example',
    targetApi: 'https://api.new.example',
  }
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('Blob', Blob)
  vi.stubGlobal('File', File)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  let next = '',
    finished = false,
    failRead = true
  function enter(url: string, side: typeof source) {
    const u = new URL(url)
    vi.stubGlobal('location', {
      origin: u.origin,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      reload: () => {
        next = u.href
      },
      replace: (s: string) => {
        next = s
      },
    })
    vi.stubGlobal('localStorage', side.local)
    vi.stubGlobal('sessionStorage', side.session)
    vi.stubGlobal('indexedDB', side.db)
  }
  const ciphertext: string[] = []
  const requestBodies: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const route = url.split('/').pop()
      const body = options?.body ? JSON.parse(String(options.body)) : null
      if (body) requestBodies.push(body)
      if (route === 'config') return Response.json(config)
      if (route === 'start') return Response.json({ id: 'a'.repeat(64), uploadKey: 'b'.repeat(64) })
      if (route === 'upload') {
        ciphertext[body.sequence] = body.ciphertext
        return Response.json({ ok: true })
      }
      if (route === 'seal') return Response.json({ ok: true })
      if (route === 'read' && body.sequence === 1 && failRead) {
        failRead = false
        return Response.json({ error: 'migration_network' }, { status: 503 })
      }
      if (route === 'read')
        return Response.json({ chunks: ciphertext.length, ciphertext: ciphertext[body.sequence] })
      if (route === 'finish') {
        finished = true
        return Response.json({ ok: true })
      }
      throw new Error(`Unexpected route ${route}`)
    }),
  )
  enter(config.sourceOrigin, source)
  source.local.setItem('image-playground:user-owner', 'old settings')
  source.local.setItem('image-playground.large', '画'.repeat(180_000))
  const meta: StorageEntry = {
    kind: 'database',
    name: 'image-playground:user-owner',
    version: 11,
    stores: [{ name: 'images', keyPath: 'id', autoIncrement: false, indexes: [] }],
  }
  await importEntry(meta)
  await importEntry({
    kind: 'record',
    database: meta.name,
    store: 'images',
    key: await pack('image'),
    value: await pack({ id: 'image', blob: new Blob(['private pixels']) }),
  })
  enter(`${config.targetOrigin}/?ref=invite#canvas`, target)
  expect(await migrateDomain(config.targetApi)).toBe(true)
  expect(next.startsWith(`${config.sourceOrigin}/__domain-migration#proof=`)).toBe(true)
  const encryptionSecret = new URLSearchParams(new URL(next).hash.slice(1)).get('proof')!
  enter(next, source)
  expect(await migrateDomain(config.targetApi)).toBe(true)
  expect(next).toBe(`${config.targetOrigin}/__domain-migration#ticket=${'a'.repeat(64)}`)
  expect(ciphertext.join('')).not.toContain('private pixels')
  enter(next, target)
  expect(await migrateDomain(config.targetApi)).toBe(true)
  expect(finished).toBe(false)
  const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === '重试')!
  retry.click()
  expect(next).toContain('/__domain-migration#ticket=')
  enter(next, target)
  expect(await migrateDomain(config.targetApi)).toBe(true)
  expect(next).toBe(`${config.targetOrigin}/?ref=invite#canvas`)
  expect(finished).toBe(true)
  expect(JSON.stringify(requestBodies)).not.toContain(encryptionSecret)
  expect(ciphertext.length).toBeGreaterThan(1)
  expect(target.local.getItem('image-playground.large')).toBe('画'.repeat(180_000))
  expect(target.local.getItem('image-playground:user-owner')).toBe('old settings')
  expect(source.local.getItem('image-playground:user-owner')).toBe('old settings')
  const entries: StorageEntry[] = []
  for await (const e of exportStorage()) entries.push(e)
  const row = entries.find(
    (e): e is Extract<StorageEntry, { kind: 'record' }> => e.kind === 'record',
  )!
  expect(await (unpack(row.value) as { blob: Blob }).blob.text()).toBe('private pixels')
  enter(next, target)
  expect(await migrateDomain(config.targetApi)).toBe(false)
  document.body.replaceChildren()
})

it('blocks app initialization if migration configuration cannot be loaded', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('location', {
    origin: 'https://new.example',
    pathname: '/__domain-migration',
    search: '',
    hash: '#ticket=abc',
    reload: vi.fn(),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    }),
  )
  expect(await migrateDomain('https://api.new.example')).toBe(true)
  expect(document.body.textContent).toContain('请重试')
  document.body.replaceChildren()
})

it('recovers the destination deep link when skipping a failed legacy export', async () => {
  const targetSession = storage()
  targetSession.setItem(
    'muvloom.domain-migration.pending',
    JSON.stringify({
      secret: 'a'.repeat(64),
      returnPath: '/?ref=keep#canvas',
      created: Date.now(),
    }),
  )
  vi.stubGlobal('sessionStorage', targetSession)
  vi.stubGlobal('location', {
    origin: 'https://new.example',
    pathname: '/__domain-migration',
    search: '?__migration_skip=1',
    hash: '',
  })
  const replaceState = vi.fn()
  vi.stubGlobal('history', { replaceState })
  expect(await migrateDomain('https://api.new.example')).toBe(false)
  expect(replaceState).toHaveBeenCalledWith(null, '', '/?ref=keep#canvas')
})
