import { describe, expect, it } from 'bun:test'
import { parseMeminfo, runCollector } from '../../ops/host-collector'

const MEMINFO = `MemTotal:        3753084 kB
MemFree:          148880 kB
MemAvailable:    1204536 kB
Buffers:          123456 kB
SwapTotal:             0 kB
`

describe('parseMeminfo', () => {
  it('reads total and available memory in bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 3753084 * 1024,
      availableBytes: 1204536 * 1024,
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
})
