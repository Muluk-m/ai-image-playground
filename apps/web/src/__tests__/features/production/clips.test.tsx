// @vitest-environment jsdom
import type { ProductionDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionClipPane from '../../../features/production/components/ProductionClipPane'

vi.mock('../../../features/production/components/ProductionDependencyNotice', () => ({
  default: () => null,
}))
const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
vi.mock('../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false, estimatedCredits: 25 }),
}))
vi.mock('../../../lib/channels/videoChannels', () => ({
  videoModelOptions: () => [
    {
      modelId: 'grok-imagine-video',
      label: 'Grok',
      support: {
        durations: [5, 8, 10, 15],
        aspectRatios: ['16:9', '9:16', '1:1'],
        resolutions: ['720p', '1080p'],
        firstFrame: true,
      },
    },
  ],
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  request.mockReset()
  localStorage.clear()
})
const doc: ProductionDocument = {
  id: 'doc',
  conversationId: 'conv',
  projectId: null,
  revision: 3,
  updatedAt: 1,
  content: {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [],
    shots: [
      { id: 's1', description: '远景：雨夜车站', lookIds: [] },
      { id: 's2', description: '近景：拆开信封', lookIds: [] },
    ],
    clips: [
      {
        id: 'clip',
        name: '信封',
        shotIds: ['s1', 's2'],
        prompt: '雨中抵达车站，打开信封',
        model: 'grok-imagine-video',
        video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
        references: [],
        sourceRevision: 3,
      },
    ],
  },
}
it('reorders a multi-shot clip without reassigning shot identity and saves before generation', async () => {
  let content: ProductionDocument['content'] | undefined
  request.mockImplementation(async (_url: string, init: RequestInit) => {
    content = JSON.parse(String(init.body)).content
    return new Response(JSON.stringify({ document: { ...doc, revision: 4, content }, history: [] }))
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionClipPane
          document={doc}
          onSaved={() => {}}
          onClose={() => {}}
          renderGenerations={(clip, blocked) => (
            <button type="button" disabled={Boolean(blocked)}>
              生成 {clip.id}
            </button>
          )}
        />,
      ),
    )
    expect(host.textContent).toContain('预计 25 积分')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="上移 2"]')!.click(),
    )
    expect(host.textContent).toContain('保存片段后')
    expect(
      [...host.querySelectorAll('button')].find((one) => one.textContent === '生成 clip')!.disabled,
    ).toBe(true)
    await act(async () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '保存')!.click(),
    )
    expect(content?.clips?.[0]).toMatchObject({
      id: 'clip',
      shotIds: ['s2', 's1'],
      video: { duration_seconds: 5 },
    })
    expect(content?.shots?.map((one) => one.id)).toEqual(['s1', 's2'])
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
it('keeps an unsupported saved duration visible and requires correction before saving', async () => {
  const invalid: ProductionDocument = {
    ...doc,
    content: {
      ...doc.content,
      clips: [
        {
          ...doc.content.clips![0]!,
          video: { duration_seconds: 6, aspect_ratio: '16:9', resolution: '720p' },
        },
      ],
    },
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(<ProductionClipPane document={invalid} onSaved={() => {}} onClose={() => {}} />),
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('5 / 8 / 10 / 15')
    expect(host.textContent).toContain('预计片长 6 秒')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="上移 2"]')!.click(),
    )
    expect(
      [...host.querySelectorAll('button')].find((one) => one.textContent === '保存')!.disabled,
    ).toBe(true)
    expect(request).not.toHaveBeenCalled()
    const originalScroll = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = () => {}
    try {
      await act(async () =>
        host
          .querySelector<HTMLElement>('[role="combobox"][aria-label="时长"]')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
      )
      const durationOptions = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      expect(
        durationOptions.find((one) => one.textContent === '6 秒')?.getAttribute('aria-disabled'),
      ).toBe('true')
      expect(
        durationOptions.find((one) => one.textContent === '4 秒')?.getAttribute('aria-disabled'),
      ).toBe('true')
      expect(
        durationOptions.find((one) => one.textContent === '5 秒')?.getAttribute('aria-disabled'),
      ).not.toBe('true')
      expect(host.textContent).toContain('预计片长 6 秒')
    } finally {
      Element.prototype.scrollIntoView = originalScroll
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
