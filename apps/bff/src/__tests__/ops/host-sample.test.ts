import { describe, expect, it } from 'bun:test'
import { createHostAlerting, runCollector } from '../../ops/host-collector'
import { parseMeminfo } from '../../ops/host-readings'

const MEMINFO = `MemTotal:        3753084 kB
MemFree:          148880 kB
MemAvailable:    1204536 kB
Buffers:          123456 kB
SwapTotal:       2035708 kB
SwapFree:        2035440 kB
`

describe('parseMeminfo', () => {
  it('reads total and available memory in bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 3753084 * 1024,
      availableBytes: 1204536 * 1024,
      swapTotalBytes: 2035708 * 1024,
      swapFreeBytes: 2035440 * 1024,
    })
  })

  it('refuses a file without MemAvailable rather than reporting a made-up number', () => {
    expect(() => parseMeminfo('MemTotal: 1 kB\nMemFree: 1 kB\n')).toThrow('MemAvailable')
  })
})

const sample = {
  sampled_at: 1_789_000_000_000,
  disk_total_bytes: 50 * 1024 ** 3,
  disk_available_bytes: 18 * 1024 ** 3,
  mem_total_bytes: 4 * 1024 ** 3,
  mem_available_bytes: 1 * 1024 ** 3,
}

describe('runCollector', () => {
  it('reads the host and hands each sample to the backend', async () => {
    const reported: unknown[] = []
    const stop = runCollector({
      intervalMs: 5,
      read: async () => sample,
      report: async (one) => {
        reported.push(one)
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    stop()
    expect(reported.length).toBeGreaterThanOrEqual(2)
    expect(reported[0]).toEqual(sample)
  })

  it('keeps sampling when the backend is unreachable', async () => {
    let reads = 0
    const errors: string[] = []
    const stop = runCollector({
      intervalMs: 5,
      read: async () => {
        reads++
        return sample
      },
      report: async () => {
        throw new Error('ECONNREFUSED')
      },
      onError: (stage, error) => errors.push(`${stage}:${(error as Error).message}`),
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    stop()
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(errors[0]).toBe('report:ECONNREFUSED')
  })

  it('survives a failed read and tries again on the next tick', async () => {
    let reads = 0
    const reported: unknown[] = []
    const stop = runCollector({
      intervalMs: 5,
      read: async () => {
        if (++reads === 1) throw new Error('EACCES /host/proc/meminfo')
        return sample
      },
      report: async (one) => {
        reported.push(one)
      },
      onError: () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    stop()
    expect(reported.length).toBeGreaterThanOrEqual(1)
  })

  it('hands every sample to onSample even when the backend is unreachable', async () => {
    // 宿主机告警挂在 onSample 上：磁盘真满的时候后端多半已经写不动了，告警不能等它。
    const seen: number[] = []
    const stop = runCollector({
      intervalMs: 5,
      read: async () => sample,
      report: async () => {
        throw new Error('ECONNREFUSED')
      },
      onSample: (one) => {
        seen.push(one.disk_available_bytes)
      },
      onError: () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop()
    expect(seen.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps going when onSample itself throws', async () => {
    const reported: unknown[] = []
    const stop = runCollector({
      intervalMs: 5,
      read: async () => sample,
      report: async (one) => {
        reported.push(one)
      },
      onSample: () => {
        throw new Error('webhook exploded')
      },
      onError: () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop()
    expect(reported.length).toBeGreaterThanOrEqual(2)
  })
})

describe('createHostAlerting', () => {
  it('sends a disk alert from the samples alone, and the recovery after it', async () => {
    const sent: string[] = []
    const alerting = createHostAlerting(async (messages) => {
      sent.push(...messages.map((message) => `${message.kind}:${message.rule}`))
    })
    const GBYTES = 1024 ** 3
    await alerting({ ...sample, disk_available_bytes: 2 * GBYTES })
    await alerting({ ...sample, disk_available_bytes: 2 * GBYTES })
    await alerting({ ...sample, disk_available_bytes: 30 * GBYTES })
    expect(sent).toEqual(['firing:disk', 'resolved:disk'])
  })

  it('retries a message the webhook refused instead of marking it delivered', async () => {
    let attempts = 0
    const alerting = createHostAlerting(async () => {
      if (++attempts === 1) throw new Error('feishu 19024')
    })
    const GBYTES = 1024 ** 3
    await alerting({ ...sample, disk_available_bytes: 2 * GBYTES }).catch(() => {})
    await alerting({ ...sample, disk_available_bytes: 2 * GBYTES })
    expect(attempts).toBe(2)
  })
})
