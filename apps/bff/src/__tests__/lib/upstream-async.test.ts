import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import {
  jsonResponse as json,
  type RecordingUpstream,
  recordingUpstreamFetch,
} from '../helpers/upstreamStubs'

// Inject before importing config, which captures process environment at module initialization.
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.UPSTREAM_ASYNC_IMAGE_TASKS = 'true'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const {
  callUpstream,
  setAsyncPollBackoffForTesting,
  setUpstreamFetchForTesting,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} = await import('../../lib/upstream')
const { _setChannelsForTesting } = await import('../../lib/channels')
type InternalChannel = import('../../lib/channels').InternalChannel

const grokChannel = (asyncTasks: boolean): InternalChannel => ({
  id: 'grok-images',
  kind: 'openai-queue',
  label: 'Grok Imagine Image',
  baseUrl: 'https://gateway.example/v1',
  auth: { type: 'bearer', secretRef: 'GROK_API_KEY', secret: 'grok-test-key' },
  allowedPaths: ['images/generations', 'images/edits'],
  models: [{ id: 'grok-imagine-image', label: 'Grok', capabilities: ['generate', 'n'] }],
  defaults: { apiMode: 'images', timeout: 600, asyncTasks },
})

const COMPLETED_BODY = {
  task_id: 'imgtask_1',
  status: 'completed',
  result: { created: 1, data: [{ url: 'https://bucket.example/a.png' }] },
}

let upstream: RecordingUpstream

/** Answers a submit with the given task id and every poll with a terminal completion. */
function submitThenComplete(taskId = 'imgtask_1'): (url: string) => Response {
  return (url) =>
    url.endsWith('/async')
      ? json({ task_id: taskId, status: 'processing', poll_url: `/v1/images/tasks/${taskId}` }, 202)
      : json({ ...COMPLETED_BODY, task_id: taskId })
}

const grokRequest = { provider: 'openai-compat', model: 'grok-imagine-image' } as const

beforeEach(() => {
  _setChannelsForTesting([grokChannel(true)])
  upstream = recordingUpstreamFetch()
  upstream.handler = submitThenComplete()
  setUpstreamFetchForTesting(upstream.fetch)
  // 真实退避一次重试就是 3 秒实睡，整个套件为一个断言等 6 秒。
  setAsyncPollBackoffForTesting([0])
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setAsyncPollBackoffForTesting()
  _setChannelsForTesting([])
})

