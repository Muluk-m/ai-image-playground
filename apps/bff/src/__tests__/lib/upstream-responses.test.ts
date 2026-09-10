import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { jsonResponse } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'

const { config } = await import('../../config')
const {
  callUpstream,
  extractUpstreamFailure,
  setUpstreamFetchForTesting,
  UpstreamResultUnknownError,
} = await import('../../lib/upstream')
const { extractMeta, resolveImageBytesRef } = await import('../../lib/extractImages')
const { isRetryableError } = await import('../../lib/retry')
const { _setChannelsForTesting } = await import('../../lib/channels')
const originalUpstream = { ...config.upstream }
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='
const IMAGE = `data:image/png;base64,${PNG}`
const item = {
  id: 'ig_1',
  type: 'image_generation_call',
  status: 'completed',
  result: PNG,
  output_format: 'png',
  size: '1672x941',
  quality: 'high',
  revised_prompt: '蓝色方块',
}
const doneItem = { type: 'response.output_item.done', output_index: 0, item }
const completed = {
  type: 'response.completed',
  response: { id: 'resp_1', status: 'completed', output: [item] },
}
const request = { provider: 'openai-compat', model: 'gpt-image-2' } as const

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

beforeEach(() => {
  config.upstream.imageResponsesModel = 'gpt-6-astra'
  config.upstream.asyncImageTasks = true
  _setChannelsForTesting([])
})

afterEach(() => {
  setUpstreamFetchForTesting()
  _setChannelsForTesting([])
  Object.assign(config.upstream, originalUpstream)
})

