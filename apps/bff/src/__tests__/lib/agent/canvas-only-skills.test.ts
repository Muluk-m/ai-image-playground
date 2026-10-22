import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 只读技能目录与拼提示词，一句 SQL 都不发；库名故意不可达。
process.env.DATABASE_URL = 'postgres://unused/canvas-only-skills'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'

const {
  ensureAgentSkills,
  listAgentSkillSummaries,
  setAgentSkillsRootForTesting,
  visibleAgentSkills,
} = await import('../../../lib/agent/skills')
const { replayedSkillTexts } = await import('../../../lib/agent/tools/loadSkill')
const { agentTurnTools } = await import('../../../lib/agent/tools')
const { turnInitialState } = await import('../../../lib/agent/turn-input')

let root = ''
const AGENT = { userId: null, looks: [], experience: 'chat' as const }
const CANVAS = { userId: null, looks: [], experience: 'canvas' as const }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-canvas-skills-'))
  for (const [mode, name, body] of [
    ['shared', 'script-briefs', '# 剧本简报\n\n用 createNodes 把每一镜建成节点'],
    ['image', 'main-image', '# 电商主图\n\n主图正文'],
  ] as const) {
    const dir = join(root, mode, name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: 何时用：测试。不处理：其他。\n---\n\n${body}\n`,
      'utf8',
    )
  }
  setAgentSkillsRootForTesting(root)
  await ensureAgentSkills()
})

afterAll(async () => {
  setAgentSkillsRootForTesting(null)
  if (root) await rm(root, { recursive: true, force: true })
})

const names = (skills: readonly { name: string }[]) => skills.map((skill) => skill.name)

describe('canvas-only skills', () => {
  it('lists them only for canvas mode, also when no mode is declared', async () => {
    expect(names(visibleAgentSkills('image', AGENT))).toEqual(['main-image'])
    expect(names(visibleAgentSkills('image', { userId: null, looks: [] }))).toEqual(['main-image'])
    expect(names(visibleAgentSkills('image', CANVAS)).sort()).toEqual([
      'main-image',
      'script-briefs',
    ])
    expect(names(await listAgentSkillSummaries('image', null, undefined))).toEqual(['main-image'])
    expect(names(await listAgentSkillSummaries('image', null, undefined, 'canvas')).sort()).toEqual(
      ['main-image', 'script-briefs'],
    )
  })

  it('cannot be loaded by name in Agent mode', async () => {
    const run = async (experience: 'chat' | 'canvas') => {
      const tool = agentTurnTools({
        mode: 'image',
        experience,
        conversationId: 'c1',
        turnId: 't1',
        userId: null,
        deviceId: 'device-abcdefgh',
        images: { references: [], identify: () => undefined, attach: () => {} } as never,
      }).find((one) => one.name === 'loadSkill')!
      return (await tool.execute('call', { name: 'script-briefs' } as never)) as {
        content: unknown
        details: unknown
      }
    }
    const agent = await run('chat')
    expect(JSON.stringify(agent.content)).not.toContain('createNodes')
    expect(agent.details).toMatchObject({ skill: { found: false } })
    expect(JSON.stringify(agent.content)).not.toContain('script-briefs、')
    const canvas = await run('canvas')
    expect(JSON.stringify(canvas.content)).toContain('createNodes')
  })

  it('does not replay a canvas skill read into an Agent-mode turn', async () => {
    const history = [
      {
        id: 'm1',
        role: 'assistant' as const,
        createdAt: 1,
        content: [
          { type: 'text' as const, text: '先读剧本简报' },
          {
            type: 'toolResult' as const,
            toolCallId: 'skill-call',
            toolName: 'loadSkill' as const,
            status: 'done' as const,
            title: '读取技能：script-briefs 剧本简报',
            skill: { label: '剧本简报', found: true, name: 'script-briefs' },
          },
        ],
      },
    ] as unknown as Parameters<typeof turnInitialState>[0]
    const agentTexts = await replayedSkillTexts(history, 'image', null, 'chat')
    expect(agentTexts.size).toBe(0)
    const agent = JSON.stringify(
      turnInitialState(history, 'image', true, 1, AGENT, agentTexts).messages,
    )
    expect(agent).toContain('先读剧本简报')
    expect(agent).not.toContain('script-briefs')
    expect(agent).not.toContain('createNodes')
    const canvasTexts = await replayedSkillTexts(history, 'image', null, 'canvas')
    const canvas = JSON.stringify(
      turnInitialState(history, 'image', true, 1, CANVAS, canvasTexts).messages,
    )
    expect(canvas).toContain('createNodes')
    // 回放层自己也守住：即使调用方把画布技能正文递进来，Agent 轮也不接回去。
    const leaked = JSON.stringify(
      turnInitialState(history, 'image', true, 1, AGENT, canvasTexts).messages,
    )
    expect(leaked).not.toContain('createNodes')
  })
})
