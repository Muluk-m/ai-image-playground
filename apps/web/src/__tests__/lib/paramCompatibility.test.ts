import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from '../../lib/apiProfiles'
import type { ChannelCapability, ClientProfile, PublicChannel } from '../../lib/channels/types'
import {
  getOutputImageLimitForSettings,
  getParamCapabilities,
  normalizeParamsForSettings,
} from '../../lib/paramCompatibility'
import { type AppSettings, DEFAULT_PARAMS } from '../../types'

const mockChannels = vi.hoisted(() => ({ list: [] as PublicChannel[] }))
vi.mock('../../lib/channels/publicChannels', () => ({
  getPublicChannels: () => mockChannels.list,
  getPublicChannel: (id: string) => mockChannels.list.find((c) => c.id === id),
}))

beforeEach(() => {
  mockChannels.list = []
})

function useChannel(
  kind: PublicChannel['kind'],
  modelId: string,
  defaults: PublicChannel['defaults'] = { apiMode: 'images', timeout: 600 },
  capabilities: ChannelCapability[] = ['generate', 'edit', 'quality', 'size'],
): ClientProfile {
  const channel: PublicChannel = {
    id: 'c1',
    kind,
    label: kind === 'gemini-queue' ? 'Gemini' : 'OpenAI',
    models: [{ id: modelId, label: modelId, capabilities }],
    defaults,
  }
  mockChannels.list = [channel]
  return { id: 'c1', source: 'builtin-edge', channelId: 'c1', selectedModelId: modelId }
}

function settingsFor(profile: ClientProfile): AppSettings {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [profile],
    activeProfileId: profile.id,
  })
}

/** 注册一条只声明 capabilities 的平台渠道，返回选中它的 profile。 */
function builtinProfile(capabilities: ChannelCapability[]): ClientProfile {
  return useChannel('openai-queue', 'm1', { apiMode: 'images', timeout: 600 }, capabilities)
}

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS)

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('resets transparent_output when output format is not png', () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS)
    const params = {
      ...DEFAULT_PARAMS,
      output_format: 'jpeg' as const,
      transparent_output: true,
    }

    expect(normalizeParamsForSettings(params, settings).transparent_output).toBe(false)
  })

  it('resets leftover transparent_output on gemini channels where the toggle is hidden', () => {
    const params = { ...DEFAULT_PARAMS, transparent_output: true }
    const settings = settingsFor(useChannel('gemini-queue', 'gemini-3.1-flash-image'))

    expect(normalizeParamsForSettings(params, settings).transparent_output).toBe(false)
  })

  it('keeps explicit no_rewrite choice across gemini channels (guard is provider-gated at dispatch)', () => {
    const params = { ...DEFAULT_PARAMS, no_rewrite: false }
    const settings = settingsFor(useChannel('gemini-queue', 'gemini-3.1-flash-image'))

    expect(normalizeParamsForSettings(params, settings).no_rewrite).toBe(false)
  })
})

describe('getParamCapabilities', () => {
  it('jpeg: transparent toggle off, compression on', () => {
    const caps = getParamCapabilities(useChannel('openai-queue', 'gpt-image-2'), 'jpeg')
    expect(caps.transparentOutput).toBe(false)
    expect(caps.compression).toBe(true)
  })

  it('gemini channel: transparent toggle always off', () => {
    expect(
      getParamCapabilities(useChannel('gemini-queue', 'gemini-3.1-flash-image'), 'png')
        .transparentOutput,
    ).toBe(false)
  })

  it('gemini channel on a gemini model: image size and thinking level are offered', () => {
    const profile = useChannel('gemini-queue', 'gemini-3.1-flash-image')
    expect(getParamCapabilities(profile, 'png').geminiImageTuning).toBe(true)
  })

  it('gemini channel on a non-gemini model: image size and thinking level are withheld', () => {
    const profile = useChannel('gemini-queue', 'imagen-4.0-generate')
    expect(getParamCapabilities(profile, 'png').geminiImageTuning).toBe(false)
  })

  it('a gemini model behind an openai channel: still withheld', () => {
    const profile = useChannel('openai-queue', 'gemini-3.1-flash-image')
    expect(getParamCapabilities(profile, 'png').geminiImageTuning).toBe(false)
  })

  it('codexCli channel: quality off', () => {
    const profile = useChannel('openai-queue', 'gpt-image-2', {
      apiMode: 'images',
      timeout: 600,
      codexCli: true,
    })
    expect(getParamCapabilities(profile, 'png').quality).toBe(false)
  })

  it('platform channel without quality capability: quality off', () => {
    mockChannels.list = [
      {
        id: 'c1',
        kind: 'openai-queue',
        label: 'C',
        models: [{ id: 'm1', label: 'M', capabilities: ['generate', 'edit'] }],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ]
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [{ id: 'bp', source: 'builtin-edge', channelId: 'c1', selectedModelId: 'm1' }],
      activeProfileId: 'bp',
    })
    expect(getParamCapabilities(getActiveApiProfile(settings), 'png').quality).toBe(false)
  })

  it('platform channel without size capability: size off', () => {
    const profile = builtinProfile(['generate', 'edit'])

    expect(getParamCapabilities(profile, 'png').size).toBe(false)
  })

  it('platform channel with size capability: size on', () => {
    const profile = builtinProfile(['generate', 'edit', 'size'])

    expect(getParamCapabilities(profile, 'png').size).toBe(true)
  })

  it('channel not loaded yet: size stays available', () => {
    mockChannels.list = []
    const profile: ClientProfile = {
      id: 'c1',
      source: 'builtin-edge',
      channelId: 'c1',
      selectedModelId: 'm1',
    }
    expect(getParamCapabilities(profile, 'png').size).toBe(true)
  })

  describe('declared Gemini image sizes', () => {
    function vertexModel(imageSizes?: unknown): ClientProfile {
      const profile = useChannel('gemini-queue', 'gemini-3.1-flash-lite-image')
      if (imageSizes !== undefined)
        (mockChannels.list[0]!.models[0] as { imageSizes?: unknown }).imageSizes = imageSizes
      return profile
    }

    it('offers only the tiers the channel declares for the model, in shared order', () => {
      expect(getParamCapabilities(vertexModel(['2K', '1K']), 'png').geminiImageSizes).toEqual([
        '1K',
        '2K',
      ])
      expect(getParamCapabilities(vertexModel(['1K']), 'png').geminiImageSizes).toEqual(['1K'])
    })

    it.each([
      [undefined],
      ['1K'],
      [['4K']],
    ])('falls back to every shared tier for a declaration of %p', (declared) => {
      expect(getParamCapabilities(vertexModel(declared), 'png').geminiImageSizes).toEqual([
        '512',
        '1K',
        '2K',
      ])
    })

    it.each([
      ['2K', '1K'],
      ['512', '1K'],
      ['1K', '1K'],
    ] as const)('moves a stored %s onto the nearest tier the model renders (%s)', (stored, next) => {
      const settings = settingsFor(vertexModel(['1K']))
      const params = { ...DEFAULT_PARAMS, gemini_image_size: stored }
      expect(normalizeParamsForSettings(params, settings).gemini_image_size).toBe(next)
    })

    it('leaves auto alone', () => {
      const settings = settingsFor(vertexModel(['1K']))
      expect(normalizeParamsForSettings(DEFAULT_PARAMS, settings).gemini_image_size).toBeUndefined()
    })
  })
})
