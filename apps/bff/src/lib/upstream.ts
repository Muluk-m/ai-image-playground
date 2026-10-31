import { Buffer } from 'node:buffer'
import {
  buildAspectInstruction,
  isGptDirectModel,
  QUEUE_TIMEOUTS,
  type QueueProvider,
  unshapeQueuePrompt,
} from '@image-playground/shared'
import { config } from '../config'
import { disabledModelChannel, getRoutableChannels, type InternalChannel } from './channels'
import type { HydratedSubmitRequest } from './imageArchive'
import { log } from './logger'
import {
  buildImageResponsesBody,
  ImageResponsesError,
  readImageResponses,
} from './openaiImageResponses'
import { resolveApiKey } from './resolveApiKey'
import {
  createDispatcher,
  createFetchSlot,
  startDeadline,
  type UndiciFetchInit,
  type UndiciFetchInput,
} from './timeoutFetch'
import {
  type AsyncTaskProtocol,
  asyncTaskFailure,
  imageTaskProtocol,
  isRecoverablePollFailure,
  warnIfAsyncTasksDisabled,
} from './upstream/async-tasks'
import { acquireChannelSlot } from './upstream/concurrency'
import {
  extractErrorMessage,
  stringifyUpstreamPayload,
  UpstreamPartialResultError,
  UpstreamQueueTimeoutError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './upstream/errors'
import { buildGeminiBody, mergeGeminiCandidateResults } from './upstream/gemini'
import { recordDirectUsage } from './upstream/gpt-budget'
import {
  directAvailableNow,
  firstGptRoute,
  type GptRoute,
  gptDirectConfigured,
  recordSub2apiOutcome,
  sub2apiBreakerOpen,
} from './upstream/gpt-routing'
import {
  buildGrokEditBody,
  buildGrokImagine2Body,
  isGrokImagine2,
  normalizeGrokEditInputs,
  normalizeGrokImagine2EditInputs,
} from './upstream/grok'
import {
  buildAgnesGenerationsBody,
  buildOpenAIBody,
  buildOpenAIEditFormData,
  isGptImageModel,
  mergeOpenAIDataResults,
  mergeOpenAIImageResults,
  withoutImageCount,
  withoutModeration,
} from './upstream/openai'
import { withPartialFailure } from './upstream/partial'
import {
  gptSchedulerBuckets,
  type SchedulerBucket,
  type SchedulerLease,
  waitForSchedulerSlots,
} from './upstream/scheduler'
import { type ChannelRouteStyle, clientError, type UpstreamCallResult } from './upstream/shared'
import {
  buildVertexBody,
  isRateLimited,
  modelFallbackRecord,
  VertexTimeCapError,
  withVertexRateLimitRetry,
} from './upstream/vertex'
import { VIDEO_MIME, VIDEO_STYLE_SPECS } from './upstream/video'

/*
 * 把排队任务发给上游：按 channel 路由、硬超时、计费回调、fan-out、异步任务的提交与恢复。
 * 各服务商的请求体、结果解析与异步任务协议在 `./upstream/` 下。BFF 不翻译模型参数。
 */

const CHANNEL_ROUTE_STYLES: Readonly<Record<string, ChannelRouteStyle | undefined>> = {
  'agnes-images': 'agnes-generations-json',
  'grok-images': 'grok-openai-images',
  'grok-video': 'grok-videos',
  'agnes-video': 'agnes-videos',
  'ark-video': 'ark-videos',
  'veo-video': 'veo-videos',
  'vertex-images': 'vertex-generate-content',
}

/** 只认自有键：channel id 只校验 kebab-case，`constructor` 这类合法 id 不能命中原型属性。 */
function channelRouteStyle(channelId: string): ChannelRouteStyle | undefined {
  return Object.hasOwn(CHANNEL_ROUTE_STYLES, channelId)
    ? CHANNEL_ROUTE_STYLES[channelId]
    : undefined
}

interface UpstreamRoute {
  baseUrl: string
  key: string
  /** openai-compat 分支的协议风格（gemini 分支不看这个字段）。 */
  style: ChannelRouteStyle
  /** channel 声明只接受 base64 结果（gemini 分支不看这个字段）。 */
  forceB64Json: boolean
  /** 模型声明了 moderation 能力；未声明的剥掉再发，别赌上游会忽略未知字段。 */
  supportsModeration: boolean
  /** 上游提供 sub2api 风格的异步图片任务端点。 */
  asyncTasks: boolean
  /** 上游原生支持 n；一条请求即可返回多张图，不应在 BFF 内 fan-out。 */
  supportsNativeN: boolean
  /**
   * 声明了同时在途上限时排队的键与上限：模型级（`models[].maxConcurrency`）按「渠道/模型」
   * 排，否则渠道级（`maxConcurrency`）按渠道排。
   */
  concurrency?: { channelId: string; limit: number }
  /** 模型声明支持的分辨率档位（`ChannelModel.imageSizes`）；Vertex 分支把其它档位换成最近一档。 */
  imageSizes?: readonly string[]
  /** 每条上游请求发出前要在跨 worker 配额上占的桶（见 upstream/scheduler.ts）；空即不限。 */
  schedulerBuckets?: readonly SchedulerBucket[]
  /** GPT Image 走的是哪条通道；决定发送前的参数适配（见 {@link adaptGptRequest}）。 */
  gptRoute?: GptRoute
  /** 直连可选的 OpenAI-Organization 头。 */
  organization?: string
}

/** 模型级上限优先，按「渠道/模型」各排各的队；没有再看渠道级上限。 */
function concurrencyFor(
  channel: InternalChannel,
  modelId: string,
): Pick<UpstreamRoute, 'concurrency'> {
  const perModel = channel.modelMaxConcurrency
  if (perModel && Object.hasOwn(perModel, modelId))
    return { concurrency: { channelId: `${channel.id}/${modelId}`, limit: perModel[modelId]! } }
  return channel.maxConcurrency
    ? { concurrency: { channelId: channel.id, limit: channel.maxConcurrency } }
    : {}
}

/**
 * 这个模型在 BFF 里受哪个同时在途上限管（`models[].maxConcurrency` 或渠道级 `maxConcurrency`），
 * 以及同一个上限下有哪些模型。没有声明上限时给 undefined。调度器的空闲并发判定用它，
 * 确保弹性名额不会让同一个上限下正在跑的任务数超过上限（例如 Vertex 每个模型 2）。
 */
export function taskConcurrencyScope(
  provider: QueueProvider,
  model: string,
): { models: string[]; limit: number } | undefined {
  const kind = provider === 'gemini' ? 'gemini-queue' : 'openai-queue'
  for (const channel of getRoutableChannels()) {
    if (!channelRouteStyle(channel.id) || channel.kind !== kind) continue
    const declared = declaredChannelModel(channel, model)
    if (!declared) continue
    const perModel = channel.modelMaxConcurrency
    if (perModel && Object.hasOwn(perModel, declared.id))
      return { models: withLegacyAliases(channel, [declared.id]), limit: perModel[declared.id]! }
    if (!channel.maxConcurrency) return undefined
    const shared = channel.models
      .map((m) => m.id)
      .filter((id) => !(perModel && Object.hasOwn(perModel, id)))
    return { models: withLegacyAliases(channel, shared), limit: channel.maxConcurrency }
  }
  return undefined
}

/** 从发现清单退役、旧队列任务仍落到原渠道某个声明模型上的模型名：渠道 → 旧名 → 声明模型。 */
const LEGACY_MODEL_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'grok-video': { 'grok-imagine-video': 'grok-imagine-video-1.5-lite' },
}

