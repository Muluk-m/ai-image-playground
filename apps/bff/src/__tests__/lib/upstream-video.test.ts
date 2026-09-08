import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import type { HydratedVideoRequest } from '../../lib/imageArchive'
import { jsonResponse as json } from '../helpers/upstreamStubs'

// Inject before importing config, which captures process environment at module initialization.
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const {
  callUpstream,
  extractUpstreamFailure,
  setAsyncPollBackoffForTesting,
  setUpstreamFetchForTesting,
} = await import('../../lib/upstream')
const { isRetryableError } = await import('../../lib/retry')
const { _setChannelsForTesting } = await import('../../lib/channels')
type InternalChannel = import('../../lib/channels').InternalChannel
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

const GROK_BASE = 'https://gateway.example/v1'
const AGNES_BASE = 'https://apihub.agnes-ai.com/v1'
const AGNES_POLL = 'https://apihub.agnes-ai.com/agnesapi'
const ARK_BASE = 'https://ark.example/api/v3'
const ARK_TASKS = `${ARK_BASE}/contents/generations/tasks`
const ARK_MODEL = 'doubao-seedance-2-0-mini-260615'
const VEO_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const VEO_MODEL = 'veo-3.1-fast-generate-preview'
const VEO_OPERATION = `models/${VEO_MODEL}/operations/op_1`
const VEO_SUBMIT = `${VEO_BASE}/models/${VEO_MODEL}:predictLongRunning`
const VEO_POLL = `${VEO_BASE}/${VEO_OPERATION}`
const VEO_DOWNLOAD = `${VEO_BASE}/files/veo_1:download?alt=media`
const ARK_RESULT_URL = 'https://ark-content.example/videos/a.mp4'
const RESULT_URL = 'https://cdn.agnes-ai.com/videos/a.mp4'
const SOURCE_VIDEO_DATA_URL = 'data:video/mp4;base64,AAAAGGZ0eXBpc29t'
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='

/** ISO-BMFF 头：4 字节 box size + 'ftyp'。 */
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
])

const grokVideoChannel: InternalChannel = {
  id: 'grok-video',
  kind: 'openai-queue',
  label: 'Grok Imagine Video',
  baseUrl: GROK_BASE,
  auth: { type: 'bearer', secretRef: 'GROK_API_KEY', secret: 'grok-test-key' },
  allowedPaths: ['videos/generations', 'videos/extensions', 'videos/edits', 'videos'],
  models: [
    {
      id: 'grok-imagine-video',
      label: 'Grok Imagine Video',
      media: 'video',
      capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
    },
  ],
  defaults: { timeout: 600, asyncTasks: true },
}

const agnesVideoChannel: InternalChannel = {
  id: 'agnes-video',
  kind: 'openai-queue',
  label: 'Agnes AI Video',
  baseUrl: AGNES_BASE,
  auth: { type: 'bearer', secretRef: 'AGNES_API_KEY', secret: 'agnes-test-key' },
  allowedPaths: ['videos', 'agnesapi'],
  models: [
    {
      id: 'agnes-video-2.5-flash',
      label: 'Agnes Video 2.5 Flash',
      media: 'video',
      capabilities: [
        'generate',
        'duration',
        'aspect_ratio',
        'resolution',
        'first_frame',
        'last_frame',
      ],
    },
  ],
  defaults: { timeout: 600, asyncTasks: true },
}

const arkVideoChannel: InternalChannel = {
  id: 'ark-video',
  kind: 'openai-queue',
  label: 'Seedance Video',
  baseUrl: ARK_BASE,
  auth: { type: 'bearer', secretRef: 'ARK_API_KEY', secret: 'ark-test-key' },
  allowedPaths: ['contents/generations/tasks'],
  models: [
    {
      id: ARK_MODEL,
      label: 'Seedance 2.0 Mini',
      media: 'video',
      capabilities: [
        'generate',
        'duration',
        'aspect_ratio',
        'resolution',
        'first_frame',
        'last_frame',
      ],
    },
  ],
  defaults: { timeout: 600, asyncTasks: true },
}

