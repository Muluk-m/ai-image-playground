// @vitest-environment jsdom
import type { ProductionDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionAssetPane from '../../../features/production/components/ProductionAssetPane'
import ProductionDocumentPane from '../../../features/production/components/ProductionDocumentPane'
import ProductionShotPane from '../../../features/production/components/ProductionShotPane'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  request.mockReset()
  localStorage.clear()
})
const doc: ProductionDocument = {
  id: 'doc',
  conversationId: 'conversation',
  projectId: null,
  revision: 4,
  updatedAt: 1,
  content: {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [{ id: 'scene', title: '车站', body: '她走向站台' }],
    characters: [
      {
        id: 'hero',
        name: '林晓',
        description: '旅人',
        looks: [
          { id: 'coat', name: '雨衣', description: '黄色' },
          { id: 'dress', name: '便装', description: '白色' },
        ],
      },
    ],
    locations: [{ id: 'station', name: '站台', description: '夜晚' }],
    shots: [
      {
        id: 'first',
        scriptSceneId: 'scene',
        locationId: 'station',
        lookIds: ['coat'],
        description: '雨衣走近',
      },
      { id: 'second', lookIds: ['dress'], description: '便装远去' },
    ],
    clips: [
      {
        id: 'clip',
        name: '开场片段',
        shotIds: ['first'],
        prompt: '列车',
        model: 'grok-imagine-video',
        video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
        references: [],
        sourceRevision: 4,
        adopted: { draftId: 'draft', artifactId: 'artifact', adoptedAt: 1 },
      },
      {
        id: 'other',
        name: '尾声片段',
        shotIds: ['second'],
        prompt: '列车',
        model: 'grok-imagine-video',
        video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
        references: [],
        sourceRevision: 4,
      },
    ],
  },
}
for (const kind of ['character', 'look', 'location', 'scene', 'shot'] as const)
  it(`reviews ${kind} deletion impact before changing content and preserves clip outputs`, async () => {
    request.mockImplementation(
      async (_url, init) =>
        new Response(
          JSON.stringify({
            document: {
              ...doc,
              content: init?.method === 'PUT' ? JSON.parse(init.body).content : doc.content,
            },
            history: [],
            storyboardProposals: [],
          }),
        ),
    )
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const button = (text: string) =>
      Array.from(host.querySelectorAll('button')).find((one) => one.textContent?.trim() === text)!
    try {
      await act(async () =>
        root.render(
          kind === 'scene' ? (
            <ProductionDocumentPane document={doc} onClose={() => {}} onSaved={() => {}} />
          ) : kind === 'shot' ? (
            <ProductionShotPane document={doc} onClose={() => {}} onSaved={() => {}} />
          ) : (
            <ProductionAssetPane
              document={doc}
              target={{
                kind: kind === 'location' ? 'location' : 'character',
                id: kind === 'location' ? 'station' : 'hero',
              }}
              onClose={() => {}}
              onSaved={() => {}}
            />
          ),
        ),
      )
      if (kind === 'scene') {
        await act(async () => button('编辑').click())
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[aria-label="删除场景"]')!.click(),
        )
      } else if (kind === 'shot') {
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[aria-label="编辑分镜"]')!.click(),
        )
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[aria-label="删除镜头 1"]')!.click(),
        )
      } else await act(async () => button(kind === 'look' ? '删除此造型' : '删除').click())
      const impact = host.querySelector('[aria-label="删除影响"]')!
      expect(impact).not.toBeNull()
      expect(impact.textContent).toContain('开场片段')
      expect(impact.textContent).toContain('已采用的产物会保留')
      if (kind === 'look') expect(impact.textContent).not.toContain('尾声片段')
      if (kind === 'character') expect(impact.textContent).toContain('尾声片段')
      expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
      await act(async () => button('取消').click())
      expect(host.querySelector('[aria-label="删除影响"]')).toBeNull()
      if (kind === 'scene')
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[aria-label="删除场景"]')!.click(),
        )
      else if (kind === 'shot')
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[aria-label="删除镜头 1"]')!.click(),
        )
      else await act(async () => button(kind === 'look' ? '删除此造型' : '删除').click())
      await act(async () => button(kind === 'shot' ? '确认删除镜头' : '确认删除').click())
      if (kind === 'scene' || kind === 'shot') await act(async () => button('完成').click())
      const writes = request.mock.calls.filter(([, init]) => init?.method === 'PUT')
      expect(writes).toHaveLength(1)
      const content = JSON.parse(writes[0]![1].body).content
      expect(content.clips).toEqual(doc.content.clips)
      if (kind === 'character') expect(content.characters).toEqual([])
      if (kind === 'look')
        expect(content.characters[0].looks.map((look: { id: string }) => look.id)).toEqual([
          'dress',
        ])
      if (kind === 'location') expect(content.locations).toEqual([])
      if (kind === 'scene') expect(content.scenes).toEqual([])
      if (kind === 'shot')
        expect(content.shots.map((shot: { id: string }) => shot.id)).toEqual(['second'])
      if (kind !== 'shot') expect(content.shots).toEqual(doc.content.shots)
      expect(request.mock.calls.some(([url]) => String(url).includes('/generations'))).toBe(false)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
