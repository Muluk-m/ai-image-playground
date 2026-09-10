import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { toQueueProvider } from '../../../lib/channels/queueClient'
import type { ProviderKind } from '../../../lib/channels/types'

interface ManifestItem {
  id: string
  recommendedProvider: ProviderKind
  recommendedModel: string
}

interface ChannelsFile {
  channels: Array<{ kind: ProviderKind; models: Array<{ id: string }> }>
}

function readJson<T>(relativeToRepoRoot: string): T {
  const url = new URL(`../../../../../../${relativeToRepoRoot}`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf-8')) as T
}

const manifest = readJson<{ items: ManifestItem[] }>('apps/web/public/inspiration-manifest.json')
// 读的是仓库里 shipped 的原始配置，不是 sanitize 后的 /api/channels；
// 部署侧的 env 门禁（requiresSecret 等）在这里故意不管，只盯 model id 漂移。
const channels = readJson<ChannelsFile>('apps/bff/channels.json')

/** 每个 provider 下内置 channel 能服务的模型 id。 */
const servableModels = new Map<string, Set<string>>()
for (const channel of channels.channels) {
  const provider = toQueueProvider(channel.kind)
  if (!provider) continue
  const set = servableModels.get(provider) ?? new Set<string>()
  for (const model of channel.models) set.add(model.id)
  servableModels.set(provider, set)
}

describe('inspiration manifest', () => {
  it('has items', () => {
    expect(manifest.items.length).toBeGreaterThan(0)
  })

  // 上游改名时这里先红，避免灵感库整片失配后才在生产上被发现。
  it('only recommends models the built-in channels can serve', () => {
    const unservable = manifest.items
      .filter((item) => {
        const provider = toQueueProvider(item.recommendedProvider)
        return !provider || !servableModels.get(provider)?.has(item.recommendedModel)
      })
      .map((item) => `${item.id}: ${item.recommendedProvider} / ${item.recommendedModel}`)
    expect(unservable).toEqual([])
  })
})
