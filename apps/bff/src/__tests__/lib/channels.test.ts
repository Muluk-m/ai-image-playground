import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CHANNEL_CAPABILITIES, type ChannelCapability } from '@image-playground/shared'
import {
  _setChannelsForTesting,
  ChannelsLoadError,
  defaultChannelsPath,
  disabledModelChannel,
  getChannels,
  getDiscoveredChannels,
  getRoutableChannels,
  isModelDisabled,
  loadChannelsFromFile,
  parseChannelsConfig,
  resolveModelMedia,
  resolveQueueModel,
} from '../../lib/channels'

const SAMPLE_CHANNEL = {
  id: 'sample-openai',
  kind: 'openai-queue',
  label: 'Sample OpenAI',
  baseUrl: 'https://example.com/v1',
  auth: { type: 'bearer', secretRef: 'SAMPLE_OPENAI_KEY' },
  models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
  defaults: { apiMode: 'images', timeout: 600 },
  allowedPaths: ['images/generations'],
}

const SAMPLE_GEMINI = {
  id: 'sample-gemini',
  kind: 'gemini-queue',
  label: 'Sample Gemini',
  baseUrl: 'https://example.com/v1beta',
  auth: { type: 'query-key', secretRef: 'SAMPLE_GEMINI_KEY', queryParam: 'key' },
  models: [{ id: 'gemini-3.1-flash', label: 'Gemini Flash', capabilities: ['generate'] }],
  defaults: { responseFormatB64Json: false },
  allowedPaths: ['models/gemini-3.1-flash:generateContent'],
}

const ENV_WITH_SECRETS = (k: string): string | undefined =>
  ({ SAMPLE_OPENAI_KEY: 'sk-test-1', SAMPLE_GEMINI_KEY: 'gem-test-2' })[k]
const ENV_EMPTY = (_k: string): string | undefined => undefined

