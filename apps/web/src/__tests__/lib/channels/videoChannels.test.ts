import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setChannels } from '../../../lib/channels/channelStore'
import { isVideoModeAvailable, videoModelOptions } from '../../../lib/channels/videoChannels'
import {
  AGNES_CHANNEL,
  GROK_CHANNEL,
  IMAGE_CHANNEL,
  VEO_CHANNEL,
  VEO_FAST_MODEL,
  VEO_LITE_MODEL,
} from '../../features/video/fixtures'

const isClientCapabilityEnabled = vi.hoisted(() => vi.fn(() => true))

vi.mock('../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled,
}))

beforeEach(() => {
  isClientCapabilityEnabled.mockReturnValue(true)
  setChannels([IMAGE_CHANNEL, GROK_CHANNEL, AGNES_CHANNEL, VEO_CHANNEL])
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
      VEO_FAST_MODEL,
      VEO_LITE_MODEL,
    ])
  })

  it('把频道 id 与支持矩阵带上', () => {
    const grok = videoModelOptions()[0]!
    expect(grok.channelId).toBe('grok-video')
    expect(grok.label).toBe('Grok')
    // 尾帧本来就在协议里，不跟渠道声明走；声音和关键帧是后加的，没声明就不开放。
    expect(grok.support.lastFrame).toBe(true)
    expect(grok.support.voices).toBeUndefined()
    expect(grok.support.keyframes).toBeUndefined()
  })

  it('Veo 两个模型各带自己的标签', () => {
    const veo = videoModelOptions().filter((option) => option.channelId === 'veo-video')
    expect(veo.map((option) => option.label)).toEqual(['Veo 3.1 Fast', 'Veo 3.1 Lite'])
    expect(veo.map((option) => option.support.tagline)).toEqual(['原生音频', '经济档'])
  })
})

describe('参考图能力', () => {
  it('渠道没声明 reference_images 时不开放参考图，免得旧后端静默丢掉它们', () => {
    const grok = videoModelOptions().find((option) => option.modelId === 'grok-imagine-video')!
    expect(grok.support.referenceImages).toBeUndefined()
    expect(grok.support.firstFrame).toBe(true)
  })

  it('渠道声明了才按矩阵开放', () => {
    const model = GROK_CHANNEL.models[0]!
    setChannels([
      {
        ...GROK_CHANNEL,
        models: [{ ...model, capabilities: [...model.capabilities, 'reference_images'] }],
      },
    ])
    expect(videoModelOptions()[0]!.support.referenceImages).toEqual({
      max: 7,
      maxResolution: '720p',
      withFrames: true,
    })
  })

  it('渠道声明了声音和关键帧才按矩阵开放', () => {
    const model = GROK_CHANNEL.models[0]!
    setChannels([
      {
        ...GROK_CHANNEL,
        models: [{ ...model, capabilities: [...model.capabilities, 'voices', 'keyframes'] }],
      },
    ])
    expect(videoModelOptions()[0]!.support.voices).toEqual({ max: 3 })
    expect(videoModelOptions()[0]!.support.keyframes).toEqual({ max: 4 })
    expect(videoModelOptions()[0]!.support.lastFrame).toBe(true)
  })
})

describe('视频可用性', () => {
  it('能力开启且有视频频道时可用', () => {
    expect(isVideoModeAvailable()).toBe(true)
  })

  it('能力关闭时不可用', () => {
    isClientCapabilityEnabled.mockReturnValue(false)
    expect(isVideoModeAvailable()).toBe(false)
  })

  it('纯静态部署没有视频频道时不可用', () => {
    setChannels([IMAGE_CHANNEL])
    expect(isVideoModeAvailable()).toBe(false)
  })
})
