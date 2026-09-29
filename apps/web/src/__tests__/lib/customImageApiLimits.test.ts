import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../lib/apiProfiles'
import type { BYOKAdapterProfile } from '../../lib/imageApiShared'
import {
  callOpenAICompatibleImageApi,
  getCustomQueuedImageResult,
} from '../../lib/openaiCompatibleImageApi'
import { type CustomProviderDefinition, DEFAULT_PARAMS } from '../../types'

const profile: BYOKAdapterProfile = {
  baseUrl: 'https://custom.example/v1',
  apiKey: 'test',
  model: 'test-model',
  apiMode: 'images',
  timeout: 1,
  codexCli: false,
  apiProxy: false,
}
const provider: CustomProviderDefinition = {
  id: 'custom-test',
  name: 'Test',
  submit: { path: 'images', body: { prompt: '$prompt' } },
  poll: {
    path: 'tasks/{task_id}',
    statusPath: 'status',
    successValues: ['done'],
    failureValues: ['failed'],
    result: { imageUrlPaths: ['data.*.url'] },
  },
}
const image = 'data:image/png;base64,aW1hZ2U='

afterEach(() => vi.restoreAllMocks())

it.each(['array', 'object'])('recovers an image from a large %s response', async (shape) => {
  const entries = Array.from({ length: 150_000 }, () => ({ url: null as string | null }))
  entries[entries.length - 1]!.url = image
  const data = shape === 'array' ? entries : Object.fromEntries(entries.map((v, i) => [i, v]))
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ status: 'done', data }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  )

  await expect(
    getCustomQueuedImageResult(profile, provider, 'task', DEFAULT_PARAMS),
  ).resolves.toEqual({
    images: [image],
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('rejects a deeply nested request template before sending a request', async () => {
  let body: Record<string, unknown> = { prompt: '$prompt' }
  for (let i = 0; i < 4000; i++) body = { nested: body }
  const fetchMock = vi.spyOn(globalThis, 'fetch')

  await expect(
    callOpenAICompatibleImageApi(
      {
        settings: DEFAULT_SETTINGS,
        prompt: 'test',
        params: DEFAULT_PARAMS,
        inputImageDataUrls: [],
      },
      profile,
      { ...provider, submit: { ...provider.submit, body } },
    ),
  ).rejects.toThrow('自定义服务商的请求模板嵌套过深，请简化后重试')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('keeps normal nested template substitutions and omitted values', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ data: [{ url: image }] })))
  await callOpenAICompatibleImageApi(
    { settings: DEFAULT_SETTINGS, prompt: 'test', params: DEFAULT_PARAMS, inputImageDataUrls: [] },
    profile,
    {
      ...provider,
      submit: {
        path: 'images',
        body: {
          nested: { prompt: '$prompt', absent: '$missing' },
          list: ['$prompt', '$missing', null],
        },
        result: { imageUrlPaths: ['data.*.url'] },
      },
    },
  )
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
    nested: { prompt: 'test' },
    list: ['test'],
  })
})
