import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDerive, deriveOptions } from '../../../../features/video/lib/derive'
import { setChannels } from '../../../../lib/channels/channelStore'
import { AGNES_CHANNEL, GROK_CHANNEL, videoTask } from '../fixtures'

function reasons(task: Parameters<typeof deriveOptions>[0]) {
  return Object.fromEntries(
    deriveOptions(task).map((option) => [option.mode, option.disabledReason]),
  )
}

beforeEach(() => {
  setChannels([GROK_CHANNEL, AGNES_CHANNEL])
})

afterEach(() => {
  setChannels([])
})

describe('派生可用性', () => {
  it('完成的 5 秒视频两种派生都开放，走支持它的那条频道', () => {
    const task = videoTask({ duration: 5 })

    expect(reasons(task)).toEqual({ extend: undefined, edit: undefined })
    const check = checkDerive(task, 'extend')
    expect(check.ok && check.option.modelId).toBe('grok-imagine-video')
    expect(check.ok && check.option.channelId).toBe('grok-video')
  })

  it('没生成完的视频两种都不给', () => {
    expect(reasons(videoTask({ status: 'running', completedAt: null }))).toEqual({
      extend: '这条还没生成完',
      edit: '这条还没生成完',
    })
  })

  it('缺 bffRequestId 的视频不给派生', () => {
    const task = videoTask()
    delete task.bffRequestId

    expect(reasons(task).extend).toBe('这条还没生成完')
  })

  it('10 秒源片只能续写，改视频超了 8 秒上限', () => {
    expect(reasons(videoTask({ duration: 10 }))).toEqual({
      extend: undefined,
      edit: '源片超过 8 秒',
    })
  })

  it('超过 15 秒的源片两种都不给', () => {
    expect(reasons(videoTask({ duration: 20 }))).toEqual({
      extend: '源片超过 15 秒',
      edit: '源片超过 8 秒',
    })
  })

  it('不足 2 秒的源片两种都不给', () => {
    expect(reasons(videoTask({ duration: 1 })).extend).toBe('源片不足 2 秒')
  })

  it('部署里只有不支持派生的模型时两种都不给', () => {
    setChannels([AGNES_CHANNEL])

    expect(reasons(videoTask())).toEqual({
      extend: '当前部署没有支持续写的模型',
      edit: '当前部署没有支持改视频的模型',
    })
  })
})
