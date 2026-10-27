import { describe, expect, it } from 'bun:test'
import {
  agentImageShape,
  presetAspectRatio,
  sizeRatio,
  withAspectRatio,
} from '../agent-image-shape'

describe('agentImageShape', () => {
  const chosen = { gemini_aspect_ratio: '9:16', gemini_image_size: '1K' } as const

  it('openai 系任务不显示输入框的 gemini 比例，只按实际 size', () => {
    expect(agentImageShape('openai-compat', withAspectRatio(chosen, '16:9'))).toEqual({
      size: '1280x720',
      aspectRatio: '16:9',
    })
    expect(agentImageShape('openai-compat', chosen)).toEqual({})
  })

  it('gemini 任务上工具比例覆盖输入框比例，档位保留', () => {
    expect(agentImageShape('gemini', withAspectRatio(chosen, '1:1'))).toEqual({
      imageSize: '1K',
      aspectRatio: '1:1',
    })
    expect(agentImageShape('gemini', chosen)).toEqual({ imageSize: '1K', aspectRatio: '9:16' })
  })

  it('gemini 不支持的比例按派发同一规则归到最近档位显示，不显示没送出去的值', () => {
    // 派发：queueParamsFor('gemini') 用 nearestAspectRatio(size)；头部显示必须与之一致。
    expect(agentImageShape('gemini', withAspectRatio(chosen, '21:9')).aspectRatio).toBe('16:9')
    expect(agentImageShape('gemini', withAspectRatio(chosen, '2:3')).aspectRatio).toBe('3:4')
  })

  it('auto 与认不出的比例都不编一个出来', () => {
    expect(agentImageShape('openai-compat', { size: 'auto' })).toEqual({})
    expect(presetAspectRatio('16:9')).toBe('16:9')
    expect(presetAspectRatio('7:5')).toBeUndefined()
    expect(presetAspectRatio(undefined)).toBeUndefined()
    expect(sizeRatio('1024x1536')).toBe('2:3')
  })
})