describe('async submit', () => {
  it('submits to the async endpoint and polls the task until it completes', async () => {
    const result = await callUpstream({ ...grokRequest, request: { prompt: 'a cat' } })

    expect(upstream.calls).toEqual([
      'https://gateway.example/v1/images/generations/async',
      'https://gateway.example/v1/images/tasks/imgtask_1',
    ])
    expect(result.payload).toEqual(COMPLETED_BODY.result)
  })

  it('edits go to the async edits endpoint', async () => {
    await callUpstream({
      ...grokRequest,
      request: { prompt: 'a cat', input_images: ['data:image/png;base64,AAAA'] },
    })

    expect(upstream.calls[0]).toBe('https://gateway.example/v1/images/edits/async')
  })

  it('persists the task id before the first poll', async () => {
    const order: string[] = []
    upstream.handler = (url) => {
      order.push(url.endsWith('/async') ? 'submit' : 'poll')
      return submitThenComplete()(url)
    }

    await callUpstream({
      ...grokRequest,
      request: { prompt: 'a cat' },
      onUpstreamTaskIds: async (taskIds) => {
        order.push(`persist:${taskIds.join(',')}`)
      },
    })

    expect(order).toEqual(['submit', 'persist:imgtask_1', 'poll'])
  })

  it('does not resubmit after a failed submit: an unpaid retry is the caller decision', async () => {
    upstream.handler = () => json({ error: { message: 'gateway exploded' } }, 500)

    await expect(
      callUpstream({ ...grokRequest, request: { prompt: 'a cat' } }),
    ).rejects.toMatchObject({ upstreamStatus: 500 })
    expect(upstream.calls).toHaveLength(1)
  })

  it('treats a 202 without a task_id as an unknown result rather than a retryable failure', async () => {
    upstream.handler = () => json({ id: 'imgtask_1', status: 'processing' }, 202)

    await expect(
      callUpstream({ ...grokRequest, request: { prompt: 'a cat' } }),
    ).rejects.toBeInstanceOf(UpstreamResultUnknownError)
  })

  it('flags a gateway with async tasks switched off instead of falling back', async () => {
    upstream.handler = () =>
      json(
        { error: { code: 'not_found_error', message: 'async image tasks are not enabled' } },
        404,
      )

    await expect(
      callUpstream({ ...grokRequest, request: { prompt: 'a cat' } }),
    ).rejects.toMatchObject({ upstreamStatus: 404 })
    // 只发了提交那一次：没有静默回落到同步端点。
    expect(upstream.calls).toEqual(['https://gateway.example/v1/images/generations/async'])
  })

  it('fans out the requested image count into one upstream task each', async () => {
    let submitted = 0
    upstream.handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: `imgtask_${++submitted}` }, 202)
        : json({
            status: 'completed',
            result: { data: [{ url: `https://bucket.example/${url.split('/').pop()}.png` }] },
          })

    const persisted: string[][] = []
    const result = await callUpstream({
      ...grokRequest,
      request: { prompt: 'a cat', n: 2 },
      onUpstreamTaskIds: async (taskIds) => {
        persisted.push([...taskIds])
      },
    })

    expect(persisted).toEqual([['imgtask_1', 'imgtask_2']])
    expect((result.payload as { data: unknown[] }).data).toHaveLength(2)
  })

  it('persists the ids it did get when only part of the fan-out submits', async () => {
    let submitted = 0
    upstream.handler = (url) => {
      if (!url.endsWith('/async')) return json(COMPLETED_BODY)
      return ++submitted === 1
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({ error: { message: 'nope' } }, 500)
    }

    const persisted: string[][] = []
    await expect(
      callUpstream({
        ...grokRequest,
        request: { prompt: 'a cat', n: 2 },
        onUpstreamTaskIds: async (taskIds) => {
          persisted.push([...taskIds])
        },
      }),
    ).rejects.toMatchObject({ upstreamStatus: 500 })

    expect(persisted).toEqual([['imgtask_1']])
  })
})

describe('shortfall resubmit', () => {
  it('submits only the ids it never got and polls the ones it already has', async () => {
    upstream.handler = (url) =>
      url.endsWith('/async') ? json({ task_id: 'imgtask_2' }, 202) : json(COMPLETED_BODY)

    const persisted: string[][] = []
    const result = await callUpstream({
      ...grokRequest,
      request: { prompt: 'a cat', n: 2 },
      resume: { taskIds: ['imgtask_1'], submittedAt: Date.now() },
      onUpstreamTaskIds: async (taskIds) => {
        persisted.push([...taskIds])
      },
    })

    expect(upstream.calls.filter((url) => url.endsWith('/async'))).toHaveLength(1)
    expect(persisted).toEqual([['imgtask_1', 'imgtask_2']])
    expect(upstream.calls).toContain('https://gateway.example/v1/images/tasks/imgtask_1')
    expect(upstream.calls).toContain('https://gateway.example/v1/images/tasks/imgtask_2')
    expect((result.payload as { data: unknown[] }).data).toHaveLength(2)
  })

  it('submits nothing when every id is already stored', async () => {
    await callUpstream({
      ...grokRequest,
      request: { prompt: 'a cat', n: 2 },
      resume: { taskIds: ['imgtask_1', 'imgtask_2'], submittedAt: Date.now() },
    })

    expect(upstream.calls.filter((url) => url.endsWith('/async'))).toHaveLength(0)
  })
})

