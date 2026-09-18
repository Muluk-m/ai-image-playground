import { describe, expect, it } from 'vitest'

import { trendRows, trendTick } from '../../../components/ops/HostTrendChart'

const hour = 60 * 60 * 1000
// 本地时间构造，断言才不随跑测试的机器所在时区变。
const at = new Date(2026, 8, 17, 9, 5).getTime()

describe('trendTick', () => {
  it('一天之内的曲线标时刻：标日期的话每个刻度都一样', () => {
    expect(trendTick(at, 20 * hour)).toBe('09:05')
  })

  it('两三天的曲线日期和时刻都要，单标哪个都会重复', () => {
    expect(trendTick(at, 48 * hour)).toBe('09-17 09:05')
  })

  it('攒满一周之后只标日期', () => {
    expect(trendTick(at, 7 * 24 * hour)).toBe('09-17')
  })
})

describe('trendRows', () => {
  const point = (at: number, cpu: number | null = 0.2) => ({
    at,
    disk_used_ratio: 0.5,
    mem_available_ratio: 0.4,
    cpu_busy_ratio: cpu,
  })

  it('breaks the line where no sample came in, so an outage is not drawn as a slope', () => {
    const rows = trendRows([point(0), point(0.5 * hour), point(9.5 * hour)])
    expect(rows.map((row) => row.at)).toEqual([0, 0.5 * hour, 1 * hour, 9.5 * hour])
    expect(rows[2]).toEqual({ at: 1 * hour, disk: null, memory: null, cpu: null })
  })

  it('turns ratios into percentages and keeps a missing CPU reading missing', () => {
    expect(trendRows([point(0, null)])).toEqual([{ at: 0, disk: 50, memory: 60, cpu: null }])
  })
})
