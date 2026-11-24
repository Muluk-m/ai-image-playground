import {
  isGptDirectModel,
  isGptSub2apiDeliverable,
  type QueueProvider,
} from '@image-playground/shared'
import { config } from '../../config'
import { disabledModelChannel, getRoutableChannels, type InternalChannel } from '../channels'
import { resolveApiKey } from '../resolveApiKey'
import { runtimeSecret } from '../upstream-secret-cache'
import { directKeyKnownDisabled } from './gpt-direct-availability'
import { configuredDirectKeys, type DirectKey } from './gpt-key-config'
import { type GptRoute, gptDirectApiKey } from './gpt-routing'
import { isGptImageModel } from './openai'
import { gptSchedulerBuckets, type SchedulerBucket } from './scheduler'
import type { ChannelRouteStyle } from './shared'
import type { UpstreamCallParams } from './types'

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
export function channelRouteStyle(channelId: string): ChannelRouteStyle | undefined {
  return Object.hasOwn(CHANNEL_ROUTE_STYLES, channelId)
    ? CHANNEL_ROUTE_STYLES[channelId]
    : undefined
}

export interface UpstreamRoute {
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
  /** GPT Image 走的是哪条通道；决定发送前的参数适配（见 `adaptGptRequest`）。 */
  gptRoute?: GptRoute
  /** 实际选中的直连 key；所有模型在共同派发边界记录，不保存密钥本身。 */
  keyFingerprint?: string
  /** 直连可选的 OpenAI-Organization 头。 */
  organization?: string
  /**
   * 直连的 429 只冷却这一把 key。整条模型桶一停，下一把 key 也占不到额度。
   */
  skipSharedRateLimitCooldown?: boolean
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

/**
 * provider + model → 上游 baseUrl、API key 与协议风格。
 * 返回的 baseUrl 统一**含版本段**（如 .../v1、.../v1beta），调用方拼相对路径，
 * 杜绝 channel baseUrl（含版本段）与 env baseUrl（不含）两套约定打架拼出 /v1/v1。
 * 未命中 CHANNEL_ROUTE_STYLES 的走 UPSTREAM_BASE_URL 通用网关 + 标准 OpenAI 协议。
 */
export function resolveUpstream(provider: QueueProvider, model: string): UpstreamRoute {
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
      key: runtimeSecret(channel.auth.secretRef, channel.auth.secret),
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

/**
 * GPT Image 的 OpenAI 直连：原生 size / quality / n，同步返回，不走异步任务与 Responses。
 * 还有下一把可用 key 时，429 不冷却整条模型桶，否则下一把占不到额度。
 * 没有下一把时照旧冷却模型桶，下一单会等冷却结束，而不是立刻再打。
 */
export function directRoute(
  model: string,
  key?: DirectKey,
  options?: { skipSharedRateLimitCooldown?: boolean },
): UpstreamRoute {
  const chosen =
    key ??
    configuredDirectKeys().find(
      (candidate) => candidate.enabled && !directKeyKnownDisabled(candidate.fingerprint),
    )
  return {
    baseUrl: config.gptDirect.baseUrl,
    key: chosen?.secret ?? gptDirectApiKey(),
    style: 'openai-images',
    forceB64Json: false,
    supportsModeration: true,
    asyncTasks: false,
    supportsNativeN: true,
    schedulerBuckets: gptSchedulerBuckets(model, 'direct'),
    gptRoute: 'direct',
    ...(chosen ? { keyFingerprint: chosen.fingerprint } : {}),
    ...(options?.skipSharedRateLimitCooldown ? { skipSharedRateLimitCooldown: true } : {}),
    ...(config.gptDirect.organization ? { organization: config.gptDirect.organization } : {}),
  }
}

export function requiresGptDirect(params: UpstreamCallParams): boolean {
  return (
    params.strictImageRequest === true &&
    isGptDirectModel(params.model) &&
    !params.request.video &&
    !isGptSub2apiDeliverable(params.request)
  )
}

/** Google 直连认自己的 key 头；其余上游都是 Bearer。 */
export function upstreamAuthHeader(style: ChannelRouteStyle, key: string): Record<string, string> {
  if (!key) return {}
  return style === 'veo-videos' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` }
}
