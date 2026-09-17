import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { AgentMode } from '@image-playground/shared'
import type { AgentImageSource, AgentVideoLookup } from '../../../../lib/agent/images'

// 门禁、参数与引用回执，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-stitch-videos'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../agent-video-operator-config.json',
)

const { stitchVideos } = await import('../../../../lib/agent/tools/stitchVideos')
const { agentToolDeclarations, agentToolGuidance, agentTurnTools } = await import(
  '../../../../lib/agent/tools'
)
const { setFfmpegForTesting } = await import('../../../../lib/ffmpeg')
const { estimateTurnInputTokens } = await import('../../../../lib/agent/turn-input')
const { _setChannelsForTesting } = await import('../../../../lib/channels')

type InternalChannel = import('../../../../lib/channels').InternalChannel

const VIDEO_CHANNEL: InternalChannel = {
  id: 'video-gateway',
  kind: 'openai-queue',
  label: 'Video',
  baseUrl: 'https://gateway.example/v1',
  auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
  allowedPaths: ['videos/generations'],
  models: [
    {
      id: 'grok-imagine-video',
      label: 'grok-imagine-video',
      media: 'video',
      capabilities: ['generate'],
    },
  ],
  defaults: { asyncTasks: true },
}

beforeEach(() => {
  _setChannelsForTesting([VIDEO_CHANNEL])
  setFfmpegForTesting({ available: true })
})

afterEach(() => {
  setFfmpegForTesting()
  _setChannelsForTesting([])
})

function toolNames(mode: AgentMode): string[] {
  return agentTurnTools({
    mode,
    conversationId: 'c1',
    turnId: 't1',
    userId: null,
    deviceId: 'device-abcdefgh',
    images: { references: [], identify: () => undefined, attach: () => {} } as never,
  })
    .map((tool) => tool.name)
    .sort()
}

describe('what makes the stitch tool appear at all', () => {
  it('needs ffmpeg on this machine: without it the tool is not offered', () => {
    setFfmpegForTesting({ available: false })
    expect(stitchVideos.available?.('video')).toBe(false)
    expect(toolNames('video')).not.toContain('stitchVideos')
  })

  it('never joins an image turn, which has no segments to stitch', () => {
    expect(stitchVideos.modes).toEqual(['video'])
    expect(toolNames('image')).not.toContain('stitchVideos')
  })

  it('joins a video turn when ffmpeg is here', () => {
    expect(stitchVideos.available?.('video')).toBe(true)
    expect(toolNames('video')).toContain('stitchVideos')
  })

  /** 模型收到的清单、预扣估算读的声明、系统提示词里的指引必须是同一份。 */
  it('shows up in all three places a tool is announced, or in none', () => {
    const declared = agentToolDeclarations('video').map((tool) => tool.name)
    expect(declared).toContain('stitchVideos')
    expect(agentToolGuidance('video').join('\n')).toContain('拼接')
    expect(toolNames('video')).toContain('stitchVideos')

    setFfmpegForTesting({ available: false })
    expect(agentToolDeclarations('video').map((tool) => tool.name)).not.toContain('stitchVideos')
    expect(agentToolGuidance('video')).toHaveLength(agentToolDeclarations('video').length - 1)
  })

  it('lets the model retry instead of killing the turn: stitching costs nothing', () => {
    expect(stitchVideos.onError).toBe('continue')
  })
})

describe('what the panel and the canvas see when the call starts', () => {
  const call = (args: unknown) => stitchVideos.call(args, 'video')

  it('writes the title the model gave', () => {
    expect(call({ videoIds: ['a', 'b'], title: '咖啡的一天' }).title).toBe('拼接：咖啡的一天')
  })

  it('falls back to a plain label when no title came', () => {
    expect(call({ videoIds: ['a', 'b'] }).title).toBe('拼接视频')
  })

  it('reserves exactly one place on the canvas: a stitch produces one film', () => {
    expect(call({ videoIds: ['a', 'b'] }).outputCount).toBe(1)
  })

  it.each([
    ['one segment', { videoIds: ['a'] }],
    ['no arguments at all', {}],
    ['a videoIds that is not an array', { videoIds: 'a,b' }],
  ])('reserves nothing for %s, so no frame is left spinning forever', (_label, args) => {
    expect(call(args).outputCount).toBeUndefined()
  })

  it('anchors the film next to the first segment', () => {
    expect(call({ videoIds: ['seg-1', 'seg-2'] }).anchor).toBe('seg-1')
  })
})

