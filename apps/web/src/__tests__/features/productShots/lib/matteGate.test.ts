import { describe, expect, it } from 'vitest'
import { type MatteReadiness, matteGate } from '../../../../features/productShots/lib/matteGate'
import { MATTE_FAILURE_LABELS, type SourceMatte } from '../../../../features/productShots/types'

const READY: SourceMatte = {
  status: 'ready',
  backend: 'wasm-u2netp',
  alphaImageId: 'alpha-1',
  targetImageId: 'image-1',
  previewImageId: 'preview-1',
  edited: false,
}

const FAILED: SourceMatte = { status: 'failed', reason: 'timeout', previewImageId: null }

const UNUSABLE: SourceMatte = { ...READY, status: 'unusable', reason: 'too-small' }

function readiness(over: Partial<MatteReadiness> = {}): MatteReadiness {
  return { matte: READY, matting: false, maskSupported: true, modelKnown: true, ...over }
}

describe('matteGate', () => {
  it('挡住抠图中与还没有记录的原图，这时候重试与改蒙版都解不开', () => {
    expect(matteGate(readiness({ matting: true }))).toEqual({
      reason: '抠图中',
      retry: false,
      edit: false,
    })
    expect(matteGate(readiness({ matte: undefined }))?.reason).toBe('抠图中')
  })

  it('抠图失败只能重试', () => {
    expect(matteGate(readiness({ matte: FAILED }))).toEqual({
      reason: '抠图失败',
      retry: true,
      edit: false,
    })
  })

  it('占比不对时报占比并放出改蒙版', () => {
    expect(matteGate(readiness({ matte: UNUSABLE }))).toEqual({
      reason: '抠图占比过小',
      retry: true,
      edit: true,
    })
    expect(matteGate(readiness({ matte: { ...UNUSABLE, reason: 'too-large' } }))?.reason).toBe(
      '抠图占比过大',
    )
  })

  it('抠好了就放行，蒙版与产品框不符也照放', () => {
    expect(matteGate(readiness())).toBeNull()
    expect(matteGate(readiness({ matte: { ...READY, agreement: 'box-mismatch' } }))).toBeNull()
  })

  it('模型不支持遮罩时不挡', () => {
    expect(matteGate(readiness({ matte: FAILED, maskSupported: false }))).toBeNull()
    expect(matteGate(readiness({ matte: UNUSABLE, maskSupported: false }))).toBeNull()
  })

  it('认不出模型时挡住，重试与改蒙版都解不开', () => {
    expect(matteGate(readiness({ modelKnown: false }))).toEqual({
      reason: '模型信息已过期，请刷新页面',
      retry: false,
      edit: false,
    })
    // maskSupported 此时是猜出来的 false，不能拿它当放行理由
    expect(
      matteGate(readiness({ matte: FAILED, maskSupported: false, modelKnown: false })),
    ).toEqual({
      reason: '模型信息已过期，请刷新页面',
      retry: false,
      edit: false,
    })
  })
})

describe('MATTE_FAILURE_LABELS', () => {
  it('每个原因都有一句自己的标签', () => {
    const labels = Object.values(MATTE_FAILURE_LABELS)

    expect(labels.filter((label) => label !== '')).toEqual(labels)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
