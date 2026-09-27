import { log } from './logger'

export interface PeriodicStep {
  /** 失败日志的 event 名。 */
  readonly event: string
  readonly run: () => Promise<void>
}

/**
 * 依次跑一遍，每步各自兜住异常。Bun 遇到没人接的 rejection 会直接退出进程，
 * 一次数据库抖动不该带走整个 BFF 和它上面正在跑的对话轮。
 */
export async function runPeriodicSteps(
  steps: readonly PeriodicStep[],
  onFailure: (event: string, err: unknown) => void = (event, err) =>
    log.error({ event, err }, 'periodic maintenance step failed'),
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run()
    } catch (err) {
      onFailure(step.event, err)
    }
  }
}

/** 按间隔跑；上一轮还没跑完就跳过这一拍，不叠着跑。返回停止函数。 */
export function startPeriodicSteps(intervalMs: number, steps: readonly PeriodicStep[]): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await runPeriodicSteps(steps)
    } finally {
      running = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
