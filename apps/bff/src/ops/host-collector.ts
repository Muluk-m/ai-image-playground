import { type AlertState, evaluateAlerts, type HostSample } from '@image-playground/shared'
import type { AlertSender } from './alert-sender'

/**
 * 宿主机采集器。跑在一个单独的小容器里（ADR 0007）。它从宿主机只拿到几个只读文件：
 * `/proc` 下的三个文件、cgroup 目录、部署脚本写的容器名对照表，和根文件系统上的任意一个文件——
 * 对它 statfs 得到的就是那块盘的用量。读法见 `host-readings.ts`。
 * 不挂整个根目录，不挂 Docker socket，不连数据库，手里只有内部令牌。
 *
 * 这个文件刻意不 import 后端的 config：那会把数据库、上游密钥等一整套必填项拖进来，
 * 而采集容器一样都不该有。
 */

export type CollectorStage = 'read' | 'report' | 'alert'

export interface CollectorOptions {
  intervalMs: number
  read: () => Promise<HostSample>
  report: (sample: HostSample) => Promise<void>
  /** 每采到一次都会调用，无论上报成不成功。宿主机告警挂在这里：它不该依赖后端活着。 */
  onSample?: (sample: HostSample) => Promise<void> | void
  onError?: (stage: CollectorStage, error: unknown) => void
}

/**
 * 立刻采一次，之后按间隔采。读失败、上报失败都只记一笔然后等下一轮：
 * 采集器是用来发现问题的，它自己不能因为后端不可达就停下来。
 */
export function runCollector(options: CollectorOptions): () => void {
  const onError =
    options.onError ??
    ((stage, error) =>
      console.error(
        JSON.stringify({
          level: 'warn',
          service: 'host-collector',
          event: `collector.${stage}_failed`,
          err: error instanceof Error ? error.message : String(error),
        }),
      ))
  let stopped = false
  let running = false
  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      let sample: HostSample
      try {
        sample = await options.read()
      } catch (error) {
        onError('read', error)
        return
      }
      // 同步抛出的也要接住：onSample 是告警，它坏了不该连累上报。
      try {
        await options.onSample?.(sample)
      } catch (error) {
        onError('alert', error)
      }
      await options.report(sample).catch((error) => onError('report', error))
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), options.intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** 把一次读数交给后端的内部接口。 */
export function createReporter(
  bffUrl: string,
  token: string,
): (sample: HostSample) => Promise<void> {
  const endpoint = `${bffUrl.replace(/\/+$/, '')}/internal/admin/ops/host-samples`
  return async (sample) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(sample),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`backend answered ${response.status}`)
  }
}

/**
 * 宿主机的两条告警（磁盘、内存）。只靠读数本身判断，不经过后端与数据库。
 * 状态放在这个闭包里：容器重启后最多重发一次。发送失败时状态不前进，下一轮会再试——
 * 否则一条没送达的「磁盘满了」会被当成已经提醒过，安静一个小时。
 */
export function createHostAlerting(send: AlertSender): (sample: HostSample) => Promise<void> {
  let state: AlertState = {}
  return async (sample) => {
    const result = evaluateAlerts({ host: sample }, state, sample.sampled_at)
    if (result.messages.length > 0) await send(result.messages)
    state = result.state
  }
}
