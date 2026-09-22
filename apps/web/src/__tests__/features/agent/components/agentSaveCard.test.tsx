// @vitest-environment jsdom
import type { AgentAssetSaveCard, AgentLookSaveCard } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentSaveCard from '../../../../features/agent/components/AgentSaveCard'
import { useAgentStore } from '../../../../features/agent/store'
import type { AgentToolMessage } from '../../../../features/agent/types'
import type { AssetRecordInput, LookRecordInput } from '../../../../features/library/store'
import { useLibraryStore } from '../../../../features/library/store'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

// 取图那一层另有其事（本机图片库、队列产物、归档附图），这里只关心卡片把什么交给了它，
// 以及它交回来的本机 id 有没有真的写进记录。
vi.mock('../../../../features/agent/lib/saveCardImages', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agentImagePreview: async (imageId: string) => `preview:${imageId}`,
  storeAgentImages: async (images: readonly { agentImageId: string }[]) =>
    images.map((one) => ({ agentImageId: one.agentImageId, imageId: `local-${one.agentImageId}` })),
}))

const CONVERSATION = 'conversation-1'

const assetCard: AgentAssetSaveCard = {
  kind: 'asset',
  status: 'pending',
  name: '浴缸',
  assetKind: 'product',
  background: 'transparent',
  views: [
    { imageId: 'sheet-1', label: 'sheet', source: 'generated' },
    { imageId: 'upload-1', label: 'front', source: 'upload' },
  ],
}

const lookCard: AgentLookSaveCard = {
  kind: 'look',
  status: 'pending',
  name: '暖光台面',
  description: '暖光台面场景图',
  purpose: 'scene',
  body: '## 1. 一句话目标\n把产品放进暖光台面场景。',
  model: 'gpt-image-1',
  size: '1024x1024',
  slotCount: 1,
  referenceImageIds: ['ref-1'],
  coverImageId: 'cover-1',
}

function message(card: AgentAssetSaveCard | AgentLookSaveCard): AgentToolMessage {
  return {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    toolCallId: `call-${card.kind}`,
    toolName: card.kind === 'asset' ? 'saveAsset' : 'saveLook',
    title: '存为素材',
    status: 'succeeded',
    saveCard: card,
  }
}

const posted: unknown[] = []
const savedAssets: AssetRecordInput[] = []
const savedLooks: LookRecordInput[] = []

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/saves')) {
    posted.push(JSON.parse(String(init?.body ?? 'null')))
    return Response.json({
      message: { id: 'tool-1', turnId: 'turn-1', role: 'assistant', content: [], createdAt: 1 },
    })
  }
  return Response.json({})
})

let host: HTMLDivElement
let root: Root

globalThis.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  posted.length = 0
  savedAssets.length = 0
  savedLooks.length = 0
  useAgentStore.setState({ conversationId: CONVERSATION, messages: [] })
  useLibraryStore.setState({
    saveAssetRecord: async (input) => {
      savedAssets.push(input)
      return {
        id: 'asset-1',
        name: input.name,
        views: input.views,
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      }
    },
    saveLookRecord: async (input) => {
      savedLooks.push(input)
      return { ...input, id: input.id ?? 'look-1', createdAt: 1, updatedAt: 1, lastUsedAt: 1 }
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAgentStore.setState({ conversationId: null, messages: [] })
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

function render(card: AgentAssetSaveCard | AgentLookSaveCard): void {
  act(() => root.render(<AgentSaveCard card={card} message={message(card)} />))
}

function buttonText(prefix: string): HTMLButtonElement {
  return [...host.querySelectorAll('button')].find((one) =>
    one.textContent?.startsWith(prefix),
  ) as HTMLButtonElement
}

function type(value: string): void {
  const input = host.querySelector('input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('去掉一张视角之后，存下去的就只有剩下的那几张', async () => {
  render(assetCard)
  expect(buttonText('保存 2 张')).toBeTruthy()

  // 缩略图本身就是开关：点一下这张就不进这条素材。
  const thumbnails = [...host.querySelectorAll('button')].filter((one) =>
    one.getAttribute('aria-pressed'),
  )
  act(() => thumbnails[0]!.click())
  expect(buttonText('保存 1 张')).toBeTruthy()

  await act(async () => buttonText('保存 1 张').click())

  expect(savedAssets).toEqual([
    {
      name: '浴缸',
      kind: 'product',
      background: 'transparent',
      // 模型那边的 id 不进记录：写进去的是取回字节之后的本机 id。
      views: [{ imageId: 'local-upload-1', label: 'front', source: 'upload' }],
    },
  ])
  expect(posted).toEqual([
    {
      deviceId: expect.any(String),
      toolCallId: 'call-asset',
      kind: 'asset',
      recordId: 'asset-1',
      name: '浴缸',
    },
  ])
  expect(host.textContent).toContain('已存为素材：浴缸')
})

it('模板按用户最后定下的名字存，封面与参考图都换成本机 id', async () => {
  render(lookCard)
  type('暖光台面 v2')

  await act(async () => buttonText('保存').click())

  expect(savedLooks).toEqual([
    {
      name: '暖光台面 v2',
      description: '暖光台面场景图',
      purpose: 'scene',
      body: lookCard.body,
      model: 'gpt-image-1',
      size: '1024x1024',
      slotCount: 1,
      referenceImageIds: ['local-ref-1'],
      coverImageId: 'local-cover-1',
    },
  ])
  expect(posted).toMatchObject([{ kind: 'look', recordId: 'look-1', name: '暖光台面 v2' }])
  expect(host.textContent).toContain('已存为模板：暖光台面 v2')
})

/** 已经存过的那张卡不再是入口：翻回这段对话不能再存出第二条记录。 */
it('存过的卡只剩一行结果', () => {
  render({ ...assetCard, status: 'saved', recordId: 'asset-1' })

  expect(host.textContent).toContain('已存为素材：浴缸')
  expect(host.querySelector('input')).toBeNull()
  expect(buttonText('保存')).toBeUndefined()
})
