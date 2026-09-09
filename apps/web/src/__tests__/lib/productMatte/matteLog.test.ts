import { describe, expect, it } from 'vitest'
import { logMatteFailure } from '../../../lib/productMatte/matteLog'
import { silenceMatteLog } from '../../helpers/matteLog'

describe('logMatteFailure', () => {
  it('一条日志带后端、原因与耗时，占比只有质量判定那一路才有', () => {
    const warn = silenceMatteLog()
    logMatteFailure({
      backend: 'wasm-u2netp',
      reason: 'too-small',
      elapsedMs: 1200,
      coverage: 0.01,
    })

    expect(warn).toHaveBeenCalledWith(
      '[matte] backend=wasm-u2netp reason=too-small elapsed=1200ms coverage=0.0100',
    )
  })

  it('不把图片抄进日志', () => {
    const warn = silenceMatteLog()
    logMatteFailure({
      backend: 'cloudflare-birefnet',
      reason: 'server',
      elapsedMs: 30,
      error: new Error('400 rejected data:image/png;base64,AAAABBBB'),
    })

    const line = String(warn.mock.calls[0][0])
    expect(line).toContain('message=400 rejected data:…')
    expect(line).not.toContain('AAAABBBB')
  })

  it('过长的上游报错截断，没有 error 就不写 message', () => {
    const warn = silenceMatteLog()
    logMatteFailure({ backend: 'wasm-u2netp', reason: 'failed', elapsedMs: 5 })
    logMatteFailure({
      backend: 'wasm-u2netp',
      reason: 'failed',
      elapsedMs: 5,
      error: 'x'.repeat(500),
    })

    expect(warn.mock.calls[0][0]).toBe('[matte] backend=wasm-u2netp reason=failed elapsed=5ms')
    expect(String(warn.mock.calls[1][0])).toHaveLength(
      '[matte] backend=wasm-u2netp reason=failed elapsed=5ms message='.length + 200,
    )
  })
})
