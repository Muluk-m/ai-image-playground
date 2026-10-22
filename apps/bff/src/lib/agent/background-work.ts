import { abortRunningTurnsForTesting, runningTurnsForTesting } from './runningTurns'

/**
 * 一轮跑完之后、本进程里还在跑的后台工作：放手会话租约、接着去收件箱取下一条、生成「下一句」。
 * 它们都不挡终帧，所以响应流结束时它们可能还没跑完。
 *
 * 这里只做登记，不依赖数据库与配置：测试的 preload 在测试文件定下 DATABASE_URL 之前就要引它。
 */
const pending = new Set<Promise<unknown>>()

/** 登记一件后台工作。它的失败由发起方自己记日志；这里只接住 rejection，Bun 遇到没人接的会直接退出进程。 */
export function trackAgentBackgroundWork(work: Promise<unknown>): void {
  pending.add(work)
  work.finally(() => pending.delete(work)).catch(() => {})
}

/**
 * 等本进程里在跑的轮与它们收尾后的后台工作都跑完，包括跑的过程中又开的轮、又登记的工作。
 * 用例自己掌握着这些轮（上游由它驱动），要在断言或清场前等它们落定时用它。
 */
export async function settleAgentBackgroundWorkForTesting(): Promise<void> {
  while (true) {
    const turns = runningTurnsForTesting().flatMap((turn) =>
      turn.completed ? [turn.completed] : [],
    )
    if (turns.length === 0 && pending.size === 0) return
    await Promise.allSettled([...turns, ...pending])
  }
}

/**
 * 用例之间的清场：上一个用例留下还在跑的轮一律中止，再等已经跑完的轮收尾后的后台工作。
 * 中止了的轮不等：它可能卡在不认中止的 I/O 上，等它会把下一个用例拖到超时。
 */
export async function settleAgentTailsForTesting(): Promise<void> {
  abortRunningTurnsForTesting()
  while (pending.size > 0) {
    await Promise.allSettled([...pending])
    abortRunningTurnsForTesting()
  }
}
