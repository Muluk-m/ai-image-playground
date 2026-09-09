import { describe, expect, it } from 'vitest'
import { matteGateReason } from '../../../../features/productShots/lib/matteGate'
import type { SourceMatte } from '../../../../features/productShots/types'

const READY: SourceMatte = {
  status: 'ready',
  backend: 'wasm-u2netp',
  alphaImageId: 'alpha-1',
  targetImageId: 'image-1',
  previewImageId: 'preview-1',
  edited: false,
}

const FAILED: SourceMatte = { status: 'failed', reason: 'timeout', previewImageId: null }

function readiness(over: Partial<Parameters<typeof matteGateReason>[1]> = {}) {
  return { matte: READY, matting: false, maskSupported: true, ...over }
}

describe('matteGateReason', () => {
  it('挡住抠图中与还没有记录的原图', () => {
    expect(matteGateReason('background', readiness({ matting: true }))).toBe('抠图中')
    expect(matteGateReason('background', readiness({ matte: undefined }))).toBe('抠图中')
  })

  it('挡住抠图失败的原图', () => {
    expect(matteGateReason('replace-product', readiness({ matte: FAILED }))).toBe('抠图失败')
  })

  it('抠好了就放行，蒙版与产品框不符也照放', () => {
    expect(matteGateReason('background', readiness())).toBeNull()
    expect(
      matteGateReason('background', readiness({ matte: { ...READY, agreement: 'box-mismatch' } })),
    ).toBeNull()
  })

  it('不带遮罩的动作与不支持遮罩的模型都不挡', () => {
    expect(matteGateReason('remix', readiness({ matte: FAILED }))).toBeNull()
    expect(
      matteGateReason('background', readiness({ matte: FAILED, maskSupported: false })),
    ).toBeNull()
  })
})
