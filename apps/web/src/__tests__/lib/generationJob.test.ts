import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PrivateOverlay from '../../lib/privateOverlay'

// 结算通知是这条链路的出站口：它有没有被发出去就是「余额刷不刷新」本身。
// 门禁与 callImageApi 一律用真的，只有这三个出站通知换成探针。
const overlay = vi.hoisted(() => ({
  accepted: vi.fn(),
  errored: vi.fn(),
  settled: vi.fn(),
}))
vi.mock('../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof PrivateOverlay>()),
  notifyPrivateSubmissionAccepted: overlay.accepted,
  notifyPrivateSubmissionError: overlay.errored,
  notifyPrivateSubmissionSettled: overlay.settled,
}))

import { setSignedIn, subscribeLoginPrompt } from '../../auth/loginPrompt'
import { DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from '../../lib/apiProfiles'
import { setChannels } from '../../lib/channels/channelStore'
import type { ChannelCapability, PublicChannel } from '../../lib/channels/types'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
import {
  type GenerationFailure,
  type GenerationReference,
  type GenerationSink,
  type GenerationUnit,
  resumeGeneration,
  startGeneration,
} from '../../lib/generationJob'
import { type AppSettings, DEFAULT_PARAMS } from '../../types'
import { allCapabilitiesOff } from '../fixtures/capabilities'

/** builtin-edge 队列的一整轮：submit → status → result meta → 二进制。 */
function stubQueueFlow(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.endsWith('/submit'))
      return Response.json({ request_id: 'rid-1', status: 'queued', submitted_at: 0 })
    if (url.endsWith('/status'))
      return Response.json({ request_id: 'rid-1', status: 'completed', submitted_at: 0 })
    if (/\/image\/\d+$/.test(url))
      return new Response(Uint8Array.from([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
    if (url.includes('/v1/queue/requests/'))
      return Response.json({
        request_id: 'rid-1',
        status: 'completed',
        images: [{ index: 0, mime: 'image/png' }],
      })
    throw new Error(`unexpected fetch in test: ${url}`)
  })
}

/**
 * 发出去就不回来的队列。扇出只看「开了几条、每条带什么」，这些断言在第一个 await 之前
 * 就成立；让请求悬着，用例之间不会互相灌结算通知。
 */
function stubHangingQueue(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}))
}

function channelWith(capabilities: ChannelCapability[]): PublicChannel {
  return {
    id: 'queue-channel',
    kind: 'openai-queue',
    label: 'Queue',
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities }],
    defaults: { apiMode: 'images', timeout: 600 },
  }
}

function builtinSettings(channel: PublicChannel): AppSettings {
  setChannels([channel])
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [
      {
        id: channel.id,
        source: 'builtin-edge',
        channelId: channel.id,
        selectedModelId: channel.models[0]!.id,
      },
    ],
    activeProfileId: channel.id,
  })
}

/** 宿主替身：只记下 module 隔着 seam 说了什么。 */
function recordingSink() {
  const opened: GenerationUnit<string>[] = []
  const references: GenerationReference[] = []
  const delivered: string[][] = []
  const failures: GenerationFailure[] = []
  const sink: GenerationSink<number, string> = {
    open(unit) {
      opened.push(unit)
      return opened.length - 1
    },
    accepted(_handle, reference) {
      references.push(reference)
    },
    progress() {},
    delivered(_handle, result) {
      delivered.push(result.images)
    },
    failed(_handle, failure) {
      failures.push(failure)
    },
  }
  return { sink, opened, references, delivered, failures }
}

beforeEach(async () => {
  await bootstrapClientCapabilities(false, '')
  setSignedIn(true)
  overlay.accepted.mockClear()
  overlay.errored.mockClear()
  overlay.settled.mockClear()
})

afterEach(async () => {
  vi.restoreAllMocks()
  setChannels([])
  await bootstrapClientCapabilities(false, '')
})

