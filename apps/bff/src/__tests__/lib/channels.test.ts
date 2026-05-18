import { describe, expect, it } from 'bun:test'
import {
  _setChannelsForTesting,
  ChannelsLoadError,
  getChannels,
  getDiscoveredChannels,
  loadChannelsFromFile,
  parseChannelsConfig,
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