const veoVideoChannel: InternalChannel = {
  id: 'veo-video',
  kind: 'openai-queue',
  label: 'Veo',
  baseUrl: VEO_BASE,
  auth: { type: 'bearer', secretRef: 'VEO_API_KEY', secret: 'veo-test-key' },
  allowedPaths: ['models'],
  models: [
    {
      id: VEO_MODEL,
      label: 'Veo 3.1 Fast',
      media: 'video',
      capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
    },
  ],
  defaults: { timeout: 600, asyncTasks: true },
}

type FetchCall = { url: string; init: Parameters<TestFetch>[1] }

let calls: FetchCall[] = []
let handler: (url: string) => Response

function bodyOf(url: string): Record<string, unknown> {
  const call = calls.find((one) => one.url === url)
  if (!call) throw new Error(`no request to ${url}; got ${calls.map((c) => c.url).join(', ')}`)
  return JSON.parse(String((call.init as { body?: unknown }).body))
}

function video(overrides: Partial<HydratedVideoRequest> = {}): HydratedVideoRequest {
  return { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p', ...overrides }
}

function run(model: string, request: Record<string, unknown>) {
  return callUpstream({
    provider: 'openai-compat',
    model,
    request: { prompt: 'a cat surfing', ...request } as never,
  })
}

beforeEach(() => {
  calls = []
  handler = () => json({})
  setAsyncPollBackoffForTesting([1])
  _setChannelsForTesting([grokVideoChannel, agnesVideoChannel, arkVideoChannel, veoVideoChannel])
  setUpstreamFetchForTesting((async (
    input: Parameters<TestFetch>[0],
    init: Parameters<TestFetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init })
    return handler(url)
  }) as unknown as TestFetch)
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setAsyncPollBackoffForTesting()
  _setChannelsForTesting([])
})

