/*
 * 按渠道限制同时在途的上游请求数（`channels.json` 的 `maxConcurrency`）。
 *
 * Vertex AI 直连实测：同一 key 同时超过 2 个 generateContent 就回 429。一单多张在 BFF 里拆成 N 条
 * 请求，多个任务也会同时出图，所以排队必须放在渠道这一层，而不是单个任务里。
 * 限的是本进程：多个 worker 实例各自计数，部署时按实例数折算。
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
    if (next) next()
    else current.active -= 1
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
