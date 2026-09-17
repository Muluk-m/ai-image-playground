import { describe, expect, it } from 'bun:test'
import { type AlertObservation, type AlertState, evaluateAlerts } from '../ops-alerts'

const minute = 60_000
const hour = 60 * minute
const GB = 1024 ** 3
const T0 = 1_789_000_000_000

function host(diskAvailableGb: number, memAvailableRatio = 0.5) {
  return {
    sampled_at: T0,
    disk_total_bytes: 50 * GB,
    disk_available_bytes: diskAvailableGb * GB,
    mem_total_bytes: 4 * GB,
    mem_available_bytes: 4 * GB * memAvailableRatio,
  }
}

/** 把一串（时间，观测）依次喂进去，返回每一步发出的消息，状态在步与步之间传递。 */
function run(steps: Array<[number, AlertObservation]>): string[][] {
  let state: AlertState = {}
  return steps.map(([at, observation]) => {
    const result = evaluateAlerts(observation, state, at)
    state = result.state
    return result.messages.map((message) => `${message.kind}:${message.rule}`)
  })
}

describe('阈值两侧', () => {
  it.each([
    ['磁盘 84% 不报', { host: host(8) }, []],
    ['磁盘 85% 报', { host: host(7.5) }, ['firing:disk']],
    ['排队 10 分钟整不报', { queue: { oldest_queued_wait_ms: 10 * minute } }, []],
    ['排队超过 10 分钟报', { queue: { oldest_queued_wait_ms: 10 * minute + 1 } }, ['firing:queue']],
    ['备份 26 小时整不报', { backup: { latest_modified_at: T0 - 26 * hour } }, []],
    [
      '备份超过 26 小时报',
      { backup: { latest_modified_at: T0 - 26 * hour - 1 } },
      ['firing:backup'],
    ],
    ['心跳 2 分钟整不报', { heartbeats: { bff: T0 - 2 * minute } }, []],
    [
      '心跳断了超过 2 分钟报',
      { heartbeats: { bff: T0 - 2 * minute - 1 } },
      ['firing:heartbeat:bff'],
    ],
  ] as Array<[string, AlertObservation, string[]]>)('%s', (_name, observation, expected) => {
    expect(run([[T0, observation]])[0]).toEqual(expected)
  })
})

describe('内存要持续吃紧才报', () => {
  it('一次瞬时偏低不报，连续 5 分钟才报', () => {
    const low = { host: host(30, 0.05) }
    expect(
      run([
        [T0, low],
        [T0 + 2 * minute, low],
        [T0 + 5 * minute, low],
      ]),
    ).toEqual([[], [], ['firing:memory']])
  })

  it('中间缓过来一次就重新计时', () => {
    const low = { host: host(30, 0.05) }
    const fine = { host: host(30, 0.5) }
    expect(
      run([
        [T0, low],
        [T0 + 4 * minute, fine],
        [T0 + 5 * minute, low],
        [T0 + 9 * minute, low],
        [T0 + 10 * minute, low],
      ]),
    ).toEqual([[], [], [], [], ['firing:memory']])
  })
})

describe('去重与恢复', () => {
  const full = { host: host(2) }
  const fine = { host: host(30) }

  it('同一条规则一小时内只提醒一次，过了一小时还没好再提醒', () => {
    expect(
      run([
        [T0, full],
        [T0 + minute, full],
        [T0 + 59 * minute, full],
        [T0 + 60 * minute, full],
      ]),
    ).toEqual([['firing:disk'], [], [], ['firing:disk']])
  })

  it('恢复时发一条已恢复，且只发一次', () => {
    expect(
      run([
        [T0, full],
        [T0 + minute, fine],
        [T0 + 2 * minute, fine],
      ]),
    ).toEqual([['firing:disk'], ['resolved:disk'], []])
  })

  it('恢复之后再犯，立刻重新提醒，不受一小时限制', () => {
    expect(
      run([
        [T0, full],
        [T0 + minute, fine],
        [T0 + 2 * minute, full],
      ]),
    ).toEqual([['firing:disk'], ['resolved:disk'], ['firing:disk']])
  })

  it('读数贴着告警线浮动时不来回刷屏：回落够多才算恢复', () => {
    // 50G 的盘：剩 7.4G 是 85.2%，剩 7.6G 是 84.8%，剩 9G 是 82%。
    expect(
      run([
        [T0, { host: host(7.4) }],
        [T0 + minute, { host: host(7.6) }],
        [T0 + 2 * minute, { host: host(7.4) }],
        [T0 + 3 * minute, { host: host(7.6) }],
        [T0 + 4 * minute, { host: host(9) }],
      ]),
    ).toEqual([['firing:disk'], [], [], [], ['resolved:disk']])
  })

  it('没报过的规则不受恢复线影响：停在两条线之间不算告警', () => {
    expect(run([[T0, { host: host(7.6) }]])).toEqual([[]])
  })

  it('从没报过的规则不会凭空发已恢复', () => {
    expect(run([[T0, fine]])).toEqual([[]])
  })
})