describe('Astra 图片 Responses 调用', () => {
  it('使用可用主模型完成蒙版编辑，图片工具不被 extra 覆盖', async () => {
    setUpstreamFetchForTesting(async (url, init) => {
      const body = JSON.parse(String(init?.body))
      const tool = body.tools?.[0]
      const content = body.input?.[0]?.content
      if (
        !String(url).endsWith('/v1/responses') ||
        body.model !== 'gpt-6-astra' ||
        tool?.model !== 'gpt-image-2' ||
        tool?.action !== 'edit' ||
        tool?.input_image_mask?.image_url !== IMAGE ||
        content?.[0]?.text !== '只改成蓝色' ||
        content?.[1]?.image_url !== IMAGE ||
        content?.[2]?.image_url !== IMAGE ||
        tool?.output_compression !== 0
      ) {
        return jsonResponse({ error: { message: '模型不可用或编辑输入丢失' } }, 400)
      }
      return sse([doneItem, completed])
    })
    const result = await callUpstream({
      ...request,
      request: {
        prompt: '只改成蓝色',
        input_images: [IMAGE, IMAGE],
        mask: IMAGE,
        output_compression: 0,
        extra: { model: 'gpt-5.4-mini', tools: [], prompt: '不要编辑' },
      },
    })
    expect(extractMeta('openai-compat', result.payload).images).toEqual([
      { index: 0, mime: 'image/png', revised_prompt: '蓝色方块' },
    ])
    expect(extractMeta('openai-compat', result.payload).actual_params).toEqual({
      size: '1672x941',
      quality: 'high',
      output_format: 'png',
    })
    expect(resolveImageBytesRef('openai-compat', result.payload, 0)).toEqual({
      kind: 'b64',
      data: PNG,
      mime: 'image/png',
    })
  })

  it('文生图按数量生成并交付图片，每张只记账一次', async () => {
    let charged = 0
    setUpstreamFetchForTesting(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.tools?.[0]?.action !== 'generate' || body.tools[0].n !== undefined) {
        return jsonResponse({ error: { message: '图片工具只接受单张生成' } }, 400)
      }
      return sse([completed])
    })
    const result = await callUpstream({
      ...request,
      request: { prompt: '蓝色方块', n: 2 },
      beforeRequest: async () => {
        charged += 1
      },
    })
    expect(extractMeta('openai-compat', result.payload).images.map((image) => image.index)).toEqual(
      [0, 1],
    )
    expect(charged).toBe(2)
  })

  it.each([
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
  ])('%s 同样走 Responses 桥接，图片工具保留被选中的模型', async (model) => {
    setUpstreamFetchForTesting(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.tools?.[0]?.model !== model) {
        return jsonResponse({ error: { message: '未走 Responses 桥接' } }, 400)
      }
      return sse([completed])
    })

    const result = await callUpstream({ ...request, model, request: { prompt: '蓝色方块' } })

    expect(extractMeta('openai-compat', result.payload).images).toHaveLength(1)
  })

  it('跨 UTF-8 与 CRLF 分片、多行 data 仍能交付图片，不重复收取终态中的同一张图', async () => {
    const text = `: keepalive\r\n\r\ndata: {"type":"response.output_item.done",\r\ndata: "output_index":0,"item":${JSON.stringify(item)}}\r\n\r\ndata: ${JSON.stringify(completed)}\r\n\r\n`
    const bytes = new TextEncoder().encode(text)
    setUpstreamFetchForTesting(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
              controller.close()
            },
          }),
        ),
    )
    const result = await callUpstream({ ...request, request: { prompt: '蓝色方块' } })
    expect(extractMeta('openai-compat', result.payload).images).toEqual([
      { index: 0, mime: 'image/png', revised_prompt: '蓝色方块' },
    ])
    expect(resolveImageBytesRef('openai-compat', result.payload, 0)?.data).toBe(PNG)
  })

  it('图片到达但完成事件缺失时结果未知，禁止自动重试', async () => {
    setUpstreamFetchForTesting(async () => sse([doneItem]))
    let failure: unknown
    try {
      await callUpstream({ ...request, request: { prompt: '蓝色方块' } })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(UpstreamResultUnknownError)
    expect(isRetryableError(failure)).toBe(false)
  })

  it('流内明确拒绝保留错误详情，不能把之前的图片当作成功', async () => {
    setUpstreamFetchForTesting(async () =>
      sse([
        doneItem,
        {
          type: 'response.failed',
          response: {
            id: 'resp_1',
            status: 'failed',
            error: { code: 'content_policy_violation', message: '内容审核拒绝' },
          },
        },
      ]),
    )
    let failure: unknown
    try {
      await callUpstream({ ...request, request: { prompt: '蓝色方块' } })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('内容审核拒绝')
    expect(isRetryableError(failure)).toBe(false)
    expect(JSON.parse(extractUpstreamFailure(failure).body!)).toMatchObject({
      error: { code: 'content_policy_violation', message: '内容审核拒绝' },
    })
  })

  it('HTTP 拒绝按原始状态返回，不误判成成功的 SSE', async () => {
    setUpstreamFetchForTesting(async () =>
      jsonResponse({ error: { message: 'API key 无效' } }, 401),
    )
    await expect(
      callUpstream({ ...request, request: { prompt: '蓝色方块' } }),
    ).rejects.toMatchObject({
      upstreamStatus: 401,
      message: 'API key 无效',
    })
  })

  it('响应头返回后的取消会关闭正在等待图片的响应体', async () => {
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    let cancelled = false
    setUpstreamFetchForTesting(
      async () =>
        new Response(
          new ReadableStream(
            {
              pull() {
                reading()
              },
              cancel() {
                cancelled = true
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    )
    const controller = new AbortController()
    const pending = callUpstream({
      ...request,
      request: { prompt: '蓝色方块' },
      signal: controller.signal,
    })
    await started
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })

  it('切换协议后已提交的异步任务只恢复轮询，不重新生图或记账', async () => {
    let charged = 0
    setUpstreamFetchForTesting(async (url, init) => {
      if (init?.method !== 'GET' || !String(url).endsWith('/images/tasks/imgtask_existing')) {
        throw new Error('不允许重复提交已计费任务')
      }
      return jsonResponse({ status: 'completed', result: { data: [{ b64_json: PNG }] } })
    })
    const result = await callUpstream({
      ...request,
      request: { prompt: '蓝色方块' },
      resume: { taskIds: ['imgtask_existing'], submittedAt: Date.now() },
      beforeRequest: async () => {
        charged += 1
      },
    })
    expect(resolveImageBytesRef('openai-compat', result.payload, 0)?.data).toBe(PNG)
    expect(charged).toBe(0)
  })
})
