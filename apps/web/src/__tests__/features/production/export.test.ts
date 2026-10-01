import type { ProductionDocument } from '@image-playground/shared'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import {
  buildProductionZip,
  freezeProductionExport,
  inspectProductionExport,
  PRODUCTION_EXPORT_MAX_BYTES,
} from '../../../features/production/lib/productionExport'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
vi.mock('../../../lib/db', () => ({
  getImage: async () => undefined,
  getCachedMedia: async () => undefined,
}))
afterEach(() => request.mockReset())
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgYQAAAAASUVORK5CYII=',
    'base64',
  ),
)
const doc: ProductionDocument = {
  id: 'doc',
  conversationId: 'conv',
  projectId: null,
  revision: 4,
  updatedAt: 10,
  content: {
    title: '../雨夜',
    setting: '雨夜车站',
    outline: '一封信',
    scenes: [{ id: 'scene', title: '车站', body: '她打开信封。' }],
    characters: [
      {
        id: 'hero',
        name: '../同名',
        description: '邮递员',
        looks: [
          {
            id: 'look',
            name: '雨衣',
            description: '黄色',
            reference: { kind: 'media', mediaId: 'image-one' },
          },
        ],
      },
    ],
    locations: [
      {
        id: 'station',
        name: '../同名',
        description: '车站',
        reference: { kind: 'asset', imageId: 'image-two' },
      },
    ],
    shots: [{ id: 's1', description: '=恶意公式', lookIds: ['look'], locationId: 'station' }],
    clips: [],
  },
}
function fixtures(missing = false) {
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/inspect')) {
      const body = JSON.parse(String(init?.body))
      return Response.json({
        items: body.references.map((reference: unknown, index: number) => ({
          reference,
          status: missing && index === 1 ? 'missing' : 'available',
          bytes: missing && index === 1 ? null : png.length,
          mime: 'image/png',
        })),
      })
    }
    return new Response(png, {
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    })
  })
}
it('freezes the revision, exports real bytes and safe unique paths with traceable UTF-8 documents', async () => {
  fixtures()
  const changed = structuredClone(doc)
  const snapshot = freezeProductionExport(changed)
  Object.assign(changed.content, { title: 'Later revision' })
  const inspected = await inspectProductionExport(snapshot, new AbortController().signal)
  const result = await buildProductionZip(inspected, {
    signal: new AbortController().signal,
    allowPartial: false,
  })
  const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
  const manifest = JSON.parse(strFromU8(entries['manifest.json']!))
  expect(manifest.schemaVersion).toBe(1)
  expect(manifest.revision).toBe(4)
  expect(manifest.content.title).toBe('../雨夜')
  expect(manifest.resources).toHaveLength(2)
  for (const resource of manifest.resources) {
    expect(resource.path).not.toContain('..')
    expect(entries[resource.path]).toEqual(png)
  }
  expect(new Set(manifest.resources.map((one: { path: string }) => one.path)).size).toBe(2)
  expect(strFromU8(entries['script.md']!)).toContain('她打开信封。')
  expect(strFromU8(entries['storyboard.csv']!)).toContain("'=恶意公式")
  expect(strFromU8(entries['manifest.json']!)).not.toContain('test.local')
  expect(result.missing).toHaveLength(0)
})
it('requires explicit partial export and lists missing originals without placeholder files', async () => {
  fixtures(true)
  const plan = await inspectProductionExport(
    freezeProductionExport(doc),
    new AbortController().signal,
  )
  await expect(
    buildProductionZip(plan, { signal: new AbortController().signal, allowPartial: false }),
  ).rejects.toThrow('production_export_missing')
  const result = await buildProductionZip(plan, {
    signal: new AbortController().signal,
    allowPartial: true,
  })
  const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
  expect(result.missing).toHaveLength(1)
  expect(JSON.parse(strFromU8(entries['manifest.json']!)).complete).toBe(false)
  expect(strFromU8(entries['missing.json']!)).toContain('image-two')
  expect(Object.keys(entries).filter((name) => name.endsWith('.png'))).toHaveLength(1)
})
it('blocks unknown or oversized originals before download and aborts without returning a partial archive', async () => {
  fixtures()
  const plan = await inspectProductionExport(
    freezeProductionExport(doc),
    new AbortController().signal,
  )
  const oversized = {
    ...plan,
    items: plan.items.map((one) => ({ ...one, bytes: PRODUCTION_EXPORT_MAX_BYTES + 1 })),
  }
  await expect(
    buildProductionZip(oversized, { signal: new AbortController().signal, allowPartial: false }),
  ).rejects.toThrow('production_export_too_large')
  const unknown = { ...plan, items: plan.items.map((one) => ({ ...one, bytes: null })) }
  await expect(
    buildProductionZip(unknown, { signal: new AbortController().signal, allowPartial: false }),
  ).rejects.toThrow('production_export_unknown_size')
  const controller = new AbortController()
  controller.abort()
  await expect(
    buildProductionZip(plan, { signal: controller.signal, allowPartial: false }),
  ).rejects.toThrow()
  expect(request.mock.calls.filter(([url]) => !String(url).endsWith('/inspect'))).toHaveLength(0)
})

it('never reads originals after permission denial and cancels between files without a download result', async () => {
  request.mockResolvedValue(new Response(null, { status: 403 }))
  await expect(
    inspectProductionExport(freezeProductionExport(doc), new AbortController().signal),
  ).rejects.toThrow('production_export_inspect_failed')
  expect(request).toHaveBeenCalledTimes(1)
  request.mockReset()
  fixtures()
  const plan = await inspectProductionExport(
    freezeProductionExport(doc),
    new AbortController().signal,
  )
  const abort = new AbortController()
  await expect(
    buildProductionZip(plan, {
      signal: abort.signal,
      allowPartial: true,
      onProgress: () => abort.abort(),
    }),
  ).rejects.toThrow()
  expect(request.mock.calls.filter(([url]) => String(url).includes('/reference?'))).toHaveLength(1)
})
it('reports corrupt media as missing and never writes empty or mislabeled image entries', async () => {
  fixtures()
  const plan = await inspectProductionExport(
    freezeProductionExport(doc),
    new AbortController().signal,
  )
  request.mockImplementation(
    async () =>
      new Response(new Uint8Array(png.length), { headers: { 'content-type': 'image/png' } }),
  )
  const result = await buildProductionZip(plan, {
    signal: new AbortController().signal,
    allowPartial: true,
  })
  const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
  expect(result.missing).toHaveLength(2)
  expect(result.missing.every((one) => one.reason === 'corrupt')).toBe(true)
  expect(Object.keys(entries).filter((path) => path.startsWith('images/'))).toHaveLength(0)
})
