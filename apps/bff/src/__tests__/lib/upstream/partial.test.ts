import { describe, expect, it } from 'bun:test'
import { UpstreamPartialResultError } from '../../../lib/upstream/errors'
import {
  directAttemptImages,
  directAttemptPayload,
  partialFailureOf,
} from '../../../lib/upstream/partial'

describe('partialFailureOf', () => {
  it('读回写入时的缺口记录', () => {
    expect(
      partialFailureOf({ partial_failure: { requested: 3, failed: 2, type: 'rate_limited' } }),
    ).toEqual({ requested: 3, failed: 2, type: 'rate_limited' })
  })

  it('部分成功的错误按已出张数结算，而不是整单张数', () => {
    const payload = {
      data: [{ b64_json: 'ok' }],
      partial_failure: { requested: 2, failed: 1, type: 'upstream_error' },
    }
    const error = new UpstreamPartialResultError(payload)
    expect(directAttemptPayload(false, undefined, error)).toBe(payload)
    expect(directAttemptImages(2, directAttemptPayload(false, undefined, error))).toBe(1)
    expect(directAttemptImages(2, directAttemptPayload(false, undefined, new Error('no')))).toBe(2)
    const delivered = { data: [{ b64_json: 'a' }] }
    expect(
      directAttemptImages(
        2,
        directAttemptPayload(false, undefined, new UpstreamPartialResultError(delivered)),
        true,
      ),
    ).toBe(1)
    const extra = {
      data: [{ b64_json: 'a' }, { b64_json: 'b' }, { b64_json: 'c' }],
    }
    expect(
      directAttemptImages(
        2,
        directAttemptPayload(false, undefined, new UpstreamPartialResultError(extra)),
        true,
      ),
    ).toBe(2)
  })

  it('张数不合理或分类不认识时当没有缺口，不拿它结算', () => {
    for (const record of [
      { requested: 2, failed: 3, type: 'rate_limited' },
      { requested: 2, failed: -1, type: 'rate_limited' },
      { requested: 2, failed: 1.5, type: 'rate_limited' },
      { requested: Number.NaN, failed: 1, type: 'rate_limited' },
      { requested: 2, failed: 1, type: 'made_up' },
      { requested: '2', failed: 1, type: 'rate_limited' },
    ]) {
      expect(partialFailureOf({ partial_failure: record })).toBeUndefined()
    }
  })
})
