import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { AgentMode } from '@image-playground/shared'

// 只读磁盘上随仓库发的技能目录，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/shipped-agent-skills'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
// 视频轮必须真的是视频轮，否则 video/ 下那几条技能一条都加载不出来，这个体检就成了空转。
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../agent-video-operator-config.json',
)

const { agentSkills, defaultAgentSkillsRoot, ensureAgentSkills } = await import(
  '../../../lib/agent/skills'
)
const { agentToolDeclarations } = await import('../../../lib/agent/tools')
const { _setChannelsForTesting } = await import('../../../lib/channels')

type InternalChannel = import('../../../lib/channels').InternalChannel

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

/** description 是常驻上下文里唯一进每一轮系统提示词的东西，所以它有长度上限。 */
const DESCRIPTION_MAX_CHARS = 120

const MODES: AgentMode[] = ['image', 'video']

_setChannelsForTesting([VIDEO_CHANNEL])
const diagnostics: string[] = []
const { log } = await import('../../../lib/logger')
const warn = log.warn.bind(log)
// 加载器把 frontmatter 不合规、读不出来这些事都记成 warn，不抛；体检要的正是它们。
log.warn = ((first: unknown, ...rest: unknown[]) => {
  const event = (first as { event?: string } | undefined)?.event
  if (event === 'agent.skill_diagnostic') diagnostics.push(JSON.stringify(first))
  return warn(first as never, ...(rest as never[]))
}) as typeof log.warn
await ensureAgentSkills()
log.warn = warn

/** 这个 mode 这一轮真的能调到的工具名。技能正文引用别的工具，模型只会照着编。 */
function toolNames(mode: AgentMode): Set<string> {
  return new Set(agentToolDeclarations(mode).map((tool) => tool.name))
}

const ALL_TOOL_NAMES = new Set([...toolNames('image'), ...toolNames('video')])

describe('随仓库发的技能', () => {
  it('一条 diagnostic 都不该有', () => {
    expect(diagnostics).toEqual([])
  })

  it('两个 mode 都加载出了技能', () => {
    for (const mode of MODES) expect(agentSkills(mode).length).toBeGreaterThan(0)
  })

  it.each(MODES)('%s 轮里每条技能的 name 唯一', (mode) => {
    const names = agentSkills(mode).map((skill) => skill.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(MODES)('%s 轮的每条技能 name 与目录同名', (mode) => {
    for (const skill of agentSkills(mode)) expect(basename(skill.directory)).toBe(skill.name)
  })

  it.each(MODES)('%s 轮的每条技能正文第一行是中文一级标题', (mode) => {
    for (const skill of agentSkills(mode)) {
      // 标题是界面上那个名字；没有一级标题时 `title` 会退回 kebab-case 的 name。
      expect(skill.title).not.toBe(skill.name)
      expect(skill.title).toMatch(/\p{Script=Han}/u)
    }
  })

  it.each(MODES)('%s 轮的每条 description 都写成「何时用 / 不处理」且不超长', (mode) => {
    for (const skill of agentSkills(mode)) {
      expect(skill.description).toContain('何时用')
      expect(skill.description).toContain('不处理')
      expect([...skill.description].length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS)
    }
  })

  it.each(MODES)('%s 轮的技能正文只引用这一轮调得到的工具', (mode) => {
    const allowed = toolNames(mode)
    const strayed: string[] = []
    for (const skill of agentSkills(mode)) {
      for (const [, quoted] of skill.content.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)) {
        // 只管别的 mode 才有的工具；反引号里的普通英文词（`n`、`prompt`）不是工具名。
        if (ALL_TOOL_NAMES.has(quoted) && !allowed.has(quoted))
          strayed.push(`${skill.name}:${quoted}`)
      }
    }
    expect(strayed).toEqual([])
  })

  it('磁盘上每个技能目录都被加载了出来', () => {
    const root = defaultAgentSkillsRoot()
    for (const mode of MODES) {
      const onDisk = readdirSync(`${root}/${mode}`).sort()
      const loaded = agentSkills(mode)
        .filter((skill) => skill.directory.endsWith(`/${mode}/${skill.name}`))
        .map((skill) => skill.name)
        .sort()
      expect(loaded).toEqual(onDisk)
    }
  })
})
