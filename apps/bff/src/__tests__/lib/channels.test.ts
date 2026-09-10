import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CHANNEL_CAPABILITIES, type ChannelCapability } from '@image-playground/shared'
import {
  _setChannelsForTesting,
  ChannelsLoadError,
  defaultChannelsPath,
  getChannels,
  getDiscoveredChannels,
  loadChannelsFromFile,
  parseChannelsConfig,
  resolveModelMedia,
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
      { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', capabilities },
      { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', capabilities },
    ])
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