/** 渠道里承接这个模型名的声明模型；退役旧名按 LEGACY_MODEL_ALIASES 落到原线路。 */
function declaredChannelModel(channel: InternalChannel, model: string) {
  const exact = channel.models.find((m) => m.id === model)
  if (exact) return exact
  const target = LEGACY_MODEL_ALIASES[channel.id]?.[model]
  return target ? channel.models.find((m) => m.id === target) : undefined
}

/** 同一上限下的模型清单补上落到这些模型的退役旧名，在途计数才算得到旧队列任务。 */
function withLegacyAliases(channel: InternalChannel, ids: string[]): string[] {
  const aliases = Object.entries(LEGACY_MODEL_ALIASES[channel.id] ?? {})
    .filter(([legacy, target]) => ids.includes(target) && !ids.includes(legacy))
    .map(([legacy]) => legacy)
  return aliases.length ? [...ids, ...aliases] : ids
}

/**
 * provider + model → 上游 baseUrl、API key 与协议风格。
 * 返回的 baseUrl 统一**含版本段**（如 .../v1、.../v1beta），调用方拼相对路径，
 * 杜绝 channel baseUrl（含版本段）与 env baseUrl（不含）两套约定打架拼出 /v1/v1。
 * 未命中 CHANNEL_ROUTE_STYLES 的走 UPSTREAM_BASE_URL 通用网关 + 标准 OpenAI 协议。
 */
function resolveUpstream(provider: QueueProvider, model: string): UpstreamRoute {
  const kind = provider === 'gemini' ? 'gemini-queue' : 'openai-queue'
  // 含下线的 channel：下线前已提交的任务还要回原上游续轮询；新任务在提交入口就被拒了。
  for (const channel of getRoutableChannels()) {
    const style = channelRouteStyle(channel.id)
    if (!style || channel.kind !== kind) continue
    // 从发现清单退役后，旧队列任务仍要在原 Grok 线路提交或续轮询。
    const declared = declaredChannelModel(channel, model)
    if (!declared) continue
    return {
      baseUrl: channel.baseUrl,
      key: channel.auth.secret,
      style,
      forceB64Json: provider === 'openai-compat' && channel.defaults.responseFormatB64Json === true,
      supportsModeration: declared.capabilities.includes('moderation'),
      asyncTasks: provider === 'openai-compat' && channel.defaults.asyncTasks === true,
      supportsNativeN: provider === 'openai-compat' && declared.capabilities.includes('n'),
      ...concurrencyFor(channel, declared.id),
      ...(declared.imageSizes ? { imageSizes: declared.imageSizes } : {}),
    }
  }
  // 下线的直连模型找不到原 channel（env 缺失）时明确失败：通用网关不是它的上游，兜底过去
  // 只会用另一套 key 打一条错的请求。普通 Error 不可重试，任务直接进终态 failed。
  // 本来就走通用网关的（如 gemini-flash-image）不受影响。
  const retiredChannel = disabledModelChannel(model)
  if (retiredChannel && channelRouteStyle(retiredChannel))
    throw new Error(
      `model '${model}' belongs to disabled channel '${retiredChannel}', which cannot be routed`,
    )
  const version = provider === 'gemini' ? 'v1beta' : 'v1'
  return {
    baseUrl: `${config.upstream.baseUrl}/${version}`,
    key: resolveApiKey(provider),
    style: 'openai-images',
    forceB64Json: false,
    supportsModeration: true,
    asyncTasks: provider === 'openai-compat' && config.upstream.asyncImageTasks,
    // 通用网关未声明原生多图能力；模型名不能证明当前上游会兑现 n。
    supportsNativeN: false,
    ...(provider === 'openai-compat' && isGptImageModel(model)
      ? { schedulerBuckets: gptSchedulerBuckets(model, 'sub2api'), gptRoute: 'sub2api' as const }
      : {}),
  }
}

/** GPT Image 的 OpenAI 直连：原生 size / quality / n，同步返回，不走异步任务与 Responses。 */
function directRoute(model: string): UpstreamRoute {
  return {
    baseUrl: config.gptDirect.baseUrl,
    key: config.gptDirect.apiKey,
    style: 'openai-images',
    forceB64Json: false,
    supportsModeration: true,
    asyncTasks: false,
    supportsNativeN: true,
    schedulerBuckets: gptSchedulerBuckets(model, 'direct'),
    gptRoute: 'direct',
    ...(config.gptDirect.organization ? { organization: config.gptDirect.organization } : {}),
  }
}

/**
 * 同一单按通道改参数。sub2api（Codex 图片路径）丢弃 size 与 quality，只认提示词里写明的构图，
 * 所以补上构图句；直连认原生参数，把提交时钉上的机器指令（防改写前缀、构图句）剥掉，auto 画质
 * 改发 medium（auto 可能出高画质，成本没有上限，计价也按 medium）。
 */
function adaptGptRequest(
  route: GptRoute,
  model: string,
  request: HydratedSubmitRequest,
): HydratedSubmitRequest {
  if (!isGptDirectModel(model)) return request
  if (route === 'direct') {
    const prompt = unshapeQueuePrompt({
      provider: 'openai-compat',
      prompt: request.prompt,
      ...(request.size ? { size: request.size } : {}),
    })
    const quality = !request.quality || request.quality === 'auto' ? 'medium' : request.quality
    return { ...request, prompt, quality }
  }
  const instruction = request.size ? buildAspectInstruction(request.size) : null
  if (!instruction || request.prompt.endsWith(instruction)) return request
  return { ...request, prompt: `${request.prompt}\n\n${instruction}` }
}