describe('parseChannelsConfig', () => {
  it('parses empty channels array without warnings', () => {
    const result = parseChannelsConfig({ channels: [] }, ENV_WITH_SECRETS)
    expect(result.channels).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('parses a valid openai-queue channel and resolves bearer secret', () => {
    const result = parseChannelsConfig({ channels: [SAMPLE_CHANNEL] }, ENV_WITH_SECRETS)
    expect(result.channels).toHaveLength(1)
    expect(result.warnings).toEqual([])
    const [ch] = result.channels
    expect(ch.id).toBe('sample-openai')
    expect(ch.kind).toBe('openai-queue')
    expect(ch.baseUrl).toBe('https://example.com/v1')
    expect(ch.auth.type).toBe('bearer')
    expect(ch.auth.secretRef).toBe('SAMPLE_OPENAI_KEY')
    expect(ch.auth.secret).toBe('sk-test-1')
    expect(ch.auth.queryParam).toBeUndefined()
  })

  it('parses a valid gemini-queue channel and captures queryParam', () => {
    const result = parseChannelsConfig({ channels: [SAMPLE_GEMINI] }, ENV_WITH_SECRETS)
    const [ch] = result.channels
    expect(ch.kind).toBe('gemini-queue')
    expect(ch.auth.type).toBe('query-key')
    expect(ch.auth.queryParam).toBe('key')
    expect(ch.auth.secret).toBe('gem-test-2')
  })

  it('warns (not throws) when secret env is missing', () => {
    const result = parseChannelsConfig({ channels: [SAMPLE_CHANNEL] }, ENV_EMPTY)
    expect(result.channels).toHaveLength(1)
    expect(result.channels[0].auth.secret).toBe('')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('sample-openai')
    expect(result.warnings[0]).toContain('SAMPLE_OPENAI_KEY')
  })

  it('drops a channel that declares its secret mandatory when the env is unset', () => {
    const result = parseChannelsConfig(
      { channels: [{ ...SAMPLE_CHANNEL, requiresSecret: true }] },
      ENV_EMPTY,
    )
    expect(result.channels).toEqual([])
    expect(result.warnings[0]).toContain('SAMPLE_OPENAI_KEY')
    expect(result.warnings[0]).toContain('will not be advertised')
  })

  it('keeps a channel that declares its secret mandatory once the env is set', () => {
    const result = parseChannelsConfig(
      { channels: [{ ...SAMPLE_CHANNEL, requiresSecret: true }] },
      ENV_WITH_SECRETS,
    )
    expect(result.channels).toHaveLength(1)
    expect(result.warnings).toEqual([])
  })

  it('keeps a disabled channel out of the list but routable for tasks already submitted', () => {
    const result = parseChannelsConfig(
      { channels: [{ ...SAMPLE_CHANNEL, requiresSecret: true, disabled: true }, SAMPLE_GEMINI] },
      ENV_WITH_SECRETS,
    )
    expect(result.channels.map((c) => c.id)).toEqual(['sample-gemini'])
    expect(result.disabled.map((c) => c.id)).toEqual(['sample-openai'])
    expect(result.disabled[0]).not.toHaveProperty('disabled')
    expect(result.disabled[0].auth.secret).toBe('sk-test-1')
    expect({ ...result.disabledModels }).toEqual({ 'gpt-image-2': 'sample-openai' })
    expect(result.warnings).toEqual([
      "channel 'sample-openai': disabled in channels.json; the channel will not be advertised or offered for new tasks",
    ])
  })

  it('still names the models of a disabled channel whose env is missing', () => {
    const result = parseChannelsConfig(
      { channels: [{ ...SAMPLE_CHANNEL, requiresSecret: true, disabled: true }] },
      ENV_EMPTY,
    )
    expect(result.channels).toEqual([])
    expect(result.disabled).toEqual([])
    expect({ ...result.disabledModels }).toEqual({ 'gpt-image-2': 'sample-openai' })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('disabled in channels.json')
    expect(result.warnings[0]).toContain('cannot be routed')
    expect(result.warnings[0]).toContain('SAMPLE_OPENAI_KEY')
  })

  it('records disabled model ids that collide with Object.prototype keys', () => {
    const result = parseChannelsConfig(
      {
        channels: [
          {
            ...SAMPLE_CHANNEL,
            disabled: true,
            models: [{ id: 'constructor', label: 'Odd', capabilities: ['generate'] }],
          },
        ],
      },
      ENV_WITH_SECRETS,
    )
    expect(Object.hasOwn(result.disabledModels, 'constructor')).toBe(true)
    _setChannelsForTesting([], result.disabled)
    expect(isModelDisabled('constructor')).toBe(true)
    expect(isModelDisabled('toString')).toBe(false)
    _setChannelsForTesting([])
  })

  it('treats disabled: false like an absent flag', () => {
    const result = parseChannelsConfig(
      { channels: [{ ...SAMPLE_CHANNEL, disabled: false }] },
      ENV_WITH_SECRETS,
    )
    expect(result.channels.map((c) => c.id)).toEqual(['sample-openai'])
    expect(result.disabled).toEqual([])
    expect({ ...result.disabledModels }).toEqual({})
  })

  it('rejects a non-boolean disabled', () => {
    expect(() =>
      parseChannelsConfig({ channels: [{ ...SAMPLE_CHANNEL, disabled: 'yes' }] }, ENV_WITH_SECRETS),
    ).toThrow(/channels\[0\]\.disabled must be boolean/)
  })

  it('rejects a non-boolean requiresSecret', () => {
    expect(() =>
      parseChannelsConfig(
        { channels: [{ ...SAMPLE_CHANNEL, requiresSecret: 'yes' }] },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/requiresSecret/)
  })

  it('treats whitespace-only env value as missing', () => {
    const result = parseChannelsConfig({ channels: [SAMPLE_CHANNEL] }, (k) =>
      k === 'SAMPLE_OPENAI_KEY' ? '   ' : undefined,
    )
    expect(result.channels[0].auth.secret).toBe('')
    expect(result.warnings).toHaveLength(1)
  })

  it('strips trailing slashes from baseUrl', () => {
    const result = parseChannelsConfig(
      { channels: [{ ...SAMPLE_CHANNEL, baseUrl: 'https://example.com/v1///' }] },
      ENV_WITH_SECRETS,
    )
    expect(result.channels[0].baseUrl).toBe('https://example.com/v1')
  })

  it('resolves baseUrlRef from env and strips trailing slashes', () => {
    const { baseUrl: _dropped, ...withRef } = SAMPLE_CHANNEL
    const result = parseChannelsConfig(
      { channels: [{ ...withRef, baseUrlRef: 'SAMPLE_BASE_URL' }] },
      (k) => (k === 'SAMPLE_BASE_URL' ? 'https://gateway.example.com/v1//' : ENV_WITH_SECRETS(k)),
    )
    expect(result.channels).toHaveLength(1)
    expect(result.channels[0].baseUrl).toBe('https://gateway.example.com/v1')
    expect(result.channels[0]).not.toHaveProperty('baseUrlRef')
    expect(result.warnings).toEqual([])
  })

  it('drops the channel with a warning when baseUrlRef env is unset', () => {
    const { baseUrl: _dropped, ...withRef } = SAMPLE_CHANNEL
    const result = parseChannelsConfig(
      { channels: [SAMPLE_GEMINI, { ...withRef, baseUrlRef: 'SAMPLE_BASE_URL' }] },
      ENV_WITH_SECRETS,
    )
    expect(result.channels.map((c) => c.id)).toEqual(['sample-gemini'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('sample-openai')
    expect(result.warnings[0]).toContain('SAMPLE_BASE_URL')
    expect(result.warnings[0]).toContain('disabled')
  })

  it('drops the channel with a warning when baseUrlRef env is whitespace only', () => {
    const { baseUrl: _dropped, ...withRef } = SAMPLE_CHANNEL
    const result = parseChannelsConfig(
      { channels: [{ ...withRef, baseUrlRef: 'SAMPLE_BASE_URL' }] },
      (k) => (k === 'SAMPLE_BASE_URL' ? '   ' : ENV_WITH_SECRETS(k)),
    )
    expect(result.channels).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })

  const resolveRef = (envValue: string) => {
    const { baseUrl: _dropped, ...withRef } = SAMPLE_CHANNEL
    return parseChannelsConfig(
      { channels: [{ ...withRef, baseUrlRef: 'SAMPLE_BASE_URL' }] },
      (k) => (k === 'SAMPLE_BASE_URL' ? envValue : ENV_WITH_SECRETS(k)),
    )
  }

  for (const bad of ['gateway.example.com', 'https://', 'https://?x', '/v1']) {
    it(`drops the channel when baseUrlRef env has no parseable host: ${bad}`, () => {
      const result = resolveRef(bad)
      expect(result.channels).toEqual([])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('not a valid absolute https:// URL')
    })
  }

  for (const scheme of ['http://gateway.example.com/v1', 'ftp://gateway.example.com/v1']) {
    it(`drops the channel when baseUrlRef env is not https: ${scheme}`, () => {
      const result = resolveRef(scheme)
      expect(result.channels).toEqual([])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('must use https://')
    })
  }

  for (const loopback of [
    'http://localhost:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
  ]) {
    it(`accepts plaintext http for the loopback host: ${loopback}`, () => {
      const result = resolveRef(loopback)
      expect(result.channels).toHaveLength(1)
      expect(result.channels[0].baseUrl).toBe(loopback)
      expect(result.warnings).toEqual([])
    })
  }

  it('rejects a channel that sets both baseUrl and baseUrlRef', () => {
    expect(() =>
      parseChannelsConfig(
        { channels: [{ ...SAMPLE_CHANNEL, baseUrlRef: 'SAMPLE_BASE_URL' }] },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/exactly one of baseUrl or baseUrlRef/)
  })

  it('rejects a channel that sets neither baseUrl nor baseUrlRef', () => {
    const { baseUrl: _dropped, ...withoutBase } = SAMPLE_CHANNEL
    expect(() => parseChannelsConfig({ channels: [withoutBase] }, ENV_WITH_SECRETS)).toThrow(/http/)
  })

  it('rejects baseUrlRef that is not UPPER_SNAKE_CASE', () => {
    const { baseUrl: _dropped, ...withRef } = SAMPLE_CHANNEL
    expect(() =>
      parseChannelsConfig(
        { channels: [{ ...withRef, baseUrlRef: 'https://gateway.example.com/v1' }] },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/UPPER_SNAKE_CASE/)
  })

  it('rejects invalid kind', () => {
    expect(() =>
      parseChannelsConfig(
        { channels: [{ ...SAMPLE_CHANNEL, kind: 'openai-compat' }] },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(ChannelsLoadError)
  })

  it('rejects non-kebab-case id', () => {
    expect(() =>
      parseChannelsConfig(
        { channels: [{ ...SAMPLE_CHANNEL, id: 'Sample_OpenAI' }] },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/kebab-case/)
  })

  it('rejects duplicate ids', () => {
    expect(() =>
      parseChannelsConfig({ channels: [SAMPLE_CHANNEL, { ...SAMPLE_CHANNEL }] }, ENV_WITH_SECRETS),
    ).toThrow(/duplicate/)
  })

  it('rejects secretRef that looks like a real OpenAI key', () => {
    expect(() =>
      parseChannelsConfig(
        {
          channels: [
            { ...SAMPLE_CHANNEL, auth: { type: 'bearer', secretRef: 'sk-real-leaked-key' } },
          ],
        },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/UPPER_SNAKE_CASE/)
  })

  it('rejects secretRef that has lowercase letters even if not a known secret', () => {
    expect(() =>
      parseChannelsConfig(
        {
          channels: [
            { ...SAMPLE_CHANNEL, auth: { type: 'bearer', secretRef: 'my_lowercase_env' } },
          ],
        },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/UPPER_SNAKE_CASE/)
  })

  it('rejects baseUrl that is not http(s)', () => {
    expect(() =>
      parseChannelsConfig(
        { channels: [{ ...SAMPLE_CHANNEL, baseUrl: 'ftp://example.com' }] },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/http/)
  })

  it('rejects query-key auth without queryParam', () => {
    expect(() =>
      parseChannelsConfig(
        {
          channels: [
            {
              ...SAMPLE_GEMINI,
              auth: { type: 'query-key', secretRef: 'SAMPLE_GEMINI_KEY' },
            },
          ],
        },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/queryParam.*must be non-empty/)
  })

  it('rejects model with invalid capability', () => {
    expect(() =>
      parseChannelsConfig(
        {
          channels: [
            {
              ...SAMPLE_CHANNEL,
              models: [{ id: 'm', label: 'M', capabilities: ['mutate'] }],
            },
          ],
        },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/capability/)
  })

  // 回归 f4c79ca：shared 加了 'size'，BFF 本地那份白名单没跟上，initChannels 直接抛错、
  // 服务被 launchd 反复重启。输入从 tuple 派生，以后新增 token 自动被这条用例覆盖。
  it('accepts a model declaring every capability in CHANNEL_CAPABILITIES', () => {
    const result = parseChannelsConfig(
      {
        channels: [
          {
            ...SAMPLE_CHANNEL,
            models: [{ id: 'm', label: 'M', capabilities: [...CHANNEL_CAPABILITIES] }],
          },
        ],
      },
      ENV_WITH_SECRETS,
    )
    expect(result.channels).toHaveLength(1)
    const [ch] = result.channels
    expect(ch.models[0].capabilities).toEqual([...CHANNEL_CAPABILITIES])
  })

  it('keeps the declared media on the model and defaults it to image', () => {
    const result = parseChannelsConfig(
      {
        channels: [
          {
            ...SAMPLE_CHANNEL,
            models: [
              { id: 'v', label: 'V', media: 'video', capabilities: ['generate'] },
              { id: 'i', label: 'I', capabilities: ['generate'] },
            ],
          },
        ],
      },
      ENV_WITH_SECRETS,
    )
    const [ch] = result.channels
    expect(ch.models[0].media).toBe('video')
    expect(ch.models[1].media).toBeUndefined()

    _setChannelsForTesting(result.channels)
    expect(getDiscoveredChannels()[0]?.models[0]?.media).toBe('video')
    expect(resolveModelMedia('v')).toBe('video')
    expect(resolveModelMedia('i')).toBe('image')
    expect(resolveModelMedia('absent')).toBeUndefined()
  })

  it('rejects an unknown model media', () => {
    expect(() =>
      parseChannelsConfig(
        {
          channels: [
            {
              ...SAMPLE_CHANNEL,
              models: [{ id: 'm', label: 'M', media: 'audio', capabilities: ['generate'] }],
            },
          ],
        },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/media/)
  })

  it('keeps selector badges and eta on the discovered model, omitting them when absent', () => {
    const result = parseChannelsConfig(
      {
        channels: [
          {
            ...SAMPLE_CHANNEL,
            models: [
              {
                id: 'b',
                label: 'B',
                capabilities: ['generate'],
                badges: ['fast', 'value'],
                etaSeconds: 3,
                logo: 'nano-banana',
              },
              {
                id: 'ranged',
                label: 'Ranged',
                capabilities: ['generate'],
                etaSeconds: 40,
                etaMaxSeconds: 100,
              },
              { id: 'plain', label: 'Plain', capabilities: ['generate'] },
            ],
          },
        ],
      },
      ENV_WITH_SECRETS,
    )
    _setChannelsForTesting(result.channels)
    const [tagged, ranged, plain] = getDiscoveredChannels()[0]!.models
    expect(tagged).toMatchObject({ badges: ['fast', 'value'], etaSeconds: 3, logo: 'nano-banana' })
    expect(tagged).not.toHaveProperty('etaMaxSeconds')
    expect(ranged).toMatchObject({ etaSeconds: 40, etaMaxSeconds: 100 })
    expect(plain).not.toHaveProperty('badges')
    expect(plain).not.toHaveProperty('etaSeconds')
    expect(plain).not.toHaveProperty('logo')
  })

  it.each([
    [{ badges: 'fast' }, /badges must be an array/],
    [{ badges: ['newest'] }, /invalid badge 'newest'/],
    [{ badges: ['fast', 'fast'] }, /duplicate badge 'fast'/],
    [{ etaSeconds: 0 }, /etaSeconds/],
    [{ etaSeconds: 2.5 }, /etaSeconds/],
    [{ etaSeconds: '14' }, /etaSeconds/],
    [{ etaSeconds: 40, etaMaxSeconds: 3601 }, /etaMaxSeconds must be an integer/],
    [{ etaSeconds: 40, etaMaxSeconds: 60.5 }, /etaMaxSeconds must be an integer/],
    [{ etaMaxSeconds: 100 }, /etaMaxSeconds must come with a smaller etaSeconds/],
    [{ etaSeconds: 40, etaMaxSeconds: 40 }, /etaMaxSeconds must come with a smaller etaSeconds/],
    [{ logo: 'banana' }, /invalid logo 'banana'/],
    [{ logo: ['nano-banana'] }, /invalid logo/],
  ])('rejects malformed selector metadata %j', (extra, error) => {
    expect(() =>
      parseChannelsConfig(
        {
          channels: [
            {
              ...SAMPLE_CHANNEL,
              models: [{ id: 'm', label: 'M', capabilities: ['generate'], ...extra }],
            },
          ],
        },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(error)
  })

  it('keeps maxConcurrency on the internal gemini channel and out of discovery', () => {
    const result = parseChannelsConfig(
      { channels: [{ ...SAMPLE_GEMINI, maxConcurrency: 2 }] },
      ENV_WITH_SECRETS,
    )
    expect(result.channels[0]!.maxConcurrency).toBe(2)
    _setChannelsForTesting(result.channels)
    expect(getDiscoveredChannels()[0]).not.toHaveProperty('maxConcurrency')
  })

  it.each([
    [{ ...SAMPLE_GEMINI, maxConcurrency: 0 }, /maxConcurrency must be an integer between 1 and 64/],
    [{ ...SAMPLE_GEMINI, maxConcurrency: 1.5 }, /maxConcurrency must be an integer/],
    [{ ...SAMPLE_GEMINI, maxConcurrency: '2' }, /maxConcurrency must be an integer/],
    [{ ...SAMPLE_CHANNEL, maxConcurrency: 2 }, /only supported on gemini-queue/],
  ])('rejects an unusable maxConcurrency %#', (channel, error) => {
    expect(() => parseChannelsConfig({ channels: [channel] }, ENV_WITH_SECRETS)).toThrow(error)
  })

  it('rejects empty models array', () => {
    expect(() =>
      parseChannelsConfig({ channels: [{ ...SAMPLE_CHANNEL, models: [] }] }, ENV_WITH_SECRETS),
    ).toThrow(/models must be a non-empty array/)
  })

  it('rejects empty allowedPaths', () => {
    expect(() =>
      parseChannelsConfig(
        { channels: [{ ...SAMPLE_CHANNEL, allowedPaths: [] }] },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/allowedPaths/)
  })

  it('rejects unknown apiMode in defaults', () => {
    expect(() =>
      parseChannelsConfig(
        {
          channels: [{ ...SAMPLE_CHANNEL, defaults: { apiMode: 'completions' } }],
        },
        ENV_WITH_SECRETS,
      ),
    ).toThrow(/apiMode/)
  })

  it('rejects root that is not an object', () => {
    expect(() => parseChannelsConfig([], ENV_WITH_SECRETS)).toThrow(ChannelsLoadError)
    expect(() => parseChannelsConfig('not json object', ENV_WITH_SECRETS)).toThrow()
  })

  it('rejects channels field that is not an array', () => {
    expect(() => parseChannelsConfig({ channels: 'oops' }, ENV_WITH_SECRETS)).toThrow(
      /channels must be an array/,
    )
  })
})

describe('shipped channels.json', () => {
  const shipped: unknown = JSON.parse(readFileSync(defaultChannelsPath(), 'utf8'))

  it('advertises both GPT Image 2.5 models with mask support, Flare first', () => {
    const result = parseChannelsConfig(shipped, (key) =>
      key === 'OPENAI_API_KEY' ? 'openai-key' : undefined,
    )

    const capabilities: ChannelCapability[] = [
      'generate',
      'edit',
      'mask',
      'quality',
      'n',
      'moderation',
    ]
    expect(result.channels.find((c) => c.id === 'openai-images')?.models).toEqual([
      {
        id: 'gpt-image-2.5-flare',
        label: 'GPT Image 2.5 Flare',
        capabilities,
        badges: ['recommended'],
        // 线上实测单张约 39–45 秒，四个质量档像素一样、耗时也接近。
        etaSeconds: 40,
      },
      {
        id: 'gpt-image-2.5-sunburst',
        label: 'GPT Image 2.5 Sunburst',
        capabilities,
        etaSeconds: 40,
      },
    ])
  })

  it('advertises only Grok Image 2.0 on the grok-images channel', () => {
    const result = parseChannelsConfig(
      shipped,
      (key) => ({ GROK_BASE_URL: 'https://api.x.ai/v1', GROK_API_KEY: 'grok-key' })[key],
    )

    expect(result.channels.find((c) => c.id === 'grok-images')?.models).toEqual([
      {
        id: 'grok-imagine-image-2.0',
        label: 'Grok Imagine Image 2.0',
        capabilities: ['generate', 'edit', 'n', 'quality'],
        // 线上实测：低档约 40 秒、中档约 70 秒、高档（2K）约 100 秒，选择器显示成范围。
        etaSeconds: 40,
        etaMaxSeconds: 100,
      },
    ])
  })

  it('hides Agnes and Gemini even with every secret set, keeping only GPT, Grok, Seedance and Veo', () => {
    const env: Record<string, string> = {
      OPENAI_API_KEY: 'openai-key',
      GEMINI_API_KEY: 'gemini-key',
      AGNES_API_KEY: 'agnes-key',
      GROK_API_KEY: 'grok-key',
      GROK_BASE_URL: 'https://api.x.ai/v1',
      ARK_API_KEY: 'ark-key',
      ARK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
      VEO_API_KEY: 'veo-key',
    }
    const result = parseChannelsConfig(shipped, (key) => env[key])

    expect(result.channels.map((c) => c.id)).toEqual([
      'openai-images',
      'grok-images',
      'grok-video',
      'ark-video',
      'veo-video',
    ])
    expect(result.disabled.map((c) => c.id)).toEqual([
      'gemini-flash-image',
      'agnes-images',
      'agnes-video',
    ])
    expect({ ...result.disabledModels }).toEqual({
      'gemini-3.1-flash-image': 'gemini-flash-image',
      'agnes-image-2.5-flash': 'agnes-images',
      'agnes-video-2.5-flash': 'agnes-video',
    })
  })

  it('drops the Seedance channel when ARK_BASE_URL is unset', () => {
    const result = parseChannelsConfig(shipped, () => undefined)

    expect(result.channels.map((c) => c.id)).not.toContain('ark-video')
    expect(result.warnings.find((w) => w.includes("channel 'ark-video'"))).toContain('ARK_BASE_URL')
  })

  it('advertises the Seedance video model once ARK_BASE_URL and ARK_API_KEY are set', () => {
    const result = parseChannelsConfig(
      shipped,
      (key) =>
        ({ ARK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3', ARK_API_KEY: 'ark-key' })[key],
    )

    const ark = result.channels.find((c) => c.id === 'ark-video')
    expect(ark?.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(ark?.auth.secret).toBe('ark-key')
    expect(ark?.models[0]).toMatchObject({
      id: 'doubao-seedance-2-0-mini-260615',
      media: 'video',
    })
  })

  it('stays out of the discovery list when VEO_API_KEY is unset', () => {
    const result = parseChannelsConfig(shipped, () => undefined)

    expect(result.channels.map((c) => c.id)).not.toContain('veo-video')
    expect(result.warnings.find((w) => w.includes("channel 'veo-video'"))).toContain('VEO_API_KEY')
  })

  it('advertises both Veo models on the Gemini v1beta root once the key is set', () => {
    const result = parseChannelsConfig(shipped, (key) =>
      key === 'VEO_API_KEY' ? 'veo-key' : undefined,
    )

    const veo = result.channels.find((c) => c.id === 'veo-video')
    expect(veo?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(veo?.auth).toMatchObject({ type: 'bearer', secret: 'veo-key' })
    expect(veo?.defaults).toMatchObject({ timeout: 600, asyncTasks: true })
    expect(veo?.models).toEqual([
      {
        id: 'veo-3.1-fast-generate-preview',
        label: 'Veo 3.1 Fast',
        media: 'video',
        capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      },
      {
        id: 'veo-3.1-lite-generate-preview',
        label: 'Veo 3.1 Lite',
        media: 'video',
        capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      },
    ])
  })

  const VERTEX_ENV: Record<string, string> = {
    VERTEX_API_KEY: 'vertex-key',
    VERTEX_BASE_URL:
      'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/',
  }

  it.each([
    ['VERTEX_API_KEY', 'VERTEX_API_KEY'],
    ['VERTEX_BASE_URL', 'VERTEX_BASE_URL'],
  ])('keeps the Vertex channel hidden while %s is unset', (missing, named) => {
    const env: Record<string, string | undefined> = { ...VERTEX_ENV, OPENAI_API_KEY: 'openai-key' }
    delete env[missing]
    const result = parseChannelsConfig(shipped, (key) => env[key])

    expect(result.channels.map((c) => c.id)).not.toContain('vertex-images')
    expect(result.warnings.find((w) => w.includes("channel 'vertex-images'"))).toContain(named)
  })

  it('advertises the three Vertex image models last, so they never become the default', () => {
    const result = parseChannelsConfig(shipped, (key) =>
      key === 'OPENAI_API_KEY' ? 'openai-key' : VERTEX_ENV[key],
    )

    expect(result.channels.map((c) => c.id)).toEqual(['openai-images', 'vertex-images'])
    const vertex = result.channels.at(-1)!
    expect(vertex).toMatchObject({
      kind: 'gemini-queue',
      baseUrl: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google',
      auth: { secretRef: 'VERTEX_API_KEY', secret: 'vertex-key' },
      // 实测同一 key 同时超过 2 条 generateContent 就 429。
      maxConcurrency: 2,
    })
    expect(vertex.models).toEqual([
      {
        id: 'gemini-nano-banana-2.1',
        label: 'Nano Banana 2.1',
        capabilities: ['generate', 'edit', 'size'],
        badges: ['latest'],
        etaSeconds: 25,
        logo: 'nano-banana',
      },
      {
        id: 'gemini-3-pro-image',
        label: 'Nano Banana Pro',
        capabilities: ['generate', 'edit', 'size'],
        badges: ['quality'],
        etaSeconds: 80,
        logo: 'nano-banana',
      },
      {
        id: 'gemini-3.1-flash-lite-image',
        label: 'Nano Banana 2 Lite',
        capabilities: ['generate', 'edit', 'size'],
        badges: ['fast', 'value'],
        etaSeconds: 3,
        logo: 'nano-banana',
      },
    ])
    _setChannelsForTesting(result.channels)
    expect(resolveQueueModel('image')).toEqual({
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
    })
    expect(resolveQueueModel('image', 'gemini-3-pro-image')).toEqual({
      provider: 'gemini',
      model: 'gemini-3-pro-image',
    })
  })
})

describe('loadChannelsFromFile', () => {
  it('returns empty + warning when file not found', () => {
    const result = loadChannelsFromFile('/tmp/this-file-should-not-exist-xxx-channels.json')
    expect(result.channels).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('not found')
  })
})

describe('module state (getChannels / getDiscoveredChannels)', () => {
  it('exposes loaded internal channels and sanitized discovery view', () => {
    const internal = parseChannelsConfig(
      { channels: [SAMPLE_CHANNEL, SAMPLE_GEMINI] },
      ENV_WITH_SECRETS,
    ).channels
    _setChannelsForTesting(internal)

    expect(getChannels()).toEqual(internal)

    const discovered = getDiscoveredChannels()
    expect(discovered).toHaveLength(2)
    for (const ch of discovered) {
      expect(ch).not.toHaveProperty('baseUrl')
      expect(ch).not.toHaveProperty('auth')
      expect(ch).not.toHaveProperty('allowedPaths')
      expect(ch).toHaveProperty('id')
      expect(ch).toHaveProperty('kind')
      expect(ch).toHaveProperty('label')
      expect(ch).toHaveProperty('models')
      expect(ch).toHaveProperty('defaults')
    }
    _setChannelsForTesting([])
  })
})

describe('module state for disabled channels', () => {
  it('routes disabled channels last and refuses only models no live channel declares', () => {
    const live = parseChannelsConfig({ channels: [SAMPLE_GEMINI] }, ENV_WITH_SECRETS).channels
    const off = parseChannelsConfig(
      {
        channels: [
          SAMPLE_CHANNEL,
          { ...SAMPLE_GEMINI, id: 'sample-gemini-old', models: SAMPLE_GEMINI.models },
        ],
      },
      ENV_WITH_SECRETS,
    ).channels
    _setChannelsForTesting(live, off)

    expect(getChannels().map((c) => c.id)).toEqual(['sample-gemini'])
    expect(getDiscoveredChannels().map((c) => c.id)).toEqual(['sample-gemini'])
    expect(getRoutableChannels().map((c) => c.id)).toEqual([
      'sample-gemini',
      'sample-openai',
      'sample-gemini-old',
    ])
    expect(isModelDisabled('gpt-image-2')).toBe(true)
    expect(disabledModelChannel('gpt-image-2')).toBe('sample-openai')
    // 还挂在在用 channel 上的同名模型照常收。
    expect(isModelDisabled('gemini-3.1-flash')).toBe(false)
    expect(resolveModelMedia('gpt-image-2')).toBeUndefined()

    _setChannelsForTesting([])
    expect(isModelDisabled('gpt-image-2')).toBe(false)
    expect(getRoutableChannels()).toEqual([])
  })
})
