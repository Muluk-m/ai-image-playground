import { describe, expect, it } from 'vitest'
import { matteBadge } from '../../../../features/bgswap/lib/matteBadge'
import type { BgSwapVersion, MatteOutcome } from '../../../../features/bgswap/types'

function version(masked: boolean, matte?: MatteOutcome): BgSwapVersion {
  return {
    id: 'v1',
    taskId: 't1',
    plan: '换成木质浴室',
    prompt: '锁住产品',
    masked,
    matte,
    createdAt: 0,
  }
}

describe('matteBadge', () => {
  it('抠图成功时报实际用到的后端', () => {
    expect(
      matteBadge(version(true, { ok: true, backend: 'wasm-u2netp', elapsedMs: 3200 })),
    ).toEqual({ text: 'U²-Netp · CPU', tone: 'ok' })
  })

  it('未抠图时在旁边标出原因', () => {
    expect(matteBadge(version(false, { ok: false, reason: 'timeout' }))).toEqual({
      text: '未抠图 · 超时',
      tone: 'warn',
    })
    expect(matteBadge(version(false, { ok: false, reason: 'unsupported' }))).toEqual({
      text: '未抠图 · 不支持',
      tone: 'warn',
    })
    expect(matteBadge(version(false, { ok: false, reason: 'failed' }))).toEqual({
      text: '未抠图 · 运行错误',
      tone: 'warn',
    })
  })

  it('没记抠图结果的旧版本只报未抠图', () => {
    expect(matteBadge(version(false))).toEqual({ text: '未抠图', tone: 'warn' })
  })

  it('抠图成功的旧版本不挂标签', () => {
    expect(matteBadge(version(true))).toBeNull()
  })
})
