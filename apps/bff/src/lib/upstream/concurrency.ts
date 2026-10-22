/*
 * 按渠道限制同时在途的上游请求数（`channels.json` 的 `maxConcurrency`）。
 *
 * Vertex AI 直连实测：同一 key 同时超过 2 个 generateContent 就回 429。一单多张在 BFF 里拆成 N 条
 * 请求，多个任务也会同时出图，所以排队必须放在渠道这一层，而不是单个任务里。
 *
 * 计数在进程内，这对现在的部署就是全局的：
 * - generateContent 只由 worker 发出。BFF 进程里唯一调 callUpstream 的是任务核查：它只对有上游
 *   任务 id 的任务查结果（Gemini 同步请求没有），而且 `beforeRequest` 会在发出前拒绝任何新请求。
 * - deploy/compose.app.yaml 只跑一个 worker 副本。
 * 唯一的例外是发版交接：旧 worker 排空（WORKER_DRAIN_TIMEOUT_MS，默认 55 秒）期间新旧两个进程各有
 * 2 个位，最多 4 条。那段时间多出来的 429 走现有重试策略（retry.ts 把 429 当可重试）。
 * 要扩成多个 worker 副本时，这里得换成跨进程的租约（例如数据库里带过期时间的槽位表）。
 */

interface Gate {
  active: number
  waiting: Array<() => void>
}

const gates = new Map<string, Gate>()

/**
 * 等到渠道有空位再返回 release；`signal` 中止时放弃排队并抛出中止原因，不占位。
 * release 只能调一次，重复调用会被忽略。
 */
export async function acquireChannelSlot(
  channelId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<() => void> {
  let gate = gates.get(channelId)
  if (!gate) {
    gate = { active: 0, waiting: [] }
    gates.set(channelId, gate)
  }
  const current = gate
  if (signal?.aborted) throw abortReason(signal)
  if (current.active < limit) {
    current.active += 1
  } else {
    // 空位由 release 直接交给队首，不经过 active 计数，避免同一刻新来的请求插队超额。
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = current.waiting.indexOf(wake)
        if (index >= 0) current.waiting.splice(index, 1)
        if (signal) reject(abortReason(signal))
      }
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      current.waiting.push(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const next = current.waiting.shift()
    if (next) return next()
    current.active -= 1
    // 闲下来就把 gate 丢掉，Map 只留有请求在途的渠道。
    if (current.active === 0 && gates.get(channelId) === current) gates.delete(channelId)
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Upstream request aborted', 'AbortError')
}

/** 测试用：看某个渠道当前占了几个位、排了几个。 */
export function channelSlotStateForTesting(channelId: string): { active: number; waiting: number } {
  const gate = gates.get(channelId)
  return { active: gate?.active ?? 0, waiting: gate?.waiting.length ?? 0 }
}

/** 测试用：当前还留着 gate 的渠道数（闲下来的渠道不该留）。 */
export function channelGateCountForTesting(): number {
  return gates.size
}
