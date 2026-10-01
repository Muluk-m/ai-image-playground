// @vitest-environment jsdom
import type { ProductionDocument } from '@image-playground/shared'
import { strFromU8, unzipSync } from 'fflate'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionExportPane from '../../../features/production/components/ProductionExportPane'

const mocks = vi.hoisted(() => ({ request: vi.fn(), download: vi.fn() }))
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: mocks.request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
vi.mock('../../../lib/downloadImages', () => ({ downloadBlob: mocks.download }))
vi.mock('../../../lib/db', () => ({
  getImage: async () => undefined,
  getCachedMedia: async () => undefined,
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  mocks.request.mockReset()
  mocks.download.mockReset()
  localStorage.clear()
})
const doc: ProductionDocument = {
  id: 'doc',
  conversationId: 'conv',
  projectId: null,
  revision: 2,
  updatedAt: 1,
  content: {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [],
    locations: [
      {
        id: 'station',
        name: '车站',
        description: '远景',
        reference: { kind: 'media', mediaId: 'original' },
      },
    ],
  },
}
it('requires explicit partial export for expired media and writes a truthful downloadable archive', async () => {
  mocks.request.mockImplementation(async (url: string) =>
    url.endsWith('/generations')
      ? Response.json({ generations: [] })
      : Response.json({
          items: [
            {
              reference: { kind: 'media', mediaId: 'original' },
              bytes: null,
              mime: null,
              status: 'missing',
            },
          ],
        }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProductionExportPane document={doc} onClose={() => {}} />))
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((one) => one.textContent === '检查原件与大小')!
        .click(),
    )
    expect(
      [...host.querySelectorAll('button')].find((one) => one.textContent === '下载 ZIP 资源包')!
        .disabled,
    ).toBe(true)
    expect(mocks.download).not.toHaveBeenCalled()
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((one) => one.textContent?.startsWith('仍导出可用资源'))!
        .click(),
    )
    const blob = mocks.download.mock.calls[0]![0] as Blob
    const entries = unzipSync(
      new Uint8Array(
        await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as ArrayBuffer)
          reader.onerror = () => reject(reader.error)
          reader.readAsArrayBuffer(blob)
        }),
      ),
    )
    expect(JSON.parse(strFromU8(entries['manifest.json']!)).complete).toBe(false)
    expect(entries['missing.json']).toBeDefined()
    expect(host.textContent).toContain('部分资源包已发起下载')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
it('keeps the inspected revision fixed even when the production document changes before download', async () => {
  const textDoc = { ...doc, content: { ...doc.content, locations: [] } }
  mocks.request.mockResolvedValue(Response.json({ generations: [] }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(<ProductionExportPane document={textDoc} onClose={() => {}} />),
    )
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((one) => one.textContent === '检查原件与大小')!
        .click(),
    )
    await act(async () =>
      root.render(
        <ProductionExportPane
          document={{ ...textDoc, revision: 3, content: { ...textDoc.content, title: '晴天' } }}
          onClose={() => {}}
        />,
      ),
    )
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((one) => one.textContent === '下载 ZIP 资源包')!
        .click(),
    )
    const blob = mocks.download.mock.calls[0]![0] as Blob
    const entries = unzipSync(
      new Uint8Array(
        await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as ArrayBuffer)
          reader.onerror = () => reject(reader.error)
          reader.readAsArrayBuffer(blob)
        }),
      ),
    )
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!))
    expect(manifest.revision).toBe(2)
    expect(manifest.content.title).toBe('雨夜')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('freezes authoritative inspection metadata while candidate listing is pending and clears a failed recheck', async () => {
  let resolveInspection: (response: Response) => void = () => {}
  let failInspection = false
  const mediaDoc: ProductionDocument = {
    ...doc,
    content: {
      ...doc.content,
      locations: [
        {
          id: 'station',
          name: '车站',
          description: '远景',
          reference: { kind: 'artifact', artifactId: 'artifact' },
        },
      ],
    },
  }
  mocks.request.mockImplementation(async (url: string) => {
    if (url.endsWith('/generations')) return new Promise<Response>(() => {})
    return failInspection
      ? new Response(null, { status: 503 })
      : new Promise<Response>((resolve) => {
          resolveInspection = resolve
        })
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const inspect = () =>
    [...host.querySelectorAll('button')].find((one) =>
      ['检查原件与大小', '重新检查原件'].includes(one.textContent ?? ''),
    )!
  try {
    await act(async () =>
      root.render(<ProductionExportPane document={mediaDoc} onClose={() => {}} />),
    )
    await act(async () => inspect().click())
    expect(host.textContent).toContain('正在检查原件')
    expect(mocks.download).not.toHaveBeenCalled()
    await act(async () =>
      resolveInspection(
        Response.json({
          items: [
            {
              reference: { kind: 'artifact', artifactId: 'artifact' },
              bytes: null,
              mime: null,
              status: 'missing',
              generation: {
                source: 'production',
                draftId: 'draft',
                draftRevision: 2,
                production: {
                  documentId: 'doc',
                  revision: 2,
                  target: 'location',
                  targetId: 'station',
                  snapshot: { name: '车站', description: '远景', references: [] },
                },
                model: 'actual-image-model',
                prompt: '实际提交',
                params: { quality: 'high' },
                references: [],
                taskId: 'task',
              },
            },
          ],
        }),
      ),
    )
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((one) => one.textContent?.startsWith('仍导出可用资源'))!
        .click(),
    )
    const blob = mocks.download.mock.calls[0]![0] as Blob
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
    expect(
      JSON.parse(strFromU8(unzipSync(new Uint8Array(buffer))['manifest.json']!)).generations[0],
    ).toMatchObject({
      reference: { kind: 'artifact', artifactId: 'artifact' },
      model: 'actual-image-model',
      params: { quality: 'high' },
    })
    failInspection = true
    await act(async () => inspect().click())
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(
      [...host.querySelectorAll('button')].find((one) => one.textContent === '下载 ZIP 资源包'),
    ).toBeUndefined()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
