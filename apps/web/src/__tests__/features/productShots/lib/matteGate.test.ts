import { describe, expect, it } from 'vitest'
import {
  type MatteReadiness,
  matteGateReason,
} from '../../../../features/productShots/lib/matteGate'
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

function readiness(over: Partial<MatteReadiness> = {}): MatteReadiness {
  return { matte: READY, matting: false, maskSupported: true, ...over }
}

describe('matteGateReason', () => {
  it('挡住抠图中与还没有记录的原图', () => {
    expect(matteGateReason(readiness({ matting: true }))).toBe('抠图中')
    expect(matteGateReason(readiness({ matte: undefined }))).toBe('抠图中')
  })

  it('挡住抠图失败的原图', () => {
    expect(matteGateReason(readiness({ matte: FAILED }))).toBe('抠图失败')
  })

  it('抠好了就放行，蒙版与产品框不符也照放', () => {
    expect(matteGateReason(readiness())).toBeNull()
    expect(
      matteGateReason(readiness({ matte: { ...READY, agreement: 'box-mismatch' } })),
    ).toBeNull()
  })

  it('模型不支持遮罩时不挡', () => {
    expect(matteGateReason(readiness({ matte: FAILED, maskSupported: false }))).toBeNull()
  })
})