export interface UpstreamCallParams {
  /** New producers must preserve any unknown branch, irrespective of rejection order. */
  reconciliationRequired?: boolean
  /** 任务 id，只用于 OpenAI 直连的成本记账。 */
  taskId?: string
  /** 账号是会员：GPT Image 默认走 OpenAI 直连（见 upstream/gpt-routing.ts）。 */
  gptMember?: boolean
  /** GPT Image 每条路开跑前调用（换路时再调一次）；调用方据此记下最后走的通道，结算用。 */
  onGptRoute?: (route: GptRoute) => Promise<void>
  provider: QueueProvider
  model: string
  request: HydratedSubmitRequest
  signal?: AbortSignal
  /** Runs immediately before each upstream invocation is dispatched. Polling does not count. */
  beforeRequest?: () => Promise<string | void>
  onRequestDispatched?: (dispatchId: string) => Promise<void>
  onRequestId?: (dispatchId: string, requestId: string) => Promise<void>
  onUpstreamTaskId?: (dispatchId: string, taskId: string) => Promise<void>
  /** 异步提交拿到 id 后、开始轮询**之前**调用；必须在这一步之内把 id 持久化。 */
  onUpstreamTaskIds?: (taskIds: readonly string[]) => Promise<void>
  /** 本任务已提交过的上游异步任务：这些 id 只轮询，永不重提。 */
  resume?: UpstreamResume
  /**
   * Vertex 单张退避用完仍 429 时补这一张的模型（调用方已排除停用的与原模型本身）。
   * 只在它同走 Vertex 直连时生效，见 {@link resolveVertexFallback}。
   */
  rateLimitFallbackModel?: string
  /**
   * 原模型的总时限（epoch 毫秒，调用方从任务提交时刻算起，含排队）。到点还在排原模型的队、
   * 或下一次退避会越过它，这一张直接改用回落模型；已发出的请求不掐断（上游可能已经在出图）。
   * 没有回落模型时不生效。
   */
  rateLimitFallbackAt?: number
}

export interface UpstreamResume {
  readonly pollOnly?: boolean
  readonly taskIds: readonly string[]
  /** 已派发的请求数；路由升级不能把旧 fan-out 的缺失提交认成完整原生批次。 */
  readonly invocationCount?: number
  /** 首次提交时刻，超时预算的锚点；重启不能重新发一份完整预算。 */
  readonly submittedAt: number
}

