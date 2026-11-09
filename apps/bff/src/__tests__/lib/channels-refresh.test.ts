import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setChannelsForTesting, getChannels, refreshChannelsIfChanged } from '../../lib/channels'
import {
  replaceUpstreamSecretCache,
  resetUpstreamSecretCacheForTests,
} from '../../lib/upstream-secret-cache'

// Exercise changes at the file/credential boundary without depending on a host channels file.
describe('periodic channel refresh', () => {
  it('updates availability after credential changes and replaces the advertised file contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'channel-refresh-'))
    const path = join(directory, 'channels.json')
    const channel = {
      id: 'refresh-example',
      kind: 'openai-queue',
      label: 'Refresh example',
      baseUrl: 'https://example.invalid/v1',
      auth: { type: 'bearer', secretRef: 'PERIODIC_REFRESH_FIXTURE_KEY' },
      requiresSecret: true,
      models: [{ id: 'fixture-image', label: 'Fixture image', capabilities: ['generate'] }],
      defaults: {},
      allowedPaths: ['images/generations'],
    }
    try {
      resetUpstreamSecretCacheForTests()
      writeFileSync(path, JSON.stringify({ channels: [channel] }))
      refreshChannelsIfChanged(path)
      expect(getChannels()).toEqual([])
      replaceUpstreamSecretCache(new Map([['PERIODIC_REFRESH_FIXTURE_KEY', 'fixture-only-key']]))
      refreshChannelsIfChanged(path)
      expect(getChannels().map((item) => item.id)).toEqual(['refresh-example'])
      writeFileSync(path, JSON.stringify({ channels: [{ ...channel, id: 'replacement-example' }] }))
      refreshChannelsIfChanged(path)
      expect(getChannels().map((item) => item.id)).toEqual(['replacement-example'])
      resetUpstreamSecretCacheForTests()
      refreshChannelsIfChanged(path)
      expect(getChannels()).toEqual([])
      rmSync(path)
      refreshChannelsIfChanged(path)
      expect(getChannels()).toEqual([])
    } finally {
      resetUpstreamSecretCacheForTests()
      _setChannelsForTesting([])
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
