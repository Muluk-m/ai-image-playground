import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici'

export type { Dispatcher }
export type UndiciFetchInput = Parameters<typeof undiciFetch>[0]
export type UndiciFetchInit = Parameters<typeof undiciFetch>[1]

export interface DispatcherTimeouts {
  readonly connectMs: number
  /** headers/body 上限；省略表示只管连不上的情况，整体时长交给 deadline 切。 */
  readonly transportMs?: number
}

/** Agent 构造后读不回它的配置，所以算好的选项单独暴露一层给测试断言。 */
export function agentOptions({ connectMs, transportMs }: DispatcherTimeouts): Agent.Options {
  return transportMs === undefined
    ? { connectTimeout: connectMs }
    : { connectTimeout: connectMs, headersTimeout: transportMs, bodyTimeout: transportMs }
}

export function createDispatcher(timeouts: DispatcherTimeouts): Dispatcher {
  return new Agent(agentOptions(timeouts))
}

export interface FetchSlot<F> {
  readonly current: F
  /** 测试注入点；undefined 恢复真实 Undici transport。 */
  set(impl?: F): void
}

/**
 * 每个调用方一个 transport 槽。响应形状由调用方各自的窄接口决定，泛型无法同时表达
 * 「undiciFetch 可赋给 F」，所以这里做唯一一次断言，换掉四份各自的 undici 导入。
 */
export function createFetchSlot<F>(): FetchSlot<F> {
  let impl = undiciFetch as F
  return {
    get current() {
      return impl
    },
    set(next?: F) {
      impl = next ?? (undiciFetch as F)
    },
  }
}

export interface RequestDeadline {
  readonly signal: AbortSignal
  /** 超时切的，而非外部取消或上游自己断——调用方据此映射自己的错误类。 */
  readonly timedOut: boolean
  abort(): void
  release(): void
}

/** 跨多次请求的超时预算：调用方自己决定何时 release，忘了 release 定时器就不会回收。 */
export function startDeadline(timeoutMs: number, externalSignal?: AbortSignal): RequestDeadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort()
    },
    Math.max(0, timeoutMs),
  )
  const relay = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', relay)
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    abort: () => controller.abort(),
    release() {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', relay)
    },
  }
}

/** 单次请求的超时预算，跑完即回收定时器。 */
export async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = startDeadline(timeoutMs)
  try {
    return await run(deadline.signal)
  } finally {
    deadline.release()
  }
}