describe('扇出规则只有一份', () => {
  it('模型声明了原生 n：整批交给上游一条请求', async () => {
    const settings = builtinSettings(channelWith(['generate', 'n']))
    stubHangingQueue()
    const { sink, opened } = recordingSink()

    startGeneration(
      {
        settings,
        profile: getActiveApiProfile(settings),
        params: { ...DEFAULT_PARAMS, n: 4 },
        variants: [{ prompt: '一只猫', inputImageDataUrls: [], context: 'a' }],
      },
      sink,
    )

    expect(opened).toHaveLength(1)
    expect(opened[0]!.params.n).toBe(4)
  })

  it('模型没声明原生 n：按份拆成多条，每条 n=1、幂等键各自唯一', async () => {
    const settings = builtinSettings(channelWith(['generate']))
    stubHangingQueue()
    const { sink, opened } = recordingSink()

    startGeneration(
      {
        settings,
        profile: getActiveApiProfile(settings),
        params: { ...DEFAULT_PARAMS, n: 3 },
        variants: [{ prompt: '一只猫', inputImageDataUrls: [], context: 'a' }],
      },
      sink,
    )

    expect(opened.map((unit) => unit.params.n)).toEqual([1, 1, 1])
    expect(new Set(opened.map((unit) => unit.clientRequestId)).size).toBe(3)
  })

  it('计费内置渠道：整批合成一条 BFF 任务，让积分预留覆盖整批', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ ...allCapabilitiesOff(), 'billing:credits': true }))
    await bootstrapClientCapabilities(true, '')
    fetchMock.mockRestore()
    const settings = builtinSettings(channelWith(['generate']))
    stubHangingQueue()
    const { sink, opened } = recordingSink()

    startGeneration(
      {
        settings,
        profile: getActiveApiProfile(settings),
        params: { ...DEFAULT_PARAMS, n: 3 },
        variants: [{ prompt: '一只猫', inputImageDataUrls: [], context: 'a' }],
      },
      sink,
    )

    expect(opened).toHaveLength(1)
    expect(opened[0]!.params.n).toBe(3)
  })
})

describe('受理与结算通知', () => {
  it('submit 被受理：队列号交给宿主落盘，顶栏跟着知道有一次预扣', async () => {
    const settings = builtinSettings(channelWith(['generate']))
    stubQueueFlow()
    const { sink, references, delivered } = recordingSink()

    startGeneration(
      {
        settings,
        profile: getActiveApiProfile(settings),
        params: { ...DEFAULT_PARAMS, n: 1 },
        variants: [{ prompt: '一只猫', inputImageDataUrls: [], context: 'a' }],
      },
      sink,
    )
    await vi.waitFor(() => expect(delivered).toHaveLength(1))

    expect(references).toEqual([{ kind: 'queue', requestId: 'rid-1' }])
    expect(overlay.accepted).toHaveBeenCalledTimes(1)
    expect(overlay.settled).toHaveBeenCalledTimes(1)
  })
})

describe('刷新后续跑与首次提交同一套收尾', () => {
  /** 续跑这一条只会走 status，成功与失败都在那一响里定。 */
  function stubResumeStatus(status: Record<string, unknown>): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.endsWith('/status')) return Response.json({ request_id: 'rid-1', ...status })
      throw new Error(`unexpected fetch in test: ${url}`)
    })
  }

  it('内容安全拒绝：交给宿主的是可行动的那句，不是上游原文', async () => {
    const settings = builtinSettings(channelWith(['generate']))
    stubResumeStatus({
      status: 'failed',
      submitted_at: 0,
      error: { message: 'rejected by our safety system', type: 'content_policy' },
    })
    const { sink, failures } = recordingSink()

    await resumeGeneration(
      { settings, prompt: '一只猫', params: { ...DEFAULT_PARAMS }, requestId: 'rid-1' },
      0,
      sink,
    )

    expect(failures[0]!.code).toBe('content_policy')
    expect(failures[0]!.text).toContain('内容审核')
    expect(failures[0]!.text).not.toContain('safety system')
  })

  it('续跑落地也结算：出错与结束的通知都要发，否则余额停在续跑之前那一份', async () => {
    const settings = builtinSettings(channelWith(['generate']))
    stubResumeStatus({
      status: 'failed',
      submitted_at: 0,
      error: { message: '上游炸了', type: 'upstream_error' },
    })
    const { sink } = recordingSink()

    await resumeGeneration(
      { settings, prompt: '一只猫', params: { ...DEFAULT_PARAMS }, requestId: 'rid-1' },
      0,
      sink,
    )

    expect(overlay.errored).toHaveBeenCalledTimes(1)
    expect(overlay.settled).toHaveBeenCalledTimes(1)
  })
})

describe('门禁', () => {
  it('内置渠道没账号：一条也不开，只弹登录框', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ ...allCapabilitiesOff(), 'accounts:login': true }))
    await bootstrapClientCapabilities(true, '')
    fetchMock.mockRestore()
    setSignedIn(false)
    const settings = builtinSettings(channelWith(['generate']))
    stubHangingQueue()
    const { sink, opened } = recordingSink()
    // 这个文件跑在 node 环境里，登录框事件要有个 window 才发得出去。
    vi.stubGlobal('window', new EventTarget())
    const prompted = vi.fn()
    const unsubscribe = subscribeLoginPrompt(prompted)

    try {
      startGeneration(
        {
          settings,
          profile: getActiveApiProfile(settings),
          params: { ...DEFAULT_PARAMS, n: 1 },
          variants: [{ prompt: '一只猫', inputImageDataUrls: [], context: 'a' }],
        },
        sink,
      )
    } finally {
      unsubscribe()
      vi.unstubAllGlobals()
    }

    expect(prompted.mock.calls).toEqual([['gated-action']])
    expect(opened).toEqual([])
  })
})
