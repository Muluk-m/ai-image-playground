import { readFile, statfs } from 'node:fs/promises'
import type { HostSample } from '@image-playground/shared'

/**
 * 宿主机采集器。跑在一个单独的小容器里（ADR 0007）。它从宿主机只拿到两个只读文件：
 * `/proc/meminfo`，和根文件系统上的任意一个文件——对它 statfs 得到的就是那块盘的用量。
 * 不挂整个根目录，不挂 Docker socket，不连数据库，手里只有内部令牌。
 *
 * 这个文件刻意不 import 后端的 config：那会把数据库、上游密钥等一整套必填项拖进来，
 * 而采集容器一样都不该有。
 */

export interface MemoryReading {
  totalBytes: number
  availableBytes: number
}

function meminfoField(text: string, field: string): number {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm').exec(text)
  if (!match) throw new Error(`/proc/meminfo has no ${field}`)
  return Number(match[1]) * 1024
}

/** `MemAvailable` 是内核估的「不换页还能给新进程多少」，比 MemFree 更接近运营者关心的那个数。 */
export function parseMeminfo(text: string): MemoryReading {
  return {
    totalBytes: meminfoField(text, 'MemTotal'),
    availableBytes: meminfoField(text, 'MemAvailable'),
  }
}

export interface HostPaths {
  /** 宿主机上待测文件系统里的任意一个文件，只读挂进来；statfs 看的是它背后的那块盘。 */
  diskProbe: string
  /** 宿主机的 /proc/meminfo，只读挂进来。 */
  meminfo: string
}

export async function readHostSample(
  paths: HostPaths,
  now: number = Date.now(),
): Promise<HostSample> {
  const [disk, meminfo] = await Promise.all([
    statfs(paths.diskProbe),
    readFile(paths.meminfo, 'utf8'),
  ])
  const memory = parseMeminfo(meminfo)
  return {
    sampled_at: now,
    // bavail 是非特权进程可用的块数，也就是 df 的 Avail；bfree 还含给 root 留的那部分。
    disk_total_bytes: disk.blocks * disk.bsize,
    disk_available_bytes: disk.bavail * disk.bsize,
    mem_total_bytes: memory.totalBytes,
    mem_available_bytes: memory.availableBytes,
  }
}

export type CollectorStage = 'read' | 'report'

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
      await Promise.resolve(options.onSample?.(sample)).catch((error) => onError('report', error))
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