describe('数据缺失', () => {
  it('这一轮没取到的那一块不触发，也不被当成已恢复', () => {
    expect(
      run([
        [T0, { host: host(2) }],
        [T0 + minute, {}],
        [T0 + 2 * minute, { host: host(2) }],
      ]),
    ).toEqual([['firing:disk'], [], []])
  })

  it('还没有过任何备份、还没见过心跳，不算告警：新部署的头一天本来就是这样', () => {
    expect(
      run([[T0, { backup: { latest_modified_at: null }, heartbeats: { bff: null } }]]),
    ).toEqual([[]])
  })
})

describe('报过之后读数消失', () => {
  it('后端断到连旧心跳都被清掉：继续按没好处理，到点再提醒，回来时发已恢复', () => {
    expect(
      run([
        [T0, { heartbeats: { bff: T0 - 10 * minute } }],
        [T0 + 25 * hour, { heartbeats: { bff: null } }],
        [T0 + 25 * hour + 5 * minute, { heartbeats: { bff: null } }],
        [T0 + 26 * hour, { heartbeats: { bff: T0 + 26 * hour } }],
      ]),
    ).toEqual([['firing:heartbeat:bff'], ['firing:heartbeat:bff'], [], ['resolved:heartbeat:bff']])
  })

  it('报过备份过期之后桶被清空：不当成从来没有过', () => {
    expect(
      run([
        [T0, { backup: { latest_modified_at: T0 - 30 * hour } }],
        [T0 + 2 * hour, { backup: { latest_modified_at: null } }],
        [T0 + 3 * hour, { backup: { latest_modified_at: T0 + 3 * hour } }],
      ]),
    ).toEqual([['firing:backup'], ['firing:backup'], ['resolved:backup']])
  })
})

describe('观测缺失不打断计时', () => {
  it('内存吃紧的持续期跨过一轮缺失，照样到点触发', () => {
    const tight = { host: host(30, 0.05) }
    expect(
      run([
        [T0, tight],
        [T0 + 2 * minute, {}],
        [T0 + 5 * minute, tight],
      ]),
    ).toEqual([[], [], ['firing:memory']])
  })

  it('该再提醒的那一轮恰好没取到，下一轮取到就补发', () => {
    const full = { host: host(2) }
    expect(
      run([
        [T0, full],
        [T0 + 60 * minute, {}],
        [T0 + 61 * minute, full],
      ]),
    ).toEqual([['firing:disk'], [], ['firing:disk']])
  })
})

describe('多条规则互不干扰', () => {
  it('同时触发各发各的，一条恢复不影响另一条', () => {
    expect(
      run([
        [T0, { host: host(2), queue: { oldest_queued_wait_ms: 20 * minute } }],
        [T0 + minute, { host: host(2), queue: { oldest_queued_wait_ms: null } }],
      ]),
    ).toEqual([['firing:disk', 'firing:queue'], ['resolved:queue']])
  })
})

describe('消息写明当前值与阈值', () => {
  it('磁盘', () => {
    const { messages } = evaluateAlerts({ host: host(2) }, {}, T0)
    expect(messages[0]?.text).toBe('磁盘已用 96%，只剩 2.0 GB（告警线 85%）')
  })

  it('恢复', () => {
    const fired = evaluateAlerts({ host: host(2) }, {}, T0)
    const { messages } = evaluateAlerts({ host: host(30) }, fired.state, T0 + minute)
    expect(messages[0]?.text).toBe('已恢复：磁盘已用 40%')
  })
})
