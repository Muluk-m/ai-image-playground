import { describe, expect, it } from 'vitest'
import {
  matteBadge,
  sourceMatteBadge,
  sourceMatteNotice,
} from '../../../../features/productShots/lib/matteBadge'
import type {
  MatteOutcome,
  ProductShotVersion,
  SourceMatte,
} from '../../../../features/productShots/types'

function version(masked: boolean, matte?: MatteOutcome): ProductShotVersion {
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

function ready(patch: Partial<Extract<SourceMatte, { status: 'ready' }>> = {}): SourceMatte {
  return {
    status: 'ready',
    backend: 'wasm-u2netp',
    alphaImageId: 'alpha-1',
    targetImageId: 'image-1',
    previewImageId: 'preview-1',
    edited: false,
    ...patch,
  }
}

const FAILED: SourceMatte = { status: 'failed', reason: 'failed', previewImageId: null }

describe('matteBadge', () => {
  it('抠图成功时报实际用到的后端', () => {
    expect(matteBadge(version(true, { ok: true, backend: 'wasm-u2netp' }))).toEqual({
      text: 'U²-Netp · CPU',
      tone: 'ok',
    })
    expect(matteBadge(version(true, { ok: true, backend: 'cloudflare-birefnet' }))).toEqual({
      text: '服务端',
      tone: 'ok',
    })
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

  it('抠出来但跟产品框对不上时报蒙版不可靠', () => {
    expect(matteBadge(version(false, { ok: false, reason: 'box-mismatch' }))).toEqual({
      text: '蒙版不可靠',
      tone: 'warn',
    })
  })

  it('没记抠图结果的旧版本只报未抠图', () => {
    expect(matteBadge(version(false))).toEqual({ text: '未抠图', tone: 'warn' })
  })

  it('抠图成功的旧版本不挂标签', () => {
    expect(matteBadge(version(true))).toBeNull()
  })

  it('整图重画的那几版不报未抠图：它们本来就不抠', () => {
    expect(matteBadge({ ...version(false), mode: 'replace-and-background' })).toBeNull()
    expect(matteBadge({ ...version(false), mode: 'remix' })).toBeNull()
  })
})

describe('sourceMatteBadge', () => {
  it('抠图中压过原图身上那份旧结论', () => {
    expect(sourceMatteBadge(undefined, true)).toEqual({ text: '抠图中', tone: 'warn' })
    expect(sourceMatteBadge(FAILED, true)).toEqual({ text: '抠图中', tone: 'warn' })
  })

  it('抠好了报抠出它的后端', () => {
    expect(sourceMatteBadge(ready(), false)).toEqual({ text: '已抠 · U²-Netp · CPU', tone: 'ok' })
    expect(sourceMatteBadge(ready({ backend: 'cloudflare-birefnet' }), false)).toEqual({
      text: '已抠 · 服务端',
      tone: 'ok',
    })
  })

  it('抠不出来报未抠，抠错对象报蒙版不可靠', () => {
    expect(sourceMatteBadge(FAILED, false)).toEqual({ text: '未抠', tone: 'warn' })
    expect(sourceMatteBadge(ready({ agreement: 'box-mismatch' }), false)).toEqual({
      text: '蒙版不可靠',
      tone: 'warn',
    })
  })

  it('手改过的压过后端与一致性', () => {
    expect(sourceMatteBadge(ready({ edited: true, agreement: 'box-mismatch' }), false)).toEqual({
      text: '手改',
      tone: 'ok',
    })
  })

  it('没抠过又没在抠的旧记录不挂标签', () => {
    expect(sourceMatteBadge(undefined, false)).toBeNull()
  })
})

describe('sourceMatteNotice', () => {
  it('抠错对象报一句', () => {
    expect(sourceMatteNotice(ready({ agreement: 'box-mismatch' }))).toBe('蒙版不可靠')
  })

  it('抠好了、还没抠与抠不出来都没有可说的', () => {
    expect(sourceMatteNotice(ready({ agreement: 'ok' }))).toBeNull()
    expect(sourceMatteNotice(ready())).toBeNull()
    expect(sourceMatteNotice(undefined)).toBeNull()
    expect(sourceMatteNotice(FAILED)).toBeNull()
  })
})
