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
