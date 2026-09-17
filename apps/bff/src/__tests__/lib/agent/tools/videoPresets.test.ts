import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { TSchema } from 'typebox'

// 只装配工具清单与系统提示词，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-video-presets'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../agent-video-operator-config.json',
)

const { agentToolDeclarations, agentToolGuidance } = await import('../../../../lib/agent/tools')
const { estimateToolDeclarationTokens } = await import('../../../../lib/agent/turn-input')
const { _setChannelsForTesting } = await import('../../../../lib/channels')

type InternalChannel = import('../../../../lib/channels').InternalChannel

const GROK = 'grok-imagine-video'
const AGNES = 'agnes-video-2.5-flash'
const VEO_LITE = 'veo-3.1-lite-generate-preview'

function videoChannel(modelId: string): InternalChannel {
  return {
    id: 'video-gateway',
    kind: 'openai-queue',
    label: 'Video',
    baseUrl: 'https://gateway.example/v1',
    auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
    allowedPaths: ['videos/generations'],
    models: [{ id: modelId, label: modelId, media: 'video', capabilities: ['generate'] }],
    defaults: { asyncTasks: true },
  }
}

/** 这个部署此刻发给模型的那一份生视频声明。 */
function declaration(modelId: string) {
  _setChannelsForTesting([videoChannel(modelId)])
  const found = agentToolDeclarations('video').find((one) => one.name === 'generateVideo')
  expect(found).toBeDefined()
  return found!
}

function fieldDescription(modelId: string, field: string): string {
  const properties = (
    declaration(modelId).parameters as TSchema & {
      properties: Record<string, { description?: string }>
    }
  ).properties
  return properties[field]?.description ?? ''
}

function guidance(modelId: string): string {
  _setChannelsForTesting([videoChannel(modelId)])
  return agentToolGuidance('video').join('\n')
}

afterAll(() => {
  _setChannelsForTesting([])
})

describe('生视频工具的参数说明跟着这个部署解析到的模型走', () => {
  it('lists the durations this model actually has, not the global ladder', () => {
    // Grok 没有 4 / 6 秒；把全局档位写给模型，它就会理直气壮地填一个出不来的值。
    expect(fieldDescription(GROK, 'durationSeconds')).toContain('5 / 8 / 10 / 15 秒')
    expect(fieldDescription(GROK, 'durationSeconds')).not.toContain('4 / 5 / 6 / 8 / 10 / 15')
  })

  it('spells the durations out per resolution where the model splits them', () => {
    const text = fieldDescription(VEO_LITE, 'durationSeconds')
    // Veo 的 1080p 只配 8 秒；不分档写，模型会以为 1080p 也能要 4 秒。
    expect(text).toContain('720p 下 4 / 6 / 8 秒')
    expect(text).toContain('1080p 下 8 秒')
  })

  it('lists the resolutions and aspect ratios this model actually has', () => {
    expect(fieldDescription(AGNES, 'resolution')).toContain('720p')
    expect(fieldDescription(AGNES, 'resolution')).not.toContain('1080p')
    expect(fieldDescription(VEO_LITE, 'aspectRatio')).toContain('16:9 / 9:16')
    expect(fieldDescription(VEO_LITE, 'aspectRatio')).not.toContain('1:1')
    expect(fieldDescription(GROK, 'aspectRatio')).toContain('16:9 / 9:16 / 1:1')
  })

  it('names the model so the answer to the user can name it too', () => {
    expect(fieldDescription(VEO_LITE, 'durationSeconds')).toContain('Veo 3.1 Lite')
    expect(fieldDescription(GROK, 'durationSeconds')).toContain('Grok')
  })

  it('keeps every value expressible so an impossible ask can be reported, not swapped', () => {
    // schema 收窄到模型支持的值，模型就只能替用户挑一个别的档位——正是要治的那件事。
    const properties = (
      declaration(VEO_LITE).parameters as TSchema & {
        properties: Record<string, { anyOf?: { const?: string }[] }>
      }
    ).properties
    expect(properties.aspectRatio?.anyOf?.map((one) => one.const)).toEqual(['16:9', '9:16', '1:1'])
  })

  it('tells the model in the system prompt what this deployment can do', () => {
    expect(guidance(VEO_LITE)).toContain('Veo 3.1 Lite')
    expect(guidance(VEO_LITE)).toContain('1080p 下 8 秒')
    expect(guidance(GROK)).toContain('Grok')
    expect(guidance(GROK)).not.toContain('Veo')
  })

  it('keeps the reservation estimate reading the same declaration the model gets', () => {
    // 估算另列一份工具名就会在这里对不上：两个模型的清单长度不同，估算也必须跟着不同。
    _setChannelsForTesting([videoChannel(GROK)])
    const grok = estimateToolDeclarationTokens('video')
    _setChannelsForTesting([videoChannel(VEO_LITE)])
    const veo = estimateToolDeclarationTokens('video')
    expect(grok).not.toBe(veo)
  })
})
