import { log } from './logger'

export interface PeriodicStep {
  /** 失败日志的 event 名。 */
  readonly event: string
  /** 停机时 `signal` 会被中止；跑得久的步骤在批次之间看它，尽快收手。 */
  readonly run: (signal: AbortSignal) => Promise<void>
}

/**
 * 依次跑一遍，每步各自兜住异常。Bun 遇到没人接的 rejection 会直接退出进程，
 * 一次数据库抖动不该带走整个 BFF 和它上面正在跑的对话轮。
 */
export async function runPeriodicSteps(
  steps: readonly PeriodicStep[],
  onFailure: (event: string, err: unknown) => void = (event, err) =>
    log.error({ event, err }, 'periodic maintenance step failed'),
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  for (const step of steps) {
    if (signal.aborted) return
    try {
      await step.run(signal)
    } catch (err) {
      onFailure(step.event, err)
    }
  }
}

/**
 * 按间隔跑；上一轮还没跑完就跳过这一拍，不叠着跑。返回停止函数：停掉定时器、中止在途那一轮，
 * 返回的 promise 等它收手结束（停机时据此在关库前等它）。
 * `initial` 在启动时立刻在后台跑一次，不等它：开机清理积压多时可能要几分钟，不能挡着服务开始监听。
 * 它和定时那几拍共用同一个「正在跑」标记，跑完之前定时的那一拍同样跳过。
 */
export function startPeriodicSteps(
  intervalMs: number,
  steps: readonly PeriodicStep[],
  options: { readonly initial?: readonly PeriodicStep[] } = {},
): () => Promise<void> {
  const stopping = new AbortController()
  let inFlight: Promise<void> | undefined
  const run = (current: readonly PeriodicStep[]) => {
    if (inFlight || stopping.signal.aborted) return
    inFlight = runPeriodicSteps(current, undefined, stopping.signal).finally(() => {
      inFlight = undefined
    })
  }
  if (options.initial?.length) run(options.initial)
  const timer = setInterval(() => run(steps), intervalMs)
  return async () => {
    clearInterval(timer)
    stopping.abort()
    await inFlight
  }
}
