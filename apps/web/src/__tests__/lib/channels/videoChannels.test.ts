import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setChannels } from '../../../lib/channels/channelStore'
import { isVideoModeAvailable, videoModelOptions } from '../../../lib/channels/videoChannels'
import { APP_MODE_LABELS, visibleAppModes } from '../../../store'
import { AGNES_CHANNEL, GROK_CHANNEL, IMAGE_CHANNEL } from '../../features/video/fixtures'

const isClientCapabilityEnabled = vi.hoisted(() => vi.fn(() => true))

vi.mock('../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled,
}))

beforeEach(() => {
  isClientCapabilityEnabled.mockReturnValue(true)
  setChannels([IMAGE_CHANNEL, GROK_CHANNEL, AGNES_CHANNEL])
})

afterEach(() => {
  setChannels([])
  vi.clearAllMocks()
})

describe('videoModelOptions', () => {
  it('只收 media 为 video 且档位表里有的模型', () => {
    expect(videoModelOptions().map((option) => option.modelId)).toEqual([
      'grok-imagine-video',
      'agnes-video-2.5-flash',
    ])
  })

  it('把频道 id 与支持矩阵带上', () => {
    const grok = videoModelOptions()[0]!
    expect(grok.channelId).toBe('grok-video')
    expect(grok.label).toBe('Grok')
    expect(grok.support.lastFrame).toBe(false)
  })
})

describe('视频模式入口', () => {
  it('能力开启且有视频频道时可见', () => {
    expect(isVideoModeAvailable()).toBe(true)
    expect(visibleAppModes().map((mode) => APP_MODE_LABELS[mode])).toContain('视频')
  })

  it('能力关闭时隐藏', () => {
    isClientCapabilityEnabled.mockReturnValue(false)
    expect(isVideoModeAvailable()).toBe(false)
    expect(visibleAppModes()).not.toContain('video')
  })

  it('纯静态部署没有视频频道时隐藏', () => {
    setChannels([IMAGE_CHANNEL])
    expect(isVideoModeAvailable()).toBe(false)
    expect(visibleAppModes()).not.toContain('video')
  })
})
