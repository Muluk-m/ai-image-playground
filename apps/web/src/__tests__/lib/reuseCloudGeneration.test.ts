// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { PROMPT_REWRITE_GUARD_PREFIX } from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../lib/channels/publicChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/channels/publicChannels')>()),
  getPublicChannels: () => [
    { id: 'edge-openai', kind: 'openai-queue', models: [{ id: 'gpt-image-2' }] },
  ],
}))

import { reuseCloudGeneration } from '../../lib/reuseCloudGeneration'
import { useStore } from '../../store'
import { DEFAULT_PARAMS } from '../../types'

const source = {
  provider: 'openai-compat',
  model: 'gpt-image-2',
  inputs: [],
  mask: null,
}

beforeEach(() => {
  useStore.setState({ params: { ...DEFAULT_PARAMS, no_rewrite: false }, prompt: '' })
})

it('平台投影剥掉前缀后，防改写按参数带回输入框', async () => {
  await reuseCloudGeneration(
    { ...source, prompt: '一只猫', params: { ...DEFAULT_PARAMS, no_rewrite: true } },
    new AbortController().signal,
  )
  expect(useStore.getState().prompt).toBe('一只猫')
  expect(useStore.getState().params.no_rewrite).toBe(true)
})

it('提示词仍带前缀的旧卡：照旧剥掉前缀并打开防改写', async () => {
  await reuseCloudGeneration(
    {
      ...source,
      prompt: `${PROMPT_REWRITE_GUARD_PREFIX}\n一只猫`,
      params: { ...DEFAULT_PARAMS, no_rewrite: false },
    },
    new AbortController().signal,
  )
  expect(useStore.getState().prompt).toBe('一只猫')
  expect(useStore.getState().params.no_rewrite).toBe(true)
})

it('没开防改写的记录复用后保持关闭', async () => {
  await reuseCloudGeneration(
    { ...source, prompt: '一只猫', params: { ...DEFAULT_PARAMS, no_rewrite: false } },
    new AbortController().signal,
  )
  expect(useStore.getState().params.no_rewrite).toBe(false)
})