describe('Grok video upstream', () => {
  it('creates the task, polls to done and fetches the content bytes', async () => {
    let polls = 0
    handler = (url) => {
      if (url === `${GROK_BASE}/videos/generations`) return json({ request_id: 'req_1' })
      if (url === `${GROK_BASE}/videos/req_1`) {
        return ++polls === 1
          ? json({ status: 'pending', progress: 1 })
          : json({
              status: 'done',
              progress: 100,
              video: { duration: 5, url: '/v1/videos/req_1/content' },
            })
      }
      return new Response(MP4_BYTES, { status: 200 })
    }

    const { payload } = await run('grok-imagine-video', { video: video() })

    expect(bodyOf(`${GROK_BASE}/videos/generations`)).toEqual({
      model: 'grok-imagine-video',
      prompt: 'a cat surfing',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
    })
    expect(calls.map((one) => one.url)).toEqual([
      `${GROK_BASE}/videos/generations`,
      `${GROK_BASE}/videos/req_1`,
      `${GROK_BASE}/videos/req_1`,
      `${GROK_BASE}/videos/req_1/content`,
    ])
    const data = (payload as { data: Array<Record<string, unknown>> }).data
    expect(data[0]).toMatchObject({ mime: 'video/mp4', duration_seconds: 5 })
    expect(Buffer.from(String(data[0]?.b64_json), 'base64').equals(Buffer.from(MP4_BYTES))).toBe(
      true,
    )
  })

  it('switches to the image-to-video model when a first frame is present', async () => {
    handler = (url) => {
      if (url === `${GROK_BASE}/videos/generations`) return json({ request_id: 'req_2' })
      if (url === `${GROK_BASE}/videos/req_2`)
        return json({ status: 'done', video: { duration: 8, url: '/v1/videos/req_2/content' } })
      return new Response(MP4_BYTES, { status: 200 })
    }

    await run('grok-imagine-video', {
      input_images: [TINY_PNG_DATA_URL],
      video: video({ duration_seconds: 8, first_frame_index: 0 }),
    })

    expect(bodyOf(`${GROK_BASE}/videos/generations`)).toMatchObject({
      model: 'grok-imagine-video-1.5',
      duration: 8,
      image: { url: TINY_PNG_DATA_URL },
    })
  })

  it('reads the content endpoint with the channel credential', async () => {
    handler = (url) => {
      if (url === `${GROK_BASE}/videos/generations`) return json({ request_id: 'req_3' })
      if (url === `${GROK_BASE}/videos/req_3`)
        return json({ status: 'succeeded', video: { url: '/v1/videos/req_3/content' } })
      return new Response(MP4_BYTES, { status: 200 })
    }

    await run('grok-imagine-video', { video: video() })

    const content = calls.at(-1)!
    expect(content.url).toBe(`${GROK_BASE}/videos/req_3/content`)
    expect((content.init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer grok-test-key',
    )
  })

  it('posts an extension with the source data URI and the extension length', async () => {
    handler = (url) => {
      if (url === `${GROK_BASE}/videos/extensions`) return json({ request_id: 'req_ext' })
      if (url === `${GROK_BASE}/videos/req_ext`)
        return json({ status: 'done', video: { duration: 3, url: '/v1/videos/req_ext/content' } })
      return new Response(MP4_BYTES, { status: 200 })
    }

    const { payload } = await run('grok-imagine-video', {
      video: video({
        mode: 'extend',
        duration_seconds: 3,
        source_task_id: 'src',
        source_output_index: 0,
        source_video: SOURCE_VIDEO_DATA_URL,
      }),
    })

    expect(bodyOf(`${GROK_BASE}/videos/extensions`)).toEqual({
      model: 'grok-imagine-video',
      prompt: 'a cat surfing',
      video: { url: SOURCE_VIDEO_DATA_URL },
      duration: 3,
    })
    expect(calls[0]?.url).toBe(`${GROK_BASE}/videos/extensions`)
    const data = (payload as { data: Array<Record<string, unknown>> }).data
    expect(data[0]).toMatchObject({ mime: 'video/mp4', duration_seconds: 3 })
  })

  it('posts an edit without a duration and keeps the source length', async () => {
    handler = (url) => {
      if (url === `${GROK_BASE}/videos/edits`) return json({ request_id: 'req_edit' })
      if (url === `${GROK_BASE}/videos/req_edit`)
        return json({ status: 'done', video: { url: '/v1/videos/req_edit/content' } })
      return new Response(MP4_BYTES, { status: 200 })
    }

    const { payload } = await run('grok-imagine-video', {
      video: video({
        mode: 'edit',
        duration_seconds: 6,
        source_task_id: 'src',
        source_output_index: 1,
        source_video: SOURCE_VIDEO_DATA_URL,
      }),
    })

    expect(bodyOf(`${GROK_BASE}/videos/edits`)).toEqual({
      model: 'grok-imagine-video',
      prompt: 'a cat surfing',
      video: { url: SOURCE_VIDEO_DATA_URL },
    })
    expect((payload as { data: Array<Record<string, unknown>> }).data[0]).toMatchObject({
      duration_seconds: 6,
    })
  })

  it('refuses to submit an extension whose source video did not hydrate', async () => {
    await expect(
      run('grok-imagine-video', {
        video: video({ mode: 'extend', source_task_id: 'src', source_output_index: 0 }),
      }),
    ).rejects.toThrow('续写和改视频缺少源视频')
    expect(calls).toEqual([])
  })

  it('fails terminally when the upstream task reports a failed status', async () => {
    handler = (url) =>
      url === `${GROK_BASE}/videos/generations`
        ? json({ request_id: 'req_4' })
        : json({ status: 'failed', error: { message: 'moderation blocked' } })

    await expect(run('grok-imagine-video', { video: video() })).rejects.toThrow(
      'moderation blocked',
    )
  })

  it('maps an internal_error failure to the Chinese message and keeps the upstream body', async () => {
    const failure = {
      status: 'failed',
      error: {
        code: 'internal_error',
        message: 'Video generation failed due to an internal error. Please try again.',
      },
    }
    handler = (url) =>
      url === `${GROK_BASE}/videos/generations` ? json({ request_id: 'req_5' }) : json(failure)

    const err = await run('grok-imagine-video', { video: video() }).catch((one: unknown) => one)

    expect((err as Error).message).toBe('上游服务异常，请稍后重试')
    expect(extractUpstreamFailure(err)).toEqual({ status: null, body: JSON.stringify(failure) })
  })
})

describe('Agnes video upstream', () => {
  const pollUrl = `${AGNES_POLL}?video_id=task_1&model_name=agnes-video-2.5-flash`

  it('creates a text-mode task, polls the gateway root and returns the result address', async () => {
    let polls = 0
    handler = (url) => {
      if (url === `${AGNES_BASE}/videos`) return json({ video_id: 'task_1', status: 'queued' })
      return ++polls === 1
        ? json({ status: 'in_progress' })
        : json({ status: 'completed', url: RESULT_URL })
    }

    const { payload } = await run('agnes-video-2.5-flash', { video: video() })

    expect(bodyOf(`${AGNES_BASE}/videos`)).toEqual({
      model: 'agnes-video-2.5-flash',
      prompt: 'a cat surfing',
      seconds: '5',
      mode: 'text',
      size: '720P',
      aspect_ratio: '16:9',
    })
    expect(calls.map((one) => one.url)).toEqual([`${AGNES_BASE}/videos`, pollUrl, pollUrl])
    expect(payload).toEqual({
      data: [{ url: RESULT_URL, mime: 'video/mp4', duration_seconds: 5 }],
    })
  })

  it('sends keyframe mode with both frames and the mapped size', async () => {
    handler = (url) =>
      url === `${AGNES_BASE}/videos`
        ? json({ video_id: 'task_1' })
        : json({ status: 'completed', url: RESULT_URL })

    await run('agnes-video-2.5-flash', {
      input_images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
      video: video({ resolution: '720p', first_frame_index: 0, last_frame_index: 1 }),
    })

    expect(bodyOf(`${AGNES_BASE}/videos`)).toMatchObject({
      mode: 'keyframe',
      size: '720P',
      first_frame: TINY_PNG_DATA_URL,
      last_frame: TINY_PNG_DATA_URL,
    })
  })

  it('falls back to the metadata address when the top level one is missing', async () => {
    handler = (url) =>
      url === `${AGNES_BASE}/videos`
        ? json({ video_id: 'task_1' })
        : json({ status: 'completed', metadata: { url: RESULT_URL } })

    const { payload } = await run('agnes-video-2.5-flash', { video: video() })

    expect(payload).toMatchObject({ data: [{ url: RESULT_URL }] })
  })

  it('fails terminally with the upstream message when the task fails', async () => {
    handler = (url) =>
      url === `${AGNES_BASE}/videos`
        ? json({ video_id: 'task_1' })
        : json({ status: 'failed', error: { message: 'generation failed' } })

    await expect(run('agnes-video-2.5-flash', { video: video() })).rejects.toThrow(
      'generation failed',
    )
  })

  it('surfaces a rate limited creation as a retryable upstream failure', async () => {
    handler = () => json({ error: { message: 'rate_limit_exceeded' } }, 429)

    await expect(run('agnes-video-2.5-flash', { video: video() })).rejects.toMatchObject({
      upstreamStatus: 429,
    })
  })
})

describe('Seedance video upstream', () => {
  const pollUrl = `${ARK_TASKS}/task_ark_1`

  it('creates a text task, polls the same path and returns the result address', async () => {
    let polls = 0
    handler = (url) => {
      if (url === ARK_TASKS) return json({ id: 'task_ark_1' })
      return ++polls === 1
        ? json({ status: 'running' })
        : json({ status: 'succeeded', content: { video_url: ARK_RESULT_URL } })
    }

    const { payload } = await run(ARK_MODEL, {
      video: video({ duration_seconds: 15, resolution: '1080p' }),
    })

    expect(bodyOf(ARK_TASKS)).toEqual({
      model: ARK_MODEL,
      content: [{ type: 'text', text: 'a cat surfing' }],
      ratio: '16:9',
      duration: 15,
      resolution: '1080p',
      watermark: false,
    })
    expect(calls.map((one) => one.url)).toEqual([ARK_TASKS, pollUrl, pollUrl])
    expect(payload).toEqual({
      data: [{ url: ARK_RESULT_URL, mime: 'video/mp4', duration_seconds: 15 }],
    })
  })

  it('sends both keyframes as roled image_url content items', async () => {
    handler = (url) =>
      url === ARK_TASKS
        ? json({ id: 'task_ark_1' })
        : json({ status: 'succeeded', content: { video_url: ARK_RESULT_URL } })

    await run(ARK_MODEL, {
      input_images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
      video: video({ first_frame_index: 0, last_frame_index: 1 }),
    })

    expect(bodyOf(ARK_TASKS).content).toEqual([
      { type: 'text', text: 'a cat surfing' },
      { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL }, role: 'last_frame' },
    ])
  })

  it('submits with the channel credential', async () => {
    handler = (url) =>
      url === ARK_TASKS
        ? json({ id: 'task_ark_1' })
        : json({ status: 'succeeded', content: { video_url: ARK_RESULT_URL } })

    await run(ARK_MODEL, { video: video() })

    expect((calls[0]?.init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer ark-test-key',
    )
  })

  it('fails terminally with the upstream message when the task fails', async () => {
    handler = (url) =>
      url === ARK_TASKS
        ? json({ id: 'task_ark_1' })
        : json({ status: 'failed', error: { message: 'content moderation blocked' } })

    await expect(run(ARK_MODEL, { video: video() })).rejects.toThrow('content moderation blocked')
  })

  it('keeps polling through an unknown intermediate status', async () => {
    let polls = 0
    handler = (url) => {
      if (url === ARK_TASKS) return json({ id: 'task_ark_1' })
      return ++polls === 1
        ? json({ status: 'some_new_state' })
        : json({ status: 'succeeded', content: { video_url: ARK_RESULT_URL } })
    }

    await run(ARK_MODEL, { video: video() })

    expect(calls).toHaveLength(3)
  })

  it('reports an unknown result when the succeeded payload carries no address', async () => {
    handler = (url) =>
      url === ARK_TASKS ? json({ id: 'task_ark_1' }) : json({ status: 'succeeded', content: {} })

    await expect(run(ARK_MODEL, { video: video() })).rejects.toThrow(
      'Seedance 视频任务已完成但未返回结果地址',
    )
  })

  it('refuses extend before reaching the upstream', async () => {
    await expect(
      run(ARK_MODEL, {
        video: video({ mode: 'extend', source_task_id: 'src', source_output_index: 0 }),
      }),
    ).rejects.toThrow('该模型不支持续写和改视频')
    expect(calls).toEqual([])
  })
})

function headersOf(url: string): Record<string, string> {
  const call = calls.find((one) => one.url === url)
  if (!call) throw new Error(`no request to ${url}; got ${calls.map((c) => c.url).join(', ')}`)
  return (call.init as { headers: Record<string, string> }).headers
}

describe('Veo video upstream', () => {
  const doneOperation = {
    done: true,
    response: {
      generateVideoResponse: { generatedSamples: [{ video: { uri: VEO_DOWNLOAD } }] },
    },
  }

  it('submits the long running operation, polls it and downloads the mp4', async () => {
    let polls = 0
    handler = (url) => {
      if (url === VEO_SUBMIT) return json({ name: VEO_OPERATION })
      if (url === VEO_POLL) return ++polls === 1 ? json({ done: false }) : json(doneOperation)
      return new Response(MP4_BYTES, { status: 200 })
    }

    const { payload } = await run(VEO_MODEL, { video: video({ duration_seconds: 4 }) })

    expect(bodyOf(VEO_SUBMIT)).toEqual({
      instances: [{ prompt: 'a cat surfing' }],
      parameters: {
        aspectRatio: '16:9',
        durationSeconds: '4',
        resolution: '720p',
        personGeneration: 'allow_all',
      },
    })
    expect(calls.map((one) => one.url)).toEqual([VEO_SUBMIT, VEO_POLL, VEO_POLL, VEO_DOWNLOAD])
    expect(headersOf(VEO_SUBMIT)['x-goog-api-key']).toBe('veo-test-key')
    expect(headersOf(VEO_SUBMIT).authorization).toBeUndefined()
    expect(headersOf(VEO_DOWNLOAD)['x-goog-api-key']).toBe('veo-test-key')
    const data = (payload as { data: Array<Record<string, unknown>> }).data
    expect(data[0]).toMatchObject({ mime: 'video/mp4', duration_seconds: 4 })
    expect(Buffer.from(String(data[0]?.b64_json), 'base64').equals(Buffer.from(MP4_BYTES))).toBe(
      true,
    )
  })

  it('sends a first frame as inline data and narrows person generation', async () => {
    handler = (url) =>
      url === VEO_SUBMIT
        ? json({ name: VEO_OPERATION })
        : url === VEO_POLL
          ? json(doneOperation)
          : new Response(MP4_BYTES, { status: 200 })

    await run(VEO_MODEL, {
      input_images: [TINY_PNG_DATA_URL],
      video: video({ duration_seconds: 8, resolution: '1080p', first_frame_index: 0 }),
    })

    expect(bodyOf(VEO_SUBMIT)).toEqual({
      instances: [
        {
          prompt: 'a cat surfing',
          image: {
            inlineData: {
              mimeType: 'image/png',
              data: TINY_PNG_DATA_URL.split(',')[1],
            },
          },
        },
      ],
      parameters: {
        aspectRatio: '16:9',
        durationSeconds: '8',
        resolution: '1080p',
        personGeneration: 'allow_adult',
      },
    })
  })

  it('fails terminally when the finished operation carries an error', async () => {
    handler = (url) =>
      url === VEO_SUBMIT
        ? json({ name: VEO_OPERATION })
        : json({ done: true, error: { code: 3, message: 'safety filter blocked the prompt' } })

    await expect(run(VEO_MODEL, { video: video({ duration_seconds: 4 }) })).rejects.toThrow(
      'safety filter blocked the prompt',
    )
  })

  it('reports an unknown result when the finished operation carries no sample', async () => {
    handler = (url) =>
      url === VEO_SUBMIT
        ? json({ name: VEO_OPERATION })
        : json({ done: true, response: { generateVideoResponse: { generatedSamples: [] } } })

    await expect(run(VEO_MODEL, { video: video({ duration_seconds: 4 }) })).rejects.toThrow(
      'Veo 视频任务已完成但未返回结果地址',
    )
  })

  it('fails when the download answers a non-2xx', async () => {
    handler = (url) => {
      if (url === VEO_SUBMIT) return json({ name: VEO_OPERATION })
      if (url === VEO_POLL) return json(doneOperation)
      return json({ error: { message: 'file expired' } }, 403)
    }

    await expect(run(VEO_MODEL, { video: video({ duration_seconds: 4 }) })).rejects.toMatchObject({
      upstreamStatus: 403,
    })
  })

  it('keeps a rate limited submit retryable and a rejected one permanent', async () => {
    handler = () => json({ error: { message: 'quota exceeded' } }, 429)
    const rateLimited = await run(VEO_MODEL, { video: video({ duration_seconds: 4 }) }).catch(
      (err: unknown) => err,
    )
    expect(rateLimited).toMatchObject({ upstreamStatus: 429 })
    expect(isRetryableError(rateLimited)).toBe(true)

    handler = () => json({ error: { message: 'prompt too long' } }, 400)
    const rejected = await run(VEO_MODEL, { video: video({ duration_seconds: 4 }) }).catch(
      (err: unknown) => err,
    )
    expect(rejected).toMatchObject({ upstreamStatus: 400 })
    expect(isRetryableError(rejected)).toBe(false)
  })

  it('follows the download redirect and carries the key onto the final hop', async () => {
    const seen: Array<{ path: string; key: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        seen.push({ path: url.pathname, key: req.headers.get('x-goog-api-key') })
        if (url.pathname.endsWith(':predictLongRunning')) return json({ name: VEO_OPERATION })
        if (url.pathname.endsWith('/op_1'))
          return json({
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [{ video: { uri: `${url.origin}/v1beta/files/veo_1` } }],
              },
            },
          })
        if (url.pathname === '/v1beta/files/veo_1')
          return new Response(null, {
            status: 302,
            headers: { location: `${url.origin}/storage/veo_1.mp4` },
          })
        return new Response(MP4_BYTES, { status: 200 })
      },
    })
    try {
      // 真实 transport：跟随重定向是它的行为，桩替换不掉。
      setUpstreamFetchForTesting()
      _setChannelsForTesting([
        { ...veoVideoChannel, baseUrl: `http://127.0.0.1:${server.port}/v1beta` },
      ])

      const { payload } = await run(VEO_MODEL, { video: video({ duration_seconds: 4 }) })

      const data = (payload as { data: Array<Record<string, unknown>> }).data
      expect(Buffer.from(String(data[0]?.b64_json), 'base64').equals(Buffer.from(MP4_BYTES))).toBe(
        true,
      )
      expect(seen.at(-1)).toEqual({ path: '/storage/veo_1.mp4', key: 'veo-test-key' })
    } finally {
      server.stop(true)
    }
  })
})
