import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentMode } from '@image-playground/shared'

// 只装配工具清单与系统提示词，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-tool-modes'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../agent-video-operator-config.json',
)

const {
  agentToolDeclarations,
  agentToolGuidance,
  agentToolStart,
  agentTurnTools,
  isAgentToolName,
} = await import('../../../../lib/agent/tools')
const { turnInitialState, expandSkillInvocation, estimatedTurnInput } = await import(
  '../../../../lib/agent/turn-input'
)
const { ensureAgentSkills, setAgentSkillsRootForTesting } = await import(
  '../../../../lib/agent/skills'
)
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

let root = ''

/** 注册表里这一轮在场的工具；澄清工具不在注册表里，所以这里把它滤掉。 */
function toolNames(mode: AgentMode): string[] {
  return agentTurnTools({
    mode,
    conversationId: 'c1',
    turnId: 't1',
    userId: null,
    deviceId: 'device-abcdefgh',
    images: {
      references: [],
      identify: () => undefined,
      attach: () => {},
    } as never,
  })
    .map((tool) => tool.name)
    .filter((name) => name !== 'askClarification')
    .sort()
}

beforeAll(async () => {
  _setChannelsForTesting([VIDEO_CHANNEL])
  root = await mkdtemp(join(tmpdir(), 'aip-tool-modes-'))
  for (const [mode, name, description, body] of [
    [
      'image',
      'main-image',
      '何时用：电商主图。不处理：视频。',
      '# 电商主图\n\n主图正文只应出现在工具返回里',
    ],
    [
      'video',
      'storyboard',
      '何时用：多镜短片。不处理：单张图。',
      '# 分镜短片\n\n分镜正文只应出现在工具返回里',
    ],
  ] as const) {
    const dir = join(root, mode, name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
      'utf8',
    )
  }
  setAgentSkillsRootForTesting(root)
  await ensureAgentSkills()
})

afterAll(async () => {
  setAgentSkillsRootForTesting(null)
  _setChannelsForTesting([])
  if (root) await rm(root, { recursive: true, force: true })
})

describe('tools filtered by creation mode', () => {
  it('keeps generateVideo out of an image turn', () => {
    expect(toolNames('image')).toEqual(['editImage', 'generateImage', 'loadSkill', 'readLibrary'])
  })

  it('gives a video turn the image tools too, so it can produce and fix a first frame', () => {
    expect(toolNames('video')).toEqual([
      'editImage',
      'generateImage',
      'generateVideo',
      'loadSkill',
      'readLibrary',
    ])
  })

  it.each([
    'image',
    'video',
  ] as const)('writes one guidance line per tool the %s turn can see', (mode) => {
    expect(agentToolGuidance(mode)).toHaveLength(toolNames(mode).length)
    const prompt = turnInitialState([], mode).systemPrompt
    for (const line of agentToolGuidance(mode)) expect(prompt).toContain(line)
  })

  it('still recognises tool names the current mode cannot call', () => {
    // 历史里的生视频结果在图片轮也要认得出来，否则那张卡就渲染不出来了。
    expect(isAgentToolName('generateVideo')).toBe(true)
    expect(isAgentToolName('loadSkill')).toBe(true)
    expect(isAgentToolName('nope')).toBe(false)
  })
})

describe('what the panel shows for a loadSkill call', () => {
  const start = (args: unknown, mode: AgentMode = 'video') =>
    agentToolStart(mode, 'loadSkill', 'call-1', args, { identify: () => undefined } as never)

  it('writes the human title, not the kebab-case name', () => {
    expect(start({ name: 'storyboard' }).title).toBe('读取技能：分镜短片')
  })

  it('names the attachment when the model asked for one', () => {
    expect(start({ name: 'storyboard', file: 'references/shot-list.md' }).title).toBe(
      '读取技能：分镜短片 · references/shot-list.md',
    )
  })

  it('falls back to what the model said when this turn cannot see that skill', () => {
    // `main-image` 只在图片轮；拿它在别的 mode 里的标题写这一行，等于报一件没发生的事。
    expect(start({ name: 'main-image' }).title).toBe('读取技能：main-image')
    expect(start({ name: 'main-image' }, 'image').title).toBe('读取技能：电商主图')
    expect(start({ name: 'nope' }).title).toBe('读取技能：nope')
    expect(start({}).title).toBe('读取技能')
  })

  it('never reserves a place on the canvas', () => {
    expect(start({ name: 'storyboard' }).outputCount).toBeUndefined()
  })
})

describe('the skills block in the system prompt', () => {
  it('lists this mode skills and nothing else', () => {
    const video = turnInitialState([], 'video').systemPrompt
    expect(video).toContain('<available_skills>')
    expect(video).toContain('<name>storyboard</name>')
    expect(video).not.toContain('main-image')
    // 清单只有 name / description / location：标题是界面用的，不占模型的上下文。
    expect(video).not.toContain('分镜短片')
  })

  it('carries descriptions but never the body', () => {
    const prompt = turnInitialState([], 'video').systemPrompt
    expect(prompt).toContain('何时用：多镜短片。不处理：单张图。')
    expect(prompt).not.toContain('分镜正文只应出现在工具返回里')
  })

  it('never leaks a server path', () => {
    const prompt = turnInitialState([], 'video').systemPrompt
    expect(prompt).toContain('skill://storyboard/SKILL.md')
    expect(prompt).not.toContain(root)
    expect(prompt).not.toContain(tmpdir())
  })
})

describe('a turn that never says which mode it is', () => {
  it('is an image turn', () => {
    // 老客户端不发 mode；它们要的从来都是图，也不该突然拿到生视频工具。
    // 只比文字：两次调用各带自己的时间戳，比整条消息会随机变红。
    const text = (messages: ReturnType<typeof estimatedTurnInput>) =>
      messages.map((message) => {
        const content = 'content' in message ? message.content : ''
        if (typeof content === 'string') return content
        return content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      })
    expect(text(estimatedTurnInput([], '画一只猫', []))).toEqual(
      text(estimatedTurnInput([], '画一只猫', [], 'image')),
    )
  })
})

describe('explicit /skill invocation', () => {
  it('replaces the text sent to the model with the full skill', () => {
    const expanded = expandSkillInvocation('/storyboard 做个 15 秒的片子', 'video')
    expect(expanded).toContain('分镜正文只应出现在工具返回里')
    expect(expanded).toContain('做个 15 秒的片子')
    expect(expanded).not.toContain(root)
  })

  it('leaves an unknown name as ordinary text', () => {
    expect(expandSkillInvocation('/nope 做个片子', 'video')).toBe('/nope 做个片子')
    expect(expandSkillInvocation('/storyboard 做个片子', 'image')).toBe('/storyboard 做个片子')
  })

  it('leaves a slash in the middle of a sentence alone', () => {
    expect(expandSkillInvocation('把 16/9 改成 9/16', 'video')).toBe('把 16/9 改成 9/16')
  })
})
