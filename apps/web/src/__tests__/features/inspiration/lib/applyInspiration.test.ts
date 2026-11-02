import type { InspirationItem } from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import { API_MAX_IMAGES } from '../../../../lib/inputImageLimit'
import { DEFAULT_PARAMS } from '../../../../types'

const handoff = vi.hoisted(() => ({ start: vi.fn(async () => true) }))
const imageStore = vi.hoisted(() => ({
  storeImageFromUrl: vi.fn(async () => ({
    id: 'stored-reference',
    dataUrl: 'data:image/png;base64,aa',
  })),
}))
vi.mock('../../../../features/agent/lib/heroHandoff', () => ({
  startCanvasFromComposer: handoff.start,
}))
vi.mock('../../../../store', async () => {
  const actual = await vi.importActual<typeof import('../../../../store')>('../../../../store')
  return { ...actual, storeImageFromUrl: imageStore.storeImageFromUrl }
})

const { applyInspiration, useInspirationAsReference } = await import(
  '../../../../features/inspiration/lib/applyInspiration'
)
const { useStore } = await import('../../../../store')
const { useInspirationStore } = await import('../../../../features/inspiration/store')

const skillItem = {
  id: 'skill-item',
  kind: 'skill',
  skill: 'look-clean-studio',
  prompt: '用这只马克杯出一张主图',
  referenceImages: [],
} as unknown as Parameters<typeof applyInspiration>[0]

const showcase = {
  id: 'rain',
  kind: 'showcase',
  title: '雨夜',
  prompt: '主角是 {argument name="subject" default="[NAME]"}',
  thumbnailUrl: 'https://example.com/rain.jpg',
  imageUrl: 'https://example.com/rain-full.jpg',
  params: { size: 'auto', quality: 'high' as const },
  recommendedModel: 'missing-model',
  recommendedProvider: 'openai-compat' as const,
  category: '社交媒体帖子',
  referenceImages: [],
} satisfies InspirationItem

beforeEach(() => {
  handoff.start.mockClear()
  imageStore.storeImageFromUrl.mockClear()
  useStore.setState({ prompt: '', inputImages: [], appMode: 'explore' })
  useInspirationStore.setState({ detailItemId: 'rain' })
})

it.each([
  ['chat', 'chat'],
  ['canvas', 'canvas'],
  ['generate', 'canvas'],
] as const)('技能灵感在「%s」入口下开 %s 项目', async (target, experience) => {
  useStore.getState().setCreateTarget(target)
  applyInspiration(skillItem)
  await vi.waitFor(() => expect(handoff.start).toHaveBeenCalledTimes(1))
  expect(handoff.start).toHaveBeenCalledWith(undefined, experience)
})

it('做同款把占位符换成默认值', async () => {
  applyInspiration(showcase)
  await vi.waitFor(() => expect(useStore.getState().prompt).toBe('主角是 [NAME]'))
  expect(useStore.getState().appMode).toBe('image')
})

it('用作参考图只放入结果图，不改提示词和参数', async () => {
  useStore.setState({
    prompt: '保持不变',
    params: { ...DEFAULT_PARAMS, size: '1024x1024', quality: 'low', n: 1 },
  })
  await useInspirationAsReference(showcase)
  expect(imageStore.storeImageFromUrl).toHaveBeenCalledWith('https://example.com/rain-full.jpg')
  expect(useStore.getState().prompt).toBe('保持不变')
  expect(useStore.getState().params).toMatchObject({ size: '1024x1024', quality: 'low' })
  expect(useStore.getState().inputImages.map((image) => image.id)).toEqual(['stored-reference'])
  expect(useStore.getState().appMode).toBe('image')
  expect(useInspirationStore.getState().detailItemId).toBeNull()
})

it('参考图放不下时不下载，也不改输入', async () => {
  const toast = vi.fn()
  useStore.setState({
    prompt: '保持不变',
    showToast: toast,
    inputImages: Array.from({ length: API_MAX_IMAGES }, (_, index) => ({
      id: `filled-${index}`,
      dataUrl: 'data:image/png;base64,aa',
    })),
  })
  await useInspirationAsReference(showcase)
  expect(imageStore.storeImageFromUrl).not.toHaveBeenCalled()
  expect(useStore.getState().prompt).toBe('保持不变')
  expect(useStore.getState().inputImages).toHaveLength(API_MAX_IMAGES)
  expect(toast).toHaveBeenCalled()
})
