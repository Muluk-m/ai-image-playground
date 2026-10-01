// @vitest-environment jsdom

import type { ProductionDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionAssetPane from '../../../features/production/components/ProductionAssetPane'

vi.mock('../../../features/production/components/ProductionAssetGenerations', () => ({
  default: () => null,
}))
const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  request.mockReset()
  localStorage.clear()
})
const doc: ProductionDocument = {
  id: 'production',
  conversationId: 'conversation',
  projectId: null,
  revision: 1,
  updatedAt: 1,
  content: {
    title: '雨夜来信',
    setting: '',
    outline: '',
    scenes: [],
    characters: [
      {
        id: 'hero',
        name: '林遥',
        description: '邮递员',
        looks: [{ id: 'raincoat', name: '雨衣', description: '黄色雨衣' }],
      },
    ],
  },
}
it('edits a character look without replacing the character or look identity', async () => {
  let mutation: { content: ProductionDocument['content']; baseRevision: number } | undefined
  request.mockImplementation(async (_url: string, init: RequestInit) => {
    mutation = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        document: { ...doc, revision: 2, content: mutation!.content },
        history: [],
      }),
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionAssetPane
          document={doc}
          target={{ kind: 'character', id: 'hero' }}
          onSaved={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    const input = host.querySelector<HTMLInputElement>('input[aria-label="造型名称"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '便装')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '保存')!.click(),
    )
    expect(mutation?.baseRevision).toBe(1)
    expect(mutation?.content.characters?.[0]).toMatchObject({
      id: 'hero',
      name: '林遥',
      looks: [{ id: 'raincoat', name: '便装', description: '黄色雨衣' }],
    })
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('adds another look under the same character and saves it after a separate edit', async () => {
  let mutation: { content: ProductionDocument['content'] } | undefined
  request.mockImplementation(async (_url: string, init: RequestInit) => {
    mutation = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        document: { ...doc, revision: 2, content: mutation!.content },
        history: [],
      }),
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionAssetPane
          document={doc}
          target={{ kind: 'character', id: 'hero' }}
          onSaved={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    await act(async () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '添加造型')!.click(),
    )
    await act(async () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '保存')!.click(),
    )
    expect(mutation?.content.characters).toHaveLength(1)
    expect(mutation?.content.characters?.[0]?.looks).toHaveLength(2)
    expect(mutation?.content.characters?.[0]?.looks[0]?.id).toBe('raincoat')
    expect(mutation?.content.characters?.[0]?.looks[1]?.id).not.toBe('raincoat')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('requires an explicit deletion review and removes the stable character only on confirmation', async () => {
  let mutation: { content: ProductionDocument['content'] } | undefined
  request.mockImplementation(async (_url: string, init: RequestInit) => {
    mutation = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        document: { ...doc, revision: 2, content: mutation!.content },
        history: [],
      }),
    )
  })
  const close = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionAssetPane
          document={doc}
          target={{ kind: 'character', id: 'hero' }}
          onSaved={() => {}}
          onClose={close}
        />,
      ),
    )
    await act(async () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '删除')!.click(),
    )
    expect(request).not.toHaveBeenCalled()
    expect(host.querySelector('.production-delete-impact')).not.toBeNull()
    await act(async () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '确认删除')!.click(),
    )
    expect(mutation?.content.characters).toEqual([])
    expect(close).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('uploads a user reference through signed media admission and persists only its stable identity', async () => {
  const { webcrypto } = await import('node:crypto')
  const originalSubtle = crypto.subtle
  Object.defineProperty(crypto, 'subtle', { value: webcrypto.subtle, configurable: true })
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = vi.fn(() => 'blob:reference-test')
  URL.revokeObjectURL = vi.fn()
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([png], 'reference.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => png.buffer })
  let mutation: { content: ProductionDocument['content'] } | undefined
  const signed = vi.fn(async () => new Response('', { status: 200 }))
  vi.stubGlobal('fetch', signed)
  request.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/media/uploads'))
      return new Response(
        JSON.stringify({
          id: 'media-owned',
          status: 'pending',
          uploadUrl: 'https://uploads.example/reference',
        }),
      )
    if (url.endsWith('/media-owned/complete'))
      return new Response(JSON.stringify({ id: 'media-owned', status: 'ready' }))
    mutation = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        document: { ...doc, revision: 2, content: mutation!.content },
        history: [],
      }),
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionAssetPane
          document={doc}
          target={{ kind: 'character', id: 'hero' }}
          onSaved={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() =>
        expect(
          request.mock.calls.some(([url]) => String(url).endsWith('/media-owned/complete')),
        ).toBe(true),
      )
    })
    expect(signed).toHaveBeenCalledWith(
      'https://uploads.example/reference',
      expect.objectContaining({ method: 'PUT', credentials: 'omit' }),
    )
    await act(async () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '保存')!.click(),
    )
    expect(mutation?.content.characters?.[0]?.looks[0]?.reference).toEqual({
      kind: 'media',
      mediaId: 'media-owned',
    })
    expect(JSON.stringify(mutation)).not.toContain('blob:')
    expect(JSON.stringify(mutation)).not.toContain('uploads.example')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    Object.defineProperty(crypto, 'subtle', { value: originalSubtle, configurable: true })
  }
})