describe('async polling', () => {
  it('keeps polling through a 5xx and through a status it does not recognise', async () => {
    const bodies: Array<() => Response> = [
      () => json({ task_id: 'imgtask_1' }, 202),
      () => json({ error: { message: 'busy' } }, 503),
      () => json({ status: 'queued_upstream' }),
      () => json(COMPLETED_BODY),
    ]
    upstream.handler = () => bodies.shift()!()

    const result = await callUpstream({ ...grokRequest, request: { prompt: 'a cat' } })

    expect(upstream.calls).toHaveLength(4)
    expect(result.payload).toEqual(COMPLETED_BODY.result)
  })

  it('surfaces a terminal upstream failure with its http status so retry policy can judge it', async () => {
    upstream.handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({
            status: 'failed',
            http_status: 400,
            error: { message: 'Request blocked by upstream content policy' },
          })

    await expect(
      callUpstream({ ...grokRequest, request: { prompt: 'a cat' } }),
    ).rejects.toMatchObject({
      upstreamStatus: 400,
      message: 'Request blocked by upstream content policy',
    })
  })

  it('maps a hard timeout that lands during the backoff sleep to UpstreamTimeoutError', async () => {
    // 真实退避下轮询大部分时间在 sleep，所以这是硬超时的主路径。
    setAsyncPollBackoffForTesting([200])
    const submittedAt = Date.now() - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 60
    upstream.handler = () => json({ status: 'processing' })

    await expect(
      callUpstream({
        ...grokRequest,
        request: { prompt: 'a cat' },
        resume: { taskIds: ['imgtask_9'], submittedAt },
      }),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError)
  })

  it('reads a completed result that is flattened onto the response root', async () => {
    upstream.handler = (url) =>
      url.endsWith('/async')
        ? json({ task_id: 'imgtask_1' }, 202)
        : json({ status: 'completed', data: [{ url: 'https://bucket.example/a.png' }] })

    const result = await callUpstream({ ...grokRequest, request: { prompt: 'a cat' } })

    expect((result.payload as { data: unknown[] }).data).toHaveLength(1)
  })
})

describe('resume', () => {
  it('polls the stored ids without submitting again, even with async switched off', async () => {
    _setChannelsForTesting([grokChannel(false)])

    const result = await callUpstream({
      ...grokRequest,
      request: { prompt: 'a cat' },
      resume: { taskIds: ['imgtask_9'], submittedAt: Date.now() },
    })

    expect(upstream.calls).toEqual(['https://gateway.example/v1/images/tasks/imgtask_9'])
    expect(result.payload).toEqual(COMPLETED_BODY.result)
  })

  it('gives up without any request once the deadline anchored at submit time has passed', async () => {
    await expect(
      callUpstream({
        ...grokRequest,
        request: { prompt: 'a cat' },
        resume: {
          taskIds: ['imgtask_9'],
          submittedAt: Date.now() - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS - 1,
        },
      }),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError)
    expect(upstream.calls).toEqual([])
  })

  it('never counts a poll as an upstream invocation', async () => {
    let invocations = 0
    await callUpstream({
      ...grokRequest,
      request: { prompt: 'a cat' },
      resume: { taskIds: ['imgtask_9'], submittedAt: Date.now() },
      beforeRequest: async () => {
        invocations += 1
      },
    })

    expect(invocations).toBe(0)
  })
})

describe('declaration', () => {
  it('keeps a channel that did not declare async on the synchronous endpoint', async () => {
    _setChannelsForTesting([grokChannel(false)])
    upstream.handler = () => json({ data: [{ b64_json: 'ok' }] })

    await callUpstream({ ...grokRequest, request: { prompt: 'a cat' } })

    expect(upstream.calls).toEqual(['https://gateway.example/v1/images/generations'])
  })

  it('routes the shared gateway through async when the deployment env declares it', async () => {
    _setChannelsForTesting([])

    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat' },
    })

    expect(upstream.calls[0]).toBe('http://localhost:9999/v1/images/generations/async')
  })
})
