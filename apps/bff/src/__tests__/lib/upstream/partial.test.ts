import { describe, expect, it } from 'bun:test'
import { partialFailureOf } from '../../../lib/upstream/partial'

describe('partialFailureOf', () => {
  it('读回写入时的缺口记录', () => {
    expect(
      partialFailureOf({ partial_failure: { requested: 3, failed: 2, type: 'rate_limited' } }),
    ).toEqual({ requested: 3, failed: 2, type: 'rate_limited' })
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
