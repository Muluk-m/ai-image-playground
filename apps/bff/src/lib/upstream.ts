import { isGptDirectModel, isGptImage26Model, type QueueProvider } from '@image-playground/shared'
import { ImagePlanRequiredError } from './upstream/errors'
import { executeViaRoute } from './upstream/executors/registry'
import { callGptDualRoute, callGptImage26 } from './upstream/gpt-failover'
import { gptDirectConfigured } from './upstream/gpt-routing'
import {
  directRoute,
  requiresGptDirect,
  resolveUpstream,
  taskConcurrencyScope,
  type UpstreamRoute,
} from './upstream/routes'
import type { UpstreamCallResult } from './upstream/shared'
import {
  cancelUpstreamTasks,
  setAsyncPollBackoffForTesting,
  setUpstreamFetchForTesting,
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UPSTREAM_TRANSPORT_TIMEOUT_MS,
} from './upstream/transport'
import type { UpstreamCallParams, UpstreamCancelOutcome, UpstreamResume } from './upstream/types'

/*
 * 上游派发薄门面：负责顶层路由分流（Image 2.6 / GPT 双通道 / 单路径执行器注册表）并保持历史导出稳定。
 * 路由解析、传输会话、有界非 2xx 错误读取、fan-out/轮询、执行器注册表与 GPT 换路策略分别位于 `./upstream/`。
 */

export async function callUpstream(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  if (isGptImage26Model(params.model) && !params.request.video) {
    return callGptImage26(params)
  }
  const route = resolveUpstream(params.provider, params.model)
  // 已提交的任务沿原路续轮询，不因直连配置后来变化而放弃上游结果。
  if (!params.resume && requiresGptDirect(params) && !gptDirectConfigured(params.model))
    throw new ImagePlanRequiredError()
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
    return executeViaRoute(params, route)
  }
  return callGptDualRoute(params, route)
}

/**
 * 测试用：跳过选路，直接走 OpenAI 直连这一条（调度器配额、429 冷却照常生效）。
 * `nativeN: false` 模拟逐张 fan-out 的路径（直连的图生图不接受 n，就是这样发的）。
 */
export function _resolveUpstreamForTesting(provider: QueueProvider, model: string): UpstreamRoute {
  return resolveUpstream(provider, model)
}

export function _gptDirectRouteForTesting(model: string): UpstreamRoute {
  return directRoute(model)
}

export function _callUpstreamDirectForTesting(
  params: UpstreamCallParams,
  { nativeN = true }: { nativeN?: boolean } = {},
): Promise<UpstreamCallResult> {
  return executeViaRoute(params, { ...directRoute(params.model), supportsNativeN: nativeN })
}

export {
  extractUpstreamFailure,
  UpstreamPartialResultError,
  UpstreamQueueTimeoutError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './upstream/errors'
export type { UpstreamCallParams, UpstreamCallResult, UpstreamCancelOutcome, UpstreamResume }
export {
  cancelUpstreamTasks,
  setAsyncPollBackoffForTesting,
  setUpstreamFetchForTesting,
  taskConcurrencyScope,
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UPSTREAM_TRANSPORT_TIMEOUT_MS,
}
