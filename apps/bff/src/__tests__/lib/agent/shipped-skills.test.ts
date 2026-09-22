import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { type AgentMode, DEFAULT_AGENT_SKILL_ICON, LOOK_PURPOSES } from '@image-playground/shared'

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

const { agentSkills, defaultAgentSkillsRoot, ensureAgentSkills, findAgentSkill } = await import(
  '../../../lib/agent/skills'
)
const { agentToolDeclarations } = await import('../../../lib/agent/tools')
const { turnInitialState } = await import('../../../lib/agent/turn-input')
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

/** summary 是 `/` 菜单里那一行次级文案，长了就在菜单宽度里被截断。 */
const SUMMARY_MAX_CHARS = 30

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

/**
 * 只有登录且开了同步的用户才看得见的工具：不带观众问 `agentToolDeclarations` 时它们不在清单里，
 * 但建素材、建模板那几条技能的正文本来就该引用它们。
 */
const AUDIENCE_TOOL_NAMES: Readonly<Record<AgentMode, readonly string[]>> = {
  image: ['saveAsset', 'saveLook'],
  video: [],
}

/** 这个 mode 这一轮真的能调到的工具名。技能正文引用别的工具，模型只会照着编。 */
function toolNames(mode: AgentMode): Set<string> {
  return new Set([
    ...agentToolDeclarations(mode).map((tool) => tool.name),
    ...AUDIENCE_TOOL_NAMES[mode],
  ])
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

  it.each(MODES)('%s 轮的每条技能都写了 meta.json 里的图标与一句话简介', (mode) => {
    for (const skill of agentSkills(mode)) {
      // 读不出来时加载器会回退到默认图标 + 空简介，所以这两条就是「meta.json 合法」的判据。
      expect(skill.icon).not.toBe(DEFAULT_AGENT_SKILL_ICON)
      expect(skill.icon).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(skill.summary).not.toBe('')
      expect([...skill.summary].length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS)
      // 简介是写给用户的，`description` 那套「何时用 / 不处理」的路牌是写给模型的。
      expect(skill.summary.startsWith('何时用')).toBe(false)
    }
  })

  it('两个 mode 合起来没有两条技能撞同一个图标', () => {
    // 图标是用来一眼分辨场景的；重了就等于没有。`shared/` 下的技能两边各出现一次，按名字去重。
    const byName = new Map<string, string>()
    for (const mode of MODES) for (const one of agentSkills(mode)) byName.set(one.name, one.icon)
    const icons = [...byName.values()]
    expect(new Set(icons).size).toBe(icons.length)
  })

  it.each(MODES)('%s 轮的系统提示词里没有 meta.json 的任何内容', (mode) => {
    // `<available_skills>` 只有 name / description / location。图标与简介是界面的东西，
    // 混进常驻上下文既白花 token，也会让模型照着一句营销话去挑技能。
    const { systemPrompt } = turnInitialState([], mode)
    // 非贪婪并咬住换行：`<available_skills>` 这个词在 loadSkill 的逐工具指引里也出现过一次。
    const block =
      /<available_skills>\n([\s\S]*?)\n<\/available_skills>/.exec(systemPrompt)?.[1] ?? ''
    expect(block).not.toBe('')
    const tags = new Set([...block.matchAll(/<([a-z_]+)>/g)].map(([, tag]) => tag))
    expect([...tags].sort()).toEqual(['description', 'location', 'name', 'skill'])
    for (const skill of agentSkills(mode)) {
      expect(systemPrompt).not.toContain(skill.summary)
    }
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

/** 模板正文的固定分节，顺序也是固定的（见 CONTEXT.md「模板」）。 */
const LOOK_SECTIONS = [
  '## 1. 一句话目标',
  '## 2. 适用场景',
  '## 3. 需要用户提供的输入',
  '## 4. 工作流程',
  '## 5. 输出要求',
  '## 6. 约束与禁忌',
  '## 7. 示例',
]

/** 磁盘上自称模板的那些目录。写坏的标记会被加载器丢掉，所以判据取磁盘，不取加载结果。 */
const TEMPLATE_DIRS = readdirSync(join(defaultAgentSkillsRoot(), 'image')).filter((name) => {
  const meta: unknown = JSON.parse(
    readFileSync(join(defaultAgentSkillsRoot(), 'image', name, 'meta.json'), 'utf8'),
  )
  return typeof meta === 'object' && meta !== null && 'template' in meta
})

describe('随仓库发的预置模板', () => {
  it('首批预置模板都在', () => {
    expect(TEMPLATE_DIRS.length).toBeGreaterThanOrEqual(4)
  })

  it.each(TEMPLATE_DIRS)('%s 的模板标记过了校验', (name) => {
    // 标记写坏时加载器只丢标记、留技能：那样这条模板会从模板页上静默消失，只有这里拦得住。
    const template = findAgentSkill('image', name)?.template
    expect(template).toBeDefined()
    expect(LOOK_PURPOSES).toContain(template!.purpose)
    expect(template!.model).not.toBe('')
    expect(template!.size).not.toBe('')
    expect(template!.slotCount).toBeGreaterThanOrEqual(1)
  })

  it.each(TEMPLATE_DIRS)('%s 的封面与参考图在目录里', (name) => {
    const template = findAgentSkill('image', name)!.template!
    const directory = join(defaultAgentSkillsRoot(), 'image', name)
    for (const file of [template.cover, ...template.references]) {
      expect(existsSync(join(directory, file))).toBe(true)
    }
  })

  it.each(TEMPLATE_DIRS)('%s 的正文按固定七节依次写全', (name) => {
    const { content } = findAgentSkill('image', name)!
    let previous = -1
    for (const heading of LOOK_SECTIONS) {
      const at = content.indexOf(`\n${heading}\n`)
      expect([name, heading, at > previous]).toEqual([name, heading, true])
      previous = at
    }
  })
})
