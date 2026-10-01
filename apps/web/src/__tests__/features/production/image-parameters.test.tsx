// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ParamControls from '../../../components/ParamControls'
import ProductionGenerationEditor from '../../../features/production/components/ProductionGenerationEditor'
import { editGeneration } from '../../../features/production/lib/productionGenerationClient'
import { setChannels } from '../../../lib/channels/channelStore'
import { useStore } from '../../../store'
import { DEFAULT_PARAMS } from '../../../types'
import { chooseOption, stubPointerApis } from '../../helpers/radix'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
vi.mock('../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false }),
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  setChannels([])
  request.mockReset()
})
it('edits image model and final quality locally and submits the exact reviewed parameters over HTTP', async () => {
  stubPointerApis()
  setChannels([
    {
      id: 'images',
      label: 'Images',
      kind: 'openai-queue',
      defaults: {},
      models: [
        { id: 'image-a', label: 'A', capabilities: ['generate', 'size', 'quality'] },
        { id: 'image-b', label: 'B', capabilities: ['generate', 'size', 'quality'] },
      ],
    },
  ])
  const before = structuredClone(useStore.getState().params)
  request.mockResolvedValue(new Response(JSON.stringify({ generation: {} })))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerationEditor
          conversationId="conversation"
          busy={false}
          submitLabel="保存"
          value={{
            model: 'image-a',
            prompt: '三视图',
            params: { size: '1024x1024', quality: 'auto' },
            references: [],
          }}
          onConfirm={(fields) => {
            void editGeneration('conversation', 'draft', 3, fields)
          }}
        />,
      ),
    )
    chooseOption('模型', 'image-b')
    const quality = host.querySelector<HTMLElement>('[title="质量: auto"]')
    expect(quality).not.toBeNull()
    await act(async () => quality!.querySelector<HTMLElement>('.absolute > div')!.click())
    const high = Array.from(document.querySelectorAll('div')).find(
      (node) => node.textContent === 'high' && node.onclick,
    )
    expect(high).toBeDefined()
    await act(async () => high!.click())
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((node) => node.textContent === '保存')!
        .click(),
    )
    expect(JSON.parse(String(request.mock.calls[0][1].body))).toMatchObject({
      model: 'image-b',
      draftRevision: 3,
      params: { size: '1024x1024', quality: 'high' },
    })
    expect(useStore.getState().params).toEqual(before)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
it('keeps incompatible values after a model change until the user explicitly resets them', async () => {
  stubPointerApis()
  setChannels([
    {
      id: 'images',
      label: 'Images',
      kind: 'openai-queue',
      defaults: {},
      models: [{ id: 'limited', label: 'Limited', capabilities: ['generate'] }],
    },
  ])
  const saved = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerationEditor
          conversationId="conversation"
          busy={false}
          submitLabel="保存"
          value={{
            model: 'removed',
            prompt: '三视图',
            params: { size: '2048x2048', quality: 'high' },
            references: [],
          }}
          onConfirm={saved}
        />,
      ),
    )
    chooseOption('模型', 'limited')
    const button = () =>
      Array.from(host.querySelectorAll('button')).find((node) => node.textContent === '保存')!
    expect(button().disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(saved).not.toHaveBeenCalled()
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((node) => node.textContent === '重置图片参数')!
        .click(),
    )
    expect(button().disabled).toBe(false)
    await act(async () => button().click())
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ model: 'limited', params: {} }))
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('keeps the ordinary image controls writing their global parameters', async () => {
  const original = useStore.getState()
  setChannels([
    {
      id: 'images',
      label: 'Images',
      kind: 'openai-queue',
      defaults: {},
      models: [{ id: 'image-a', label: 'A', capabilities: ['generate', 'quality'] }],
    },
  ])
  useStore.setState({
    params: { ...DEFAULT_PARAMS },
    settings: {
      ...original.settings,
      activeProfileId: 'profile',
      profiles: [
        { id: 'profile', source: 'builtin-edge', channelId: 'images', selectedModelId: 'image-a' },
      ],
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ParamControls />))
    const quality = host.querySelector<HTMLElement>('[title="质量: auto"]')!
    await act(async () => quality.querySelector<HTMLElement>('.absolute > div')!.click())
    const high = Array.from(document.querySelectorAll('div')).find(
      (node) => node.textContent === 'high' && node.onclick,
    )!
    await act(async () => high.click())
    expect(useStore.getState().params.quality).toBe('high')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    useStore.setState({ params: original.params, settings: original.settings })
  }
})
