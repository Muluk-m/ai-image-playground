import { describe, expect, it } from 'vitest'
import { ProjectRequestError } from '../../../../features/canvas/lib/projectClient'
import { copyProjectErrorMessage } from '../../../../features/canvas/lib/projectCopyError'

describe('copyProjectErrorMessage', () => {
  it('uses a different sentence for each copy failure', () => {
    const quota = copyProjectErrorMessage(new ProjectRequestError(413, 'project_quota_exceeded'))
    const deleted = copyProjectErrorMessage(new ProjectRequestError(410, 'project_deleted'))
    const missing = copyProjectErrorMessage(new ProjectRequestError(404, 'project_not_found'))
    const signedOut = copyProjectErrorMessage(new ProjectRequestError(401, 'unauthorized'))
    const closed = copyProjectErrorMessage(new ProjectRequestError(403, 'canvas_sync_unavailable'))
    const switched = copyProjectErrorMessage(new Error('account_changed'))
    const other = copyProjectErrorMessage(new Error('socket failed'))
    const texts = [quota, deleted, missing, signedOut, closed, switched, other]
    expect(new Set(texts).size).toBe(texts.length)
    expect(other).toBe('复制项目失败，请重试。')
    expect(quota).toContain('上限')
    expect(deleted).toContain('删除')
    expect(missing).toContain('找不到')
    expect(signedOut).toContain('登录')
    expect(closed).toContain('环境')
    expect(switched).toContain('账号')
  })
})
