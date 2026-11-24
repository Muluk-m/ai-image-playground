/*
 * 按渠道或「渠道/模型」限制同时在途的上游请求数（`channels.json` 的 `maxConcurrency` /
 * `models[].maxConcurrency`，键由 upstream/routes.ts 的 concurrencyFor 决定）。
 *
 * Vertex AI 直连实测（2026-10-22）：限流按模型各算各的，每个模型连着只放过 2–3 条，之后大约每
 * 40–50 秒放一条，所以每个模型配 2。一单多张在 BFF 里拆成 N 条请求，多个任务也会同时出图，排队必须
 * 放在任务之上。上限只管同时在途，挡不住持续超速；超出的 429 由 upstream/vertex.ts 在请求内退避重发。
 *
 * 计数默认在进程内（InMemoryConcurrencyGate），通过 ConcurrencyGate 端口抽象预留扩展点：
 * 未来扩成多个 worker 副本时，可直接替换为跨进程租约实现（例如数据库或 Redis 槽位表），
 * 上游执行器无需改动。
 */

export interface ConcurrencyGate {
  /**
   * 等到目标通道有空位再返回 release；`signal` 中止时放弃排队并抛出中止原因，不占位。
   * release 只能调一次，重复调用会被忽略。
   */
  acquire(channelId: string, limit: number, signal?: AbortSignal): Promise<() => void>
}

interface Gate {
  active: number
  waiting: Array<() => void>
}

export class InMemoryConcurrencyGate implements ConcurrencyGate {
  private readonly gates = new Map<string, Gate>()

  async acquire(channelId: string, limit: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal)
    let gate = this.gates.get(channelId)
    if (!gate) {
      gate = { active: 0, waiting: [] }
      this.gates.set(channelId, gate)
    }
    const current = gate
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
      if (current.active === 0 && this.gates.get(channelId) === current)
        this.gates.delete(channelId)
    }
  }

  stateFor(channelId: string): { active: number; waiting: number } {
    const gate = this.gates.get(channelId)
    return { active: gate?.active ?? 0, waiting: gate?.waiting.length ?? 0 }
  }

  gateCount(): number {
    return this.gates.size
  }
}

export const defaultConcurrencyGate = new InMemoryConcurrencyGate()

let activeConcurrencyGate: ConcurrencyGate = defaultConcurrencyGate

export function getConcurrencyGate(): ConcurrencyGate {
  return activeConcurrencyGate
}

export function setConcurrencyGateForTesting(gate?: ConcurrencyGate): void {
  activeConcurrencyGate = gate ?? defaultConcurrencyGate
}

/**
 * 等到渠道有空位再返回 release；`signal` 中止时放弃排队并抛出中止原因，不占位。
 * release 只能调一次，重复调用会被忽略。
 */
export function acquireChannelSlot(
  channelId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<() => void> {
  return activeConcurrencyGate.acquire(channelId, limit, signal)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Upstream request aborted', 'AbortError')
}

function activeInMemoryGate(): InMemoryConcurrencyGate {
  return activeConcurrencyGate instanceof InMemoryConcurrencyGate
    ? activeConcurrencyGate
    : defaultConcurrencyGate
}

/** 测试用：看某个渠道当前占了几个位、排了几个。 */
export function channelSlotStateForTesting(channelId: string): { active: number; waiting: number } {
  return activeInMemoryGate().stateFor(channelId)
}

/** 测试用：当前还留着 gate 的渠道数（闲下来的渠道不该留）。 */
export function channelGateCountForTesting(): number {
  return activeInMemoryGate().gateCount()
}
