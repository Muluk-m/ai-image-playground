import { describe, expect, it } from 'bun:test'
import { storyboardRangeLabel, storyboardShotLabel } from '../storyboard'

describe('旧分镜记录的镜头行首', () => {
  it('按镜号与时间段拼出，半秒照原样写', () => {
    expect(storyboardRangeLabel({ startSeconds: 3.5, seconds: 3 })).toBe('3.5-6.5')
    expect(storyboardShotLabel(2, { startSeconds: 5, seconds: 5 })).toBe('镜头2（5-10秒）')
  })
})
