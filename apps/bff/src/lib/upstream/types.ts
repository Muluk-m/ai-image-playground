import type {
  Image26DegradeField,
  Image26DegradeKind,
  QueueProvider,
} from '@image-playground/shared'
import type { HydratedSubmitRequest } from '../imageArchive'
import type { UndiciFetchInit, UndiciFetchInput } from '../timeoutFetch'
import type { GptRoute } from './gpt-routing'

export interface UpstreamResume {
  readonly pollOnly?: boolean
  readonly taskIds: readonly string[]
  /** 已派发的请求数；路由升级不能把旧 fan-out 的缺失提交认成完整原生批次。 */
  readonly invocationCount?: number
  /** 首次提交时刻，超时预算的锚点；重启不能重新发一份完整预算。 */
  readonly submittedAt: number
}

export interface UpstreamCallParams {
  /** New producers must preserve any unknown branch, irrespective of rejection order. */
  reconciliationRequired?: boolean
  /** 任务 id，只用于 OpenAI 直连的成本记账。 */
  taskId?: string
  /**
   * 任务行上已经记下的通道。2.6 续轮询只认它：确认是 sub2api 才回网关，
   * 直连或还没记下通道的都留在直连，不用上游 id 猜路。
   */
  persistedGptRoute?: 'direct' | 'sub2api' | null
  /** 账号是会员：GPT Image 默认走 OpenAI 直连（见 upstream/gpt-routing.ts）。 */
  gptMember?: boolean
  /** Server-persisted CLI contract; premium GPT requests may only execute on direct. */
  strictImageRequest?: boolean
  /** 直连请求派发时记录安全指纹；与响应一起等待落库，不推迟传输启动。 */
  onGptKey?: (fingerprint: string) => Promise<void>
  /**
   * 2.6 走 sub2api 时强制 `/images/generations`。Responses 桥接的模型不是 2.6，
   * 不能把静态图改送到那条路。
   */
  imageProtocol?: 'generations'
  /** GPT Image 每条路开跑前调用（换路时再调一次）；调用方据此记下最后走的通道，结算用。 */
  onGptRoute?: (route: GptRoute) => Promise<void>
  /** 执行时才降级：把降级记录写回任务，卡片才能显示提示。 */
  onImage26Degrade?: (record: {
    kind: Image26DegradeKind
    fields: readonly Image26DegradeField[]
  }) => Promise<void>
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
   * 只在它同走 Vertex 直连时生效，见 `resolveVertexFallback`。
   */
  rateLimitFallbackModel?: string
  /**
   * 原模型的总时限（epoch 毫秒，调用方从任务提交时刻算起，含排队）。到点还在排原模型的队、
   * 或下一次退避会越过它，这一张直接改用回落模型；已发出的请求不掐断（上游可能已经在出图）。
   * 没有回落模型时不生效。
   */
  rateLimitFallbackAt?: number
}

export interface UpstreamResponse {
  readonly ok: boolean
  readonly headers?: { get(name: string): string | null }
  readonly status: number
  readonly body?: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export type UpstreamFetch = (
  input: UndiciFetchInput,
  init?: UndiciFetchInit,
) => Promise<UpstreamResponse>

export type UpstreamFetchInit = UndiciFetchInit

export interface AttemptOptions {
  /** 这一路被换路逻辑叫停（与调用方的 signal 合并：被叫停时按取消原样抛出，由外层改判）。 */
  signal?: AbortSignal
  /** 两路共用的硬截止（epoch 毫秒）；缺席按提交时刻 + 硬超时。 */
  deadlineAt?: number
  /** 每条计数请求通过记账、确实发出时调用。 */
  onDispatched?: () => void | Promise<void>
  /** 某条请求的响应完整读到（成功出图）时调用；fan-out 里已有成品就不该再整单换路。 */
  onResponse?: () => void
}

/** 一次上游取消尝试的结果，只进日志，不影响我们这边的取消与退款。 */
export type UpstreamCancelOutcome =
  | { readonly taskId: string; readonly outcome: 'cancelled'; readonly status: number }
  | { readonly taskId: string; readonly outcome: 'rejected'; readonly status: number }
  | { readonly taskId: string; readonly outcome: 'error'; readonly error: string }
