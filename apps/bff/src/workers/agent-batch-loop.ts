import { config } from '../config'
import { log } from '../lib/logger'
import { type AgentBatchAdvancer, getAgentBatchAdvancer } from '../modules/execution'

export interface AgentBatchLoopOptions {
  pollIntervalMs?: number
  advance?: AgentBatchAdvancer
}

/**
 * 独立推进已确认的智能体批次计划，不挂在队列 TaskScheduler 里：
 * 慢媒体准备既不占用队列轮询，也不让队列调度器反向依赖 lib/agent。
 */
export class AgentBatchLoop {
  private readonly pollIntervalMs: number
  private readonly advance: AgentBatchAdvancer
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = true
  private draining = false
  private cursor: string | null = null
  private inFlight: Promise<void> | null = null
  private generation = 0

  constructor(options: AgentBatchLoopOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? config.worker.pollIntervalMs
    this.advance = options.advance ?? getAgentBatchAdvancer()
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs)
  }

  drain(): void {
    this.generation++
    this.draining = true
  }

  resume(): void {
    this.draining = false
  }

  stop(): void {
    this.generation++
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  isIdle(): boolean {
    return this.inFlight === null
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.inFlight) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.inFlight.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  tick(): void {
    if (this.inFlight || this.stopped || this.draining) return
    const generation = this.generation
    const canDispatch = () => generation === this.generation && !this.stopped && !this.draining
    const operation = this.advance(this.cursor, canDispatch)
      .then((cursor) => {
        if (canDispatch()) this.cursor = cursor
      })
      .catch((error: unknown) => {
        log.error(
          {
            event: 'worker.batch_advance_failed',
            err: error instanceof Error ? error.message : String(error),
          },
          'batch advancement failed',
        )
      })
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null
      })
    this.inFlight = operation
  }
}