interface UpstreamResponse {
  readonly ok: boolean
  readonly headers?: { get(name: string): string | null }
  readonly status: number
  readonly body?: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

type UpstreamFetch = (input: UndiciFetchInput, init?: UndiciFetchInit) => Promise<UpstreamResponse>

type UpstreamFetchInit = UndiciFetchInit

export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000

export const UPSTREAM_TRANSPORT_TIMEOUT_MS = QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 60_000

const upstreamDispatcher = createDispatcher({
  connectMs: UPSTREAM_CONNECT_TIMEOUT_MS,
  transportMs: UPSTREAM_TRANSPORT_TIMEOUT_MS,
})

const upstreamTransport = createFetchSlot<UpstreamFetch>()

export function setUpstreamFetchForTesting(fetchImpl?: UpstreamFetch): void {
  upstreamTransport.set(fetchImpl)
}

/**
 * 正常终止统一由下方的 deadline 决定。Bun 自带的 300 秒 fetch 超时在 transport 那一层关掉
 * （`timeoutFetch.ts` 的 withoutRuntimeTimeout）；Agent 的 headers/body 超时比应用硬超时长 1min，
 * 只在 Node 下生效，作兜底。
 */
/** 换路前至少要剩这么多时间，否则换过去也来不及出图。 */
const GPT_FAILOVER_MIN_REMAINING_MS = 60_000
/** 会员选了直连、却在直连额度上排了这么久还没发出，就改走 sub2api。 */
const GPT_DIRECT_QUEUE_WAIT_MS = 5_000

export async function callUpstream(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  const route = resolveUpstream(params.provider, params.model)
  // 已提交过的任务只在原路续轮询；只有走通用网关的 GPT 直连模型才有两条路可选。
  if (
    route.gptRoute !== 'sub2api' ||
    params.resume ||
    params.request.video ||
    !gptDirectConfigured(params.model)
  ) {
    // 提交时直连还开着、执行时已关：高档单也只能走 sub2api，照样记下通道，结算才会按基础档。
    if (route.gptRoute === 'sub2api' && !params.resume && isGptDirectModel(params.model))
      await params.onGptRoute?.('sub2api')
    return callUpstreamVia(params, route)
  }
  return callGptDualRoute(params, route)
}

/**
 * 测试用：跳过选路，直接走 OpenAI 直连这一条（调度器配额、429 冷却照常生效）。
 * `nativeN: false` 模拟逐张 fan-out 的路径（直连的图生图不接受 n，就是这样发的）。
 */
export function _callUpstreamDirectForTesting(
  params: UpstreamCallParams,
  { nativeN = true }: { nativeN?: boolean } = {},
): Promise<UpstreamCallResult> {
  return callUpstreamVia(params, { ...directRoute(params.model), supportsNativeN: nativeN })
}

function gptRouteFor(kind: GptRoute, model: string, sub2api: UpstreamRoute): UpstreamRoute {
  return kind === 'direct' ? directRoute(model) : sub2api
}

function upstreamStatusOf(error: unknown): number | undefined {
  const status = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus
  return typeof status === 'number' ? status : undefined
}

/** 服务端问题（换一条路可能就好）：429、5xx、连接或响应中断。参数错、审核拒绝之类换路也没用。 */
function isRouteFailure(error: unknown): boolean {
  if (error instanceof UpstreamPartialResultError || error instanceof UpstreamQueueTimeoutError)
    return false
  const status = upstreamStatusOf(error)
  if (status !== undefined) return status === 429 || status >= 500
  return error instanceof UpstreamResultUnknownError && !(error instanceof UpstreamTimeoutError)
}

/**
 * GPT Image 两条通道（见 upstream/gpt-routing.ts）：按会员身份选第一条；第一条发出后超过单路时限没结果，
 * 或明确不可用（429、5xx、连接中断），换另一条重试一次，两路共用同一个硬截止。sub2api 异步任务一旦受理
 * 就不换路：结果交给轮询与对账，换过去可能重复出图。用户取消、部分出图、参数错不换路。
 */
async function callGptDualRoute(
  params: UpstreamCallParams,
  sub2api: UpstreamRoute,
): Promise<UpstreamCallResult> {
  const { model, request } = params
  const member = params.gptMember === true
  const deadlineAt = Date.now() + QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS
  const first = await firstGptRoute({ model, member, request })
  const other: GptRoute = first === 'direct' ? 'sub2api' : 'direct'

  /** 换到 other 这条路此刻是否可行：时间够、对方没熔断、直连有额度与预算。 */
  const canSwitch = async (): Promise<boolean> => {
    if (params.signal?.aborted) return false
    if (deadlineAt - Date.now() < GPT_FAILOVER_MIN_REMAINING_MS) return false
    if (other === 'sub2api') return !sub2apiBreakerOpen()
    return directAvailableNow(model, request)
  }

  const run = async (kind: GptRoute, timeoutMs?: number) => {
    const state = {
      dispatched: false,
      asyncAccepted: false,
      timedOut: false,
      reason: 'attempt_timeout' as 'attempt_timeout' | 'direct_queue_full',
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let queueTimer: ReturnType<typeof setTimeout> | undefined
    /** 到点且换得过去才叫停这一路；换不过去就让它继续跑到硬截止，别白白掐掉一条可能快出图的请求。 */
    const switchWhenPossible = (reason: typeof state.reason) => {
      void canSwitch().then((ok) => {
        if (!ok || state.asyncAccepted || controller.signal.aborted) return
        state.timedOut = true
        state.reason = reason
        controller.abort()
      })
    }
    const onDispatched = () => {
      state.dispatched = true
      if (queueTimer) clearTimeout(queueTimer)
      if (timeoutMs === undefined || timer) return
      timer = setTimeout(() => switchWhenPossible('attempt_timeout'), timeoutMs)
      timer.unref?.()
    }
    // 直连额度是选路时探的，真发时可能刚被别的 worker 抢走：在直连桶上排久了也换路，不排到硬截止。
    if (kind === 'direct' && timeoutMs !== undefined) {
      queueTimer = setTimeout(() => {
        if (!state.dispatched) switchWhenPossible('direct_queue_full')
      }, GPT_DIRECT_QUEUE_WAIT_MS)
      queueTimer.unref?.()
    }
    const attemptParams: UpstreamCallParams = {
      ...params,
      onUpstreamTaskIds: async (taskIds) => {
        state.asyncAccepted = true
        await params.onUpstreamTaskIds?.(taskIds)
      },
    }
    try {
      await params.onGptRoute?.(kind)
      const result = await callUpstreamVia(attemptParams, gptRouteFor(kind, model, sub2api), {
        signal: controller.signal,
        deadlineAt,
        onDispatched,
      })
      return { ok: true as const, result, state }
    } catch (error) {
      return { ok: false as const, error, state }
    } finally {
      if (timer) clearTimeout(timer)
      if (queueTimer) clearTimeout(queueTimer)
    }
  }

  const settle = async (
    kind: GptRoute,
    outcome: Awaited<ReturnType<typeof run>>,
  ): Promise<void> => {
    if (kind === 'sub2api') {
      if (outcome.ok) recordSub2apiOutcome(true)
      else if (outcome.state.timedOut || isRouteFailure(outcome.error)) recordSub2apiOutcome(false)
      return
    }
    // 直连按张计费：出了图按回报的 usage 记；发出后结果未知（超时、中断）按档位估算，平台承担。
    // 明确的 HTTP 错误上游不计费，不记。
    if (!outcome.state.dispatched) return
    if (!outcome.ok && upstreamStatusOf(outcome.error) !== undefined) return
    await recordDirectUsage({
      ...(params.taskId ? { taskId: params.taskId } : {}),
      model,
      ...(request.size ? { size: request.size } : {}),
      ...(request.quality ? { quality: request.quality } : {}),
      images: Math.max(1, request.n ?? 1),
      ...(outcome.ok ? { payload: outcome.result.payload } : {}),
    })
  }

  // 直连原生 n 一条请求出 n 张，张数越多越慢：每多一张多给 30 秒。sub2api 逐张并发，不放大。
  const timeoutMs =
    first === 'direct'
      ? config.gptDirect.attemptTimeoutMs + (Math.max(1, request.n ?? 1) - 1) * 30_000
      : config.gptDirect.sub2apiAttemptTimeoutMs
  const firstOutcome = await run(first, timeoutMs)
  await settle(first, firstOutcome)
  if (firstOutcome.ok) return firstOutcome.result

  const { error, state } = firstOutcome
  // 非会员只在 sub2api 超时时借直连；sub2api 报错计入熔断，熔断后的新任务才整单走直连。
  const eligible =
    !params.signal?.aborted &&
    !state.asyncAccepted &&
    (state.timedOut || (isRouteFailure(error) && (first === 'direct' || member)))
  if (!eligible || (!state.timedOut && !(await canSwitch()))) throw error

  log.warn(
    {
      event: 'gpt.route_failover',
      model,
      from: first,
      to: other,
      reason: state.timedOut ? state.reason : 'route_failure',
      upstreamStatus: upstreamStatusOf(error),
    },
    'gpt route failover',
  )
  const secondOutcome = await run(other)
  await settle(other, secondOutcome)
  if (secondOutcome.ok) return secondOutcome.result
  throw secondOutcome.error
}

interface AttemptOptions {
  /** 这一路被换路逻辑叫停（与调用方的 signal 合并：被叫停时按取消原样抛出，由外层改判）。 */
  signal?: AbortSignal
  /** 两路共用的硬截止（epoch 毫秒）；缺席按提交时刻 + 硬超时。 */
  deadlineAt?: number
  /** 每条计数请求通过记账、确实发出时调用。 */
  onDispatched?: () => void
}

async function callUpstreamVia(
  params: UpstreamCallParams,
  route: UpstreamRoute,
  attempt: AttemptOptions = {},
): Promise<UpstreamCallResult> {
  const { provider, model, signal: callerSignal, beforeRequest, onUpstreamTaskIds, resume } = params
  const externalSignal =
    attempt.signal && callerSignal
      ? AbortSignal.any([callerSignal, attempt.signal])
      : (attempt.signal ?? callerSignal)
  const {
    baseUrl: base,
    key,
    style,
    forceB64Json,
    supportsModeration,
    asyncTasks,
    supportsNativeN,
    concurrency,
    imageSizes,
    schedulerBuckets = [],
    gptRoute,
    organization,
  } = route
  let request = gptRoute ? adaptGptRequest(gptRoute, model, params.request) : params.request
  // 原生 n 只适用于无参考图的 Images generations；Responses 图片工具不接受 tools[].n。
  const requestedImageCount = Math.max(1, request.n ?? 1)
  const useNativeN =
    provider === 'openai-compat' &&
    style === 'openai-images' &&
    supportsNativeN &&
    requestedImageCount > 1 &&
    !request.input_images?.length &&
    !request.mask
  // Grok 回的 imgen.x.ai URL 对服务器出口 IP 一律 403（带 Bearer 也 403），归档取不到图。
  if (forceB64Json) {
    request = { ...request, extra: { ...request.extra, response_format: 'b64_json' } }
  }
  if (!supportsModeration) request = withoutModeration(request)

  const deadlineAt =
    attempt.deadlineAt ??
    (resume?.submittedAt ?? Date.now()) + QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS
  // A resumed task may have completed while its worker was unavailable. Give the
  // read-only final lookup a bounded transport window, never a new generation budget.
  const finalLookup = Boolean(resume?.taskIds.length) && Date.now() >= deadlineAt
  const deadline = startDeadline(finalLookup ? 20_000 : deadlineAt - Date.now(), externalSignal)
  /** 调用方叫停了（用户取消、租约丢了）：fan-out 的部分结果不交付，照原样抛。 */
  const cancelled = () => externalSignal?.aborted === true

  const fetchInit = (init: UpstreamFetchInit): UpstreamFetchInit => ({
    ...init,
    signal: deadline.signal,
    dispatcher: upstreamDispatcher,
  })

  /**
   * `counted` 区分「一次上游调用」与「一次轮询」：只有前者过记账回调。异步模式下
   * 轮询次数与计费无关，混进去会让 upstream_invocation_count 失去意义。
   */
  const dispatchIdentities = new WeakMap<UpstreamResponse, string>()
  // 排队时到硬超时：这一条请求确定没发出。同一次调用里别的请求（fan-out 的其它张）即使已发、
  // 结果未知，也由 fanOutRequests 按「有结果未知就整组待核查」汇总，这一条不必跟着改口径。
  const queueTimeoutError = () => new UpstreamQueueTimeoutError()
  // 跨 worker 配额：每条计数的上游请求先占额度再发，响应读完（parseResponse）才还在途名额。
  // 原生 n 一条请求出 n 张，按 n 张扣；fan-out 每条按 1 张扣。
  const imagesPerDispatch = useNativeN ? requestedImageCount : 1
  const schedulerLeases = new WeakMap<UpstreamResponse, SchedulerLease>()
  const outstandingLeases = new Set<SchedulerLease>()
  const releaseLease = async (lease: SchedulerLease, refund = false) => {
    outstandingLeases.delete(lease)
    await lease.release({ refund })
  }
  const performFetch = async (
    url: string,
    init: UpstreamFetchInit,
    counted = true,
  ): Promise<UpstreamResponse> => {
    let lease: SchedulerLease | undefined
    if (counted && schedulerBuckets.length > 0) {
      try {
        lease = await waitForSchedulerSlots(schedulerBuckets, imagesPerDispatch, deadline.signal)
      } catch (err) {
        // 排队时就超时：这条请求没发出去，确定未执行，不是「结果未知」。
        if (deadline.timedOut) throw queueTimeoutError()
        throw err
      }
      if (lease) outstandingLeases.add(lease)
    }
    let sent = false
    // 记账回调开始前都确定没发出；回调里失败时不知道它是否已提交，按原样当「结果未知」。
    let committing = false
    try {
      if (deadline.signal.aborted) throw new DOMException('Upstream request aborted', 'AbortError')
      committing = true
      const dispatchId = counted ? await beforeRequest?.() : undefined
      sent = true
      if (counted) attempt.onDispatched?.()

      // The accounting callback is the dispatch commit point. Start the transport with a fresh
      // signal before relaying cancellation so a cancellation that loses the database race cannot
      // create a charged task without a corresponding upstream invocation.
      const requestAbort = new AbortController()
      const relayAbort = () => requestAbort.abort()
      const responsePromise = upstreamTransport.current(url, {
        ...fetchInit(init),
        signal: requestAbort.signal,
      })
      deadline.signal.addEventListener('abort', relayAbort, { once: true })
      if (deadline.signal.aborted) relayAbort()
      try {
        const recorded = dispatchId ? params.onRequestDispatched?.(dispatchId) : undefined
        let response: UpstreamResponse
        try {
          ;[response] = await Promise.all([responsePromise, recorded])
        } catch (error) {
          requestAbort.abort()
          throw error
        }
        if (dispatchId) dispatchIdentities.set(response, dispatchId)
        if (lease) {
          schedulerLeases.set(response, lease)
          if (response.status === 429) await lease.rateLimited()
        }
        const requestId =
          response.headers?.get('x-request-id') ?? response.headers?.get('request-id')
        if (dispatchId && requestId) await params.onRequestId?.(dispatchId, requestId)
        return response
      } finally {
        deadline.signal.removeEventListener('abort', relayAbort)
      }
    } catch (err) {
      // 记账回调之前就失败：这次没发出去，张数退回。
      if (lease) await releaseLease(lease, !sent)
      // 拿到名额时恰好到硬截止：还没进记账，同样是确定未执行。
      if (deadline.timedOut) throw committing ? new UpstreamTimeoutError() : queueTimeoutError()
      if (externalSignal?.aborted) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游连接中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  const parseResponse = async (
    res: UpstreamResponse,
    imageResponses = false,
  ): Promise<UpstreamCallResult> => {
    try {
      return imageResponses && res.ok
        ? { payload: await readImageResponses(res.body, deadline.signal) }
        : await parseUpstreamResponse(res)
    } catch (err) {
      if (deadline.timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      if (err instanceof ImageResponsesError) throw err
      if (typeof (err as { upstreamStatus?: unknown })?.upstreamStatus === 'number') throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游响应中断，执行结果未知：${detail}`, {
        cause: err,
      })
    } finally {
      const lease = schedulerLeases.get(res)
      if (lease) await releaseLease(lease)
    }
  }

  // 这个 try 里每个 return 都必须 `return await`：裸 return 一个 promise 会让下面的
  // finally 立刻跑，请求还在飞的时候就 release 掉 deadline —— 取消与硬超时都会静默失效。
  try {
    if (provider === 'openai-compat') {
      const authHeader = {
        ...upstreamAuthHeader(style, key),
        ...(organization ? { 'openai-organization': organization } : {}),
      }
      const resumeIds = resume?.taskIds ?? []
      const useAsyncTasks = asyncTasks || resumeIds.length > 0

      /**
       * 补齐到 count 个上游任务：已有 id 原样带出，只为缺口发提交请求。上游没有幂等键，
       * 重提已落库的 id 就是第二次计费，所以缺口是唯一可以提交的份额。
       */
      const collectTaskIds = async (
        protocol: AsyncTaskProtocol,
        count: number,
        makeInit: () => UpstreamFetchInit,
      ): Promise<string[]> => {
        const missing = count - resumeIds.length
        if (missing <= 0) return [...resumeIds]
        if (finalLookup || resume?.pollOnly) return [...resumeIds]
        const acceptedIds: (string | undefined)[] = Array.from({ length: missing })
        const settled = await Promise.allSettled(
          Array.from({ length: missing }, async (_, index) => {
            const response = await performFetch(protocol.submitUrl, makeInit())
            const taskId = protocol.readTaskId((await parseResponse(response)).payload)
            // Acceptance is evidence even when its per-dispatch database write fails.
            acceptedIds[index] = taskId
            const dispatchId = dispatchIdentities.get(response)
            if (dispatchId) await params.onUpstreamTaskId?.(dispatchId, taskId)
            return taskId
          }),
        )
        const accepted = acceptedIds.flatMap((id) => (id ? [id] : []))
        const taskIds = [...resumeIds, ...accepted]
        // Attempt the aggregate checkpoint even if a per-dispatch write rejected.
        if (accepted.length) {
          try {
            await onUpstreamTaskIds?.(taskIds)
          } catch (error) {
            throw new UpstreamResultUnknownError(
              '上游已受理任务，但任务编号保存失败，结果待核查。',
              { cause: error, requiresReconciliation: true },
            )
          }
        }
        const failure = fanOutFailure(settled, params.reconciliationRequired)
        if (failure) {
          warnIfAsyncTasksDisabled(failure.reason)
          if (taskIds.length > 0) {
            const detail =
              failure.reason instanceof Error ? failure.reason.message.slice(0, 200) : '提交失败'
            throw new UpstreamResultUnknownError(
              `部分提交被拒绝，已受理任务的最终结果待核查：${detail}`,
              { cause: failure.reason, requiresReconciliation: true },
            )
          }
          throw failure.reason
        }
        return taskIds
      }

      /** 硬超时会 abort 掉轮询的 sleep；不映射的话裸 AbortError 会被当成用户取消，行没有终态。 */
      const pollDelay = async (attempt: number): Promise<void> => {
        try {
          await abortableSleep(asyncPollDelayMs(attempt), deadline.signal)
        } catch (err) {
          if (deadline.timedOut) throw new UpstreamTimeoutError()
          throw err
        }
      }

      /** 轮询单个上游任务到终态。判定与提交侧方向相反：瞬时错误一律继续轮。 */
      const pollAsyncTask = async (
        protocol: AsyncTaskProtocol,
        taskId: string,
      ): Promise<UpstreamCallResult> => {
        const pollUrl = protocol.pollUrl(taskId)
        for (let attempt = 0; ; attempt++) {
          if (Date.now() >= deadlineAt && !(finalLookup && attempt === 0))
            throw new UpstreamTimeoutError()
          let payload: unknown
          try {
            payload = (
              await parseResponse(
                await performFetch(pollUrl, { method: 'GET', headers: authHeader }, false),
              )
            ).payload
          } catch (err) {
            if (deadline.timedOut || externalSignal?.aborted || !isRecoverablePollFailure(err))
              throw err
            // 留 payload 为 undefined，下面按 pending 走同一条退避路径。
          }
          const state = protocol.readState(payload)
          if (state.kind === 'completed') return { payload: state.payload }
          if (state.kind === 'failed') throw asyncTaskFailure(state.status, payload)
          if (finalLookup) throw new UpstreamTimeoutError()
          await pollDelay(attempt)
        }
      }

      /**
       * 一次逻辑调用 → count 个上游请求 → 合并。同步模式直接发；异步模式提交后转轮询。
       * count 是上游请求数，不是产图数；原生 n 只派发一次，其余路径逐图 fan-out。
       * 恢复时保留已派发数量，避免新路由掩盖旧任务缺失的提交结果。
       */
      const dispatch = async (
        url: string,
        count: number,
        makeInit: () => UpstreamFetchInit,
        merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
      ): Promise<UpstreamCallResult> => {
        if (!useAsyncTasks) {
          return fanOutRequests(
            count,
            async () => parseResponse(await performFetch(url, makeInit())),
            merge,
            params.reconciliationRequired,
            cancelled,
          )
        }
        const protocol = imageTaskProtocol(base, url)
        // 已提交任务只恢复当时的调用数，不能按新路由补发或误判旧原生批次。
        const expectedCount = resume?.invocationCount ?? count
        const taskIds = await collectTaskIds(protocol, expectedCount, makeInit)
        const results = await collectFanOutResults(
          taskIds.map((id) => pollAsyncTask(protocol, id)),
          params.reconciliationRequired,
        )
        const result = results.length === 1 ? results[0]! : merge(results)
        if (taskIds.length < expectedCount) throw new UpstreamPartialResultError(result.payload)
        return result
      }

      const videoSpec = VIDEO_STYLE_SPECS[style]
      if (videoSpec) {
        const video = request.video
        if (!video) throw clientError('视频任务缺少视频参数')
        const mode = video.mode ?? 'generate'
        if (!videoSpec.modes.includes(mode)) throw clientError('该模型不支持续写和改视频')
        const protocol = videoSpec.protocol({ base, model, mode })
        const headers = { 'content-type': 'application/json', ...authHeader }
        const [taskId] = await collectTaskIds(protocol, 1, () => ({
          method: 'POST',
          headers,
          body: JSON.stringify(videoSpec.body(model, request, video, mode)),
        }))
        const { payload } = await pollAsyncTask(protocol, taskId!)
        const outcome = videoSpec.result(base, payload, video)
        const duration_seconds = outcome.durationSeconds
        if (outcome.kind === 'public')
          return { payload: { data: [{ url: outcome.url, mime: VIDEO_MIME, duration_seconds }] } }

        const res = await performFetch(outcome.url, { method: 'GET', headers: authHeader }, false)
        if (!res.ok) await parseResponse(res)
        const bytes = Buffer.from(await res.arrayBuffer())
        return {
          payload: {
            data: [{ b64_json: bytes.toString('base64'), mime: VIDEO_MIME, duration_seconds }],
          },
        }
      }

      if (
        !useNativeN &&
        style === 'openai-images' &&
        gptRoute !== 'direct' &&
        isGptImageModel(model) &&
        config.upstream.imageResponsesModel &&
        resumeIds.length === 0
      ) {
        const body = JSON.stringify(
          buildImageResponsesBody(config.upstream.imageResponsesModel, model, request),
        )
        const headers = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...authHeader,
        }
        return await fanOutRequests(
          request.n,
          async () =>
            parseResponse(
              await performFetch(`${base}/responses`, { method: 'POST', headers, body }),
              true,
            ),
          mergeOpenAIImageResults,
          params.reconciliationRequired,
          cancelled,
        )
      }

      // Agnes 风格上游：没有 images/edits 端点，图生图与文生图
      // 共用 images/generations JSON，输入图放 extra_body.image（data URI / URL）。
      // 实测注意：文档"Important Notes"声称的 top-level image 数组会被上游**静默忽略**
      // （跑成纯文生图），必须放 extra_body；n 同样被忽略，这里学 gemini 分支 fan-out。
      if (style === 'agnes-generations-json') {
        if (request.mask) {
          throw clientError('该模型不支持遮罩编辑（上游无 mask 能力），请换 GPT 模型或去掉遮罩')
        }
        const body = JSON.stringify(buildAgnesGenerationsBody(model, request))
        const headers = { 'content-type': 'application/json', ...authHeader }
        return await dispatch(
          `${base}/images/generations`,
          Math.max(1, request.n ?? 1),
          () => ({ method: 'POST', headers, body }),
          mergeOpenAIDataResults,
        )
      }

      // 有参考图 / 有遮罩 → images/edits；generations 是纯文生图，
      // 塞 input_images 字段上游会忽略（用户感知"AI 不参考附件"）。
      if (request.input_images?.length || request.mask) {
        // Grok 1.0 多张参考图先合成 contact sheet；2.0 原生多图，跳过拼图。
        let editRequest = request
        if (style === 'grok-openai-images') {
          editRequest = isGrokImagine2(model)
            ? normalizeGrokImagine2EditInputs(request)
            : await normalizeGrokEditInputs(request, deadline.signal)
        }
        const n = Math.max(1, editRequest.n ?? 1)
        const unitRequest = n === 1 ? editRequest : withoutImageCount(editRequest)
        // Grok edits 必须 application/json：改回 multipart 会被 sub2api 转换丢掉
        // response_format，上游退回 URL 结果，归档取图一律 403。
        // FormData 会被请求消费掉，所以只有 JSON 体能在 fan-out 之间复用。
        const grokBody =
          style === 'grok-openai-images'
            ? JSON.stringify(buildGrokEditBody(model, unitRequest))
            : null
        const makeInit = (): UpstreamFetchInit =>
          grokBody !== null
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...authHeader },
                body: grokBody,
              }
            : {
                method: 'POST',
                headers: authHeader,
                body: buildOpenAIEditFormData(model, unitRequest),
              }
        return await dispatch(`${base}/images/edits`, n, makeInit, mergeOpenAIImageResults)
      }

      const headers = { 'content-type': 'application/json', ...authHeader }
      const n = Math.max(1, request.n ?? 1)
      // 原生 n 是一次上游生成请求；否则沿用兼容网关的单图 fan-out。
      const unitRequest = useNativeN || n === 1 ? request : withoutImageCount(request)
      const body = JSON.stringify(
        style === 'grok-openai-images' && isGrokImagine2(model)
          ? buildGrokImagine2Body(model, unitRequest)
          : buildOpenAIBody(model, unitRequest),
      )
      return await dispatch(
        `${base}/images/generations`,
        useNativeN ? 1 : n,
        () => ({ method: 'POST', headers, body }),
        mergeOpenAIImageResults,
      )
    }

    if (provider === 'gemini') {
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
      // Vertex 直连认 Google 自家的 x-goog-api-key；通用网关（sub2api）认 x-api-key。
      const vertex = style === 'vertex-generate-content'
      const headers = {
        'content-type': 'application/json',
        ...(key ? { [vertex ? 'x-goog-api-key' : 'x-api-key']: key } : {}),
      }
      const body = JSON.stringify(
        vertex ? buildVertexBody(request, imageSizes) : buildGeminiBody(request),
      )

      // Gemini image generation 不支持 candidateCount>1（"Only one candidate is
      // supported for audio or image response"），n>1 时本层 fan-out 成 N 条单张请求
      // 并把 candidates 合并到一个 payload，对 task-runner / 前端透明。声明了 maxConcurrency
      // （Vertex 按模型各配 2）时，每条请求先排「渠道/模型」或渠道级的队再发。
      const sendVia = async (
        target: {
          url: string
          body: string
          concurrency: UpstreamRoute['concurrency']
        },
        /** 原模型的总时限：到点不再排队、不再退避，抛 {@link VertexTimeCapError} 交给回落。 */
        capAt?: number,
      ) => {
        // 剩余时间只读一次：检查和建定时器之间跨过时限也不会给 AbortSignal.timeout 传负数。
        const capLeftMs = capAt === undefined ? undefined : capAt - Date.now()
        if (capLeftMs !== undefined && capLeftMs <= 0) throw new VertexTimeCapError()
        const queueSignal =
          capLeftMs === undefined
            ? deadline.signal
            : AbortSignal.any([deadline.signal, AbortSignal.timeout(capLeftMs)])
        const release = target.concurrency
          ? await acquireChannelSlot(
              target.concurrency.channelId,
              target.concurrency.limit,
              queueSignal,
            ).catch((error: unknown) => {
              // 排队时就超时：这条请求没发出去，确定未执行，不是「结果未知」。
              if (deadline.timedOut) throw queueTimeoutError()
              if (capAt !== undefined && !deadline.signal.aborted && Date.now() >= capAt)
                throw new VertexTimeCapError()
              throw error
            })
          : undefined
        const send = async () =>
          await parseResponse(
            await performFetch(target.url, { method: 'POST', headers, body: target.body }),
          )
        try {
          // Vertex 的 429 是按模型的到达速率限流：先在这条请求里退避重发，一单多张里已出的图不必重来。
          return vertex
            ? await withVertexRateLimitRetry(send, deadline.signal, () => deadline.timedOut, capAt)
            : await send()
        } finally {
          release?.()
        }
      }
      const primary = { url, body, concurrency }
      const fallback = vertex
        ? resolveVertexFallback(model, params.rateLimitFallbackModel, request, base, key)
        : undefined
      const capAt = fallback ? params.rateLimitFallbackAt : undefined
      let fallbackImages = 0
      const merge = (results: UpstreamCallResult[]) => {
        const merged = mergeGeminiCandidateResults(results)
        if (!fallback || fallbackImages === 0) return merged
        return {
          payload: {
            ...(merged.payload as Record<string, unknown>),
            model_fallback: modelFallbackRecord(model, fallback.model, fallbackImages),
          },
        }
      }
      return await fanOutRequests(
        request.n,
        async () => {
          try {
            return await sendVia(primary, capAt)
          } catch (error) {
            // 退避用完仍 429、或原模型到了总时限：这一张换回落模型补上（它有自己的排队位与退避）；
            // 别的错误照原样抛。
            const capped = error instanceof VertexTimeCapError
            if (!fallback || !(capped || isRateLimited(error)) || deadline.signal.aborted)
              throw error
            log.warn(
              {
                event: 'upstream.vertex_rate_limit_fallback',
                requestedModel: model,
                fallbackModel: fallback.model,
                reason: capped ? 'time_cap' : 'rate_limited',
              },
              'vertex rate limit exhausted, falling back',
            )
            const result = await sendVia(fallback)
            fallbackImages += 1
            return result
          }
        },
        (results) => merge(results),
        params.reconciliationRequired,
        cancelled,
      ).then((result) =>
        // 单张请求（n=1）不经过 merge：回落出的那张也要记下实际模型。
        (request.n ?? 1) <= 1 && fallback && fallbackImages > 0 ? merge([result]) : result,
      )
    }
    throw new Error(`Unsupported provider: ${provider satisfies never}`)
  } catch (err) {
    // fan-out 请求任一失败时取消其它同批请求，避免 callUpstream 已返回失败后仍在后台跑。
    deadline.abort()
    throw err
  } finally {
    deadline.release()
    // 没走到 parseResponse 的响应（同批别的请求先失败等）也要还在途名额，不能等心跳过期。
    await Promise.all([...outstandingLeases].map((lease) => releaseLease(lease)))
  }
}

/** 轮询退避（ms），index 超出取末位。上游 202 响应的 `Retry-After` 也是 3。 */
const ASYNC_POLL_BACKOFF_MS: readonly number[] = [3_000, 3_000, 5_000, 5_000, 10_000]

let asyncPollBackoffMs = ASYNC_POLL_BACKOFF_MS

/** 测试注入点；undefined 恢复真实退避（否则一次重试就要真睡 3 秒）。 */
export function setAsyncPollBackoffForTesting(backoffMs?: readonly number[]): void {
  asyncPollBackoffMs = backoffMs ?? ASYNC_POLL_BACKOFF_MS
}

function asyncPollDelayMs(attempt: number): number {
  return asyncPollBackoffMs[Math.min(attempt, asyncPollBackoffMs.length - 1)]!
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Upstream polling aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Vertex 429 回落的目标：只回落到同一个 Vertex 直连上（同一个 key、同一个 baseUrl）的另一个模型，
 * 换到别的上游就要换协议和凭据，不在这次止损的范围里。回落模型不认的分辨率按它自己的声明收口。
 * 找不到、或配成原模型本身时不回落。
 */
function resolveVertexFallback(
  model: string,
  fallbackModel: string | undefined,
  request: HydratedSubmitRequest,
  base: string,
  key: string,
):
  | { model: string; url: string; body: string; concurrency: UpstreamRoute['concurrency'] }
  | undefined {
  if (!fallbackModel || fallbackModel === model) return undefined
  let route: UpstreamRoute
  try {
    route = resolveUpstream('gemini', fallbackModel)
  } catch {
    return undefined
  }
  if (route.style !== 'vertex-generate-content' || route.baseUrl !== base || route.key !== key)
    return undefined
  return {
    model: fallbackModel,
    url: `${base}/models/${encodeURIComponent(fallbackModel)}:generateContent`,
    body: JSON.stringify(buildVertexBody(request, route.imageSizes)),
    concurrency: route.concurrency,
  }
}

/**
 * 一次逻辑调用拆成 count 条单张请求再合并。部分出图时不让整单失败：交付已出的那几张，结果里
 * 记下缺口（{@link withPartialFailure}），task-runner 按交付张数结算、其余退回。一张都没出照原样
 * 抛第一条失败；被取消（用户取消、租约丢了）照原样抛，不交付。
 * 结果待核查的线路（`reconciliationRequired`）保留整组语义：哪条算没算钱要人核对，不能先交付；
 * 其它线路只要有一条结果未知（可能已出图），也照这个口径整组待核查，不按部分交付退款。
 */
async function fanOutRequests(
  requestedCount: number | undefined,
  run: () => Promise<UpstreamCallResult>,
  merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
  reconciliationRequired = false,
  cancelled: () => boolean = () => false,
): Promise<UpstreamCallResult> {
  const count = Math.max(1, requestedCount ?? 1)
  if (count === 1) return run()
  if (reconciliationRequired)
    return merge(await collectFanOutResults(Array.from({ length: count }, run), true))
  const settled = await Promise.allSettled(Array.from({ length: count }, run))
  const delivered = settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []))
  const failures = settled.flatMap((one) => (one.status === 'rejected' ? [one.reason] : []))
  if (failures.length === 0) return merge(delivered)
  // 结果未知的那条可能已经出了图、上游也可能已经计费：不能当“没出图”退钱再交付，
  // 照结果待核查线路的口径整组交给核查，免得错退积分、重试时重复出图。
  const unknown = failures.find((reason) => reason instanceof UpstreamResultUnknownError)
  // 显式要求核查：task-runner 只在任务已标记或错误带 requiresReconciliation 时才进核查。
  // 被取消时照原样抛，不改成核查。
  if (unknown && delivered.length > 0 && !cancelled())
    throw new UpstreamResultUnknownError('部分请求已完成，整组结果和结算待核查。', {
      cause: unknown,
      requiresReconciliation: true,
    })
  if (delivered.length === 0 || cancelled()) throw unknown ?? failures[0]
  return withPartialFailure(merge(delivered), count, failures)
}

function fanOutFailure<T>(settled: PromiseSettledResult<T>[], preserveUnknown = false) {
  const failures = settled.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
  return (
    (preserveUnknown
      ? failures.find((one) => one.reason instanceof UpstreamResultUnknownError)
      : undefined) ?? failures[0]
  )
}

async function collectFanOutResults<T>(
  requests: Promise<T>[],
  preserveUnknown = false,
): Promise<T[]> {
  if (!preserveUnknown) return Promise.all(requests)
  const settled = await Promise.allSettled(requests)
  const failure = fanOutFailure(settled, preserveUnknown)
  if (failure && settled.some((one) => one.status === 'fulfilled')) {
    throw new UpstreamResultUnknownError('部分请求已完成，整组结果和结算待核查。', {
      cause: failure.reason,
    })
  }
  if (failure) throw failure.reason
  return settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []))
}

/** 一次上游取消尝试的结果，只进日志，不影响我们这边的取消与退款。 */
export type UpstreamCancelOutcome =
  | { readonly taskId: string; readonly outcome: 'cancelled'; readonly status: number }
  | { readonly taskId: string; readonly outcome: 'rejected'; readonly status: number }
  | { readonly taskId: string; readonly outcome: 'error'; readonly error: string }

const UPSTREAM_CANCEL_TIMEOUT_MS = 10_000

/**
 * 用户取消任务后尽力叫停上游已经建起来的异步任务（BUG-32）。只对有取消接口的线路发请求，其余
 * 返回 null：同步线路靠断开连接收手，异步线路（sub2api、xAI、Veo）没有取消接口，只能停止轮询。
 * 失败只返回结果、从不抛出——退款早已在取消事务里落定，与这里无关。
 */
export async function cancelUpstreamTasks(
  provider: QueueProvider,
  model: string,
  taskIds: readonly string[],
): Promise<UpstreamCancelOutcome[] | null> {
  let route: UpstreamRoute
  try {
    route = resolveUpstream(provider, model)
  } catch {
    return null
  }
  const cancelUrl = VIDEO_STYLE_SPECS[route.style]?.cancelUrl
  if (!cancelUrl || taskIds.length === 0) return null
  const headers = upstreamAuthHeader(route.style, route.key)
  return Promise.all(
    taskIds.map(async (taskId): Promise<UpstreamCancelOutcome> => {
      try {
        const res = await upstreamTransport.current(cancelUrl(route.baseUrl, taskId), {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(UPSTREAM_CANCEL_TIMEOUT_MS),
          dispatcher: upstreamDispatcher,
        })
        await res.text().catch(() => '')
        return res.ok
          ? { taskId, outcome: 'cancelled', status: res.status }
          : { taskId, outcome: 'rejected', status: res.status }
      } catch (err) {
        return { taskId, outcome: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )
}

/** Google 直连认自己的 key 头；其余上游都是 Bearer。 */
function upstreamAuthHeader(style: ChannelRouteStyle, key: string): Record<string, string> {
  if (!key) return {}
  return style === 'veo-videos' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` }
}

async function parseUpstreamResponse(res: UpstreamResponse): Promise<UpstreamCallResult> {
  const text = await res.text()
  let payload: unknown = text
  try {
    payload = JSON.parse(text)
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    const message = extractErrorMessage(payload, res.status)
    // 上游 envelope 完整落 log（截断）：extractErrorMessage 可能把诊断信息提取
    // 成兜底字符串（如 "Upstream request failed"），原始 body 里的 error.code /
    // 上游真错因（"upstream did not return image output" 等）会丢，这里补回。
    log.warn(
      {
        event: 'upstream.non_2xx',
        upstreamStatus: res.status,
        message,
        payloadPreview: stringifyUpstreamPayload(payload),
      },
      'upstream returned non-2xx',
    )
    const err = new Error(message) as Error & { upstreamStatus: number; upstreamPayload: unknown }
    err.upstreamStatus = res.status
    err.upstreamPayload = payload
    throw err
  }
  return { payload }
}

export {
  extractUpstreamFailure,
  UpstreamPartialResultError,
  UpstreamQueueTimeoutError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './upstream/errors'
export type { UpstreamCallResult } from './upstream/shared'