function sourceWith(lookups: Record<string, AgentVideoLookup>): AgentImageSource {
  return {
    videoIds: Object.keys(lookups).filter((id) => lookups[id]!.kind === 'ready'),
    resolveVideo: async (id: string) => lookups[id] ?? { kind: 'unknown' },
    note: () => {},
  } as unknown as AgentImageSource
}

function run(images: AgentImageSource, params: unknown) {
  return stitchVideos
    .create({
      mode: 'video',
      conversationId: 'c1',
      turnId: 't1',
      userId: null,
      deviceId: 'device-abcdefgh',
      images,
    })
    .execute('call-1', params as never, undefined, undefined)
}

const READY: AgentVideoLookup = {
  kind: 'ready',
  video: {
    videoId: 'agent_ok',
    taskId: 'task-1',
    outputIndex: 0,
    mime: 'video/mp4',
    writeTo: async () => 0,
  },
}

describe('references the model got wrong', () => {
  it('explains an id this conversation never produced, and lists the ones it has', async () => {
    const result = await run(sourceWith({ agent_ok: READY, ghost: { kind: 'unknown' } }), {
      videoIds: ['agent_ok', 'ghost'],
    })
    const text = JSON.stringify(result.content)
    expect(text).toContain('ghost')
    expect(text).toContain('没有这个视频 id')
    expect(text).toContain('agent_ok')
    expect(result.details.artifacts).toBeUndefined()
  })

  it('explains a segment that exists but cannot be read yet', async () => {
    const result = await run(sourceWith({ agent_ok: READY, pending: { kind: 'unavailable' } }), {
      videoIds: ['agent_ok', 'pending'],
    })
    expect(JSON.stringify(result.content)).toContain('还取不出来')
  })

  it('says so plainly when the turn has produced no video at all', async () => {
    const result = await run(sourceWith({}), { videoIds: ['a', 'b'] })
    expect(JSON.stringify(result.content)).toContain('先把各镜的视频生成出来再拼')
  })

  it('refuses a single segment without touching ffmpeg', async () => {
    const result = await run(sourceWith({ agent_ok: READY }), { videoIds: ['agent_ok'] })
    expect(JSON.stringify(result.content)).toContain('至少要 2 段')
    expect(result.details.artifacts).toBeUndefined()
  })
})

/**
 * 视频轮每一轮都要为这个工具付一点常驻上下文，预扣跟着涨。区间宽到不会因为改几个字
 * 就变红，窄到「又往清单里塞了一整个工具」一定顶穿——那时如实调区间并写清为什么。
 */
describe('这个工具在视频轮上的常驻成本', () => {
  const ask = () => estimateTurnInputTokens([], '把背景换成浅木色', [], 'video')

  it('pins what a video turn reserves for its input', () => {
    // 3138 = 不带拼接工具的 2800 + 工具声明 179 + 系统提示词里那句逐工具指引 159。
    expect(ask()).toBeGreaterThan(3_050)
    expect(ask()).toBeLessThan(3_250)
  })

  it('charges nothing where the tool is not offered', () => {
    const withTool = ask()
    setFfmpegForTesting({ available: false })
    const withoutTool = ask()
    expect(withTool - withoutTool).toBeGreaterThan(250)
    expect(withTool - withoutTool).toBeLessThan(450)
    expect(withoutTool).toBeLessThan(2_900)
  })

  it('reads the same answer for the estimate and for the tools actually sent', () => {
    // 预扣估算与真正发出去的清单是两个时刻读同一个标志。探测只在启动做一次、
    // 之后不再翻面，这条不变量才成立（`lib/ffmpeg.ts`）。
    const declared = agentToolDeclarations('video').map((tool) => tool.name)
    expect(declared.includes('stitchVideos')).toBe(toolNames('video').includes('stitchVideos'))
    setFfmpegForTesting({ available: false })
    const off = agentToolDeclarations('video').map((tool) => tool.name)
    expect(off.includes('stitchVideos')).toBe(toolNames('video').includes('stitchVideos'))
  })
})
