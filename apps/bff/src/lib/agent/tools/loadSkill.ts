import {
  type AgentMessageView,
  type AgentMode,
  type AgentSkillOutcome,
  LOOK_SKILL_NAME_PREFIX,
} from '@image-playground/shared'
import { Type } from 'typebox'
import {
  agentSkillInvocation,
  agentSkillLocation,
  agentSkills,
  findAgentSkill,
  readAgentSkillFile,
  resolveAgentSkill,
} from '../skills'
import { defineAgentTool } from './adapter'

const parameters = Type.Object({
  name: Type.String({
    description: '技能名，取自系统提示词 `<available_skills>` 里的 `<name>`。',
  }),
  file: Type.Optional(
    Type.String({
      description:
        '技能目录里的附属文件相对路径，例如 `references/shot-list.md`。不填就返回 SKILL.md 正文。',
    }),
  ),
})

/**
 * 技能全文的唯一入口。模型手上没有任何文件系统读工具，所以「读完整技能」必须是一个工具调用；
 * 这一层只搬文字，不生成、不落画布、不扣生成积分。
 */
export const loadSkill = defineAgentTool({
  name: 'loadSkill',
  // 两个 mode 都装，但清单里出不出现由 `available` 按「这个 mode 有没有技能」决定。
  modes: ['image', 'video'],
  label: '读取技能',
  description:
    '读取一条技能的完整指引。系统提示词里只有技能的名字与适用场景；任务匹配某条技能的适用场景时，先用它把正文读进来再动手。带上 file 可以读该技能目录里的附属文件。',
  guidance:
    '任务匹配 `<available_skills>` 里某条技能的适用场景时，先调用读取技能工具把正文读进来，按它说的做，不要凭名字猜内容；技能正文引用到附属文件时，用同一个工具的 file 参数再读一次。',
  parameters,
  // 技能读不到只是少了一份指引，模型换个名字或直接干活都行，不该把整轮拖垮。
  onError: 'continue',
  available: (mode) => agentSkills(mode).length > 0,
  // 不落画布，所以没有 outputCount；也没有送进上游的提示词。
  call: ({ name, file }, mode) => {
    const asked = typeof name === 'string' ? name.trim() : ''
    // 起跑那一刻只认得内置技能：用户模板要读库，那一步在 `execute` 里，结果卡照它落定。
    const label = skillLabel(asked, findAgentSkill(mode, asked)?.title)
    const suffix = typeof file === 'string' && file.trim() ? ` · ${file.trim()}` : ''
    return { title: label ? `读取技能：${label}${suffix}` : '读取技能' }
  },
  execute: (context) => async (_toolCallId, params) => {
    const loaded = await loadSkillText(context.mode, context.userId, params)
    return {
      content: [{ type: 'text', text: loaded.text }],
      // 面板据 `found` 决定这一行说「读取技能」还是「没找到技能」，不靠匹配上面那段文案。
      details: { skill: loaded.outcome },
    }
  },
})

/**
 * 历史里读过的技能，回放时把正文重新读回来：键是那次调用的 `toolCallId`，值是当时交给模型的那段文字。
 *
 * 回放只留每个工具结果的一行摘要，技能正文本身不落库；不补回来的话，模型每开一轮都得再读一遍
 * 同一条技能（「建模板」还连带「反推」），白花一次往返和几十秒思考。同一条技能（连同附属文件）
 * 只补最后读的那一次；照此刻的版本重读，读不到了（模板删了、文件没了）就只剩摘要。
 */
export async function replayedSkillTexts(
  history: readonly AgentMessageView[],
  mode: AgentMode,
  userId: string | null,
): Promise<ReadonlyMap<string, string>> {
  const latest = new Map<string, { toolCallId: string; name: string; file?: string }>()
  for (const message of history)
    for (const block of message.content) {
      if (block.type !== 'toolResult' || block.toolName !== 'loadSkill') continue
      const skill = block.skill
      if (!skill?.found || !skill.name) continue
      const key = `${skill.name}\0${skill.file ?? ''}`
      // 删掉再插，Map 的次序就跟着最后一次读走。
      latest.delete(key)
      latest.set(key, {
        toolCallId: block.toolCallId,
        name: skill.name,
        ...(skill.file ? { file: skill.file } : {}),
      })
    }
  const loaded = await Promise.all(
    [...latest.values()].map(async (one) => {
      const { text, outcome } = await loadSkillText(mode, userId, one)
      return outcome.found ? ([one.toolCallId, text] as const) : null
    }),
  )
  return new Map(loaded.filter((one) => one !== null))
}

type LoadSkillParams = { readonly name?: string; readonly file?: string }

/**
 * 面板上这一步的名字：读到了就用它的标题。没读到时退回模型写的那个名字——除非它是一条
 * 模板的内部标识，那串 id 对用户没有任何意义，宁可只写「读取技能」。
 */
function skillLabel(name: string, title: string | undefined): string {
  if (title) return title
  return name.startsWith(LOOK_SKILL_NAME_PREFIX) ? '' : name
}

interface LoadedSkillText {
  readonly text: string
  readonly outcome: AgentSkillOutcome
}

async function loadSkillText(
  mode: AgentMode,
  userId: string | null,
  params: LoadSkillParams,
): Promise<LoadedSkillText> {
  const name = params.name?.trim() ?? ''
  const skill = name ? await resolveAgentSkill(mode, name, userId) : undefined
  const label = skillLabel(name, skill?.title)
  // 图标跟着这一轮真找到的那条技能走，与 `/` 菜单同一张白名单；没找到时不给，界面退回默认图标。
  const icon = skill ? { icon: skill.icon } : {}
  const miss = (text: string): LoadedSkillText => ({
    text,
    outcome: { label: label || name, found: false, ...icon },
  })
  if (!skill) {
    // 只报内置技能：用户自建的模板不该在这里被一条条念出来，那是他的东西，也念不完。
    const known = agentSkills(mode).map((one) => one.name)
    return miss(
      known.length > 0
        ? `没有名为 ${name || '(空)'} 的技能。当前可用：${known.join('、')}`
        : '当前没有可用的技能。',
    )
  }
  const file = params.file?.trim()
  if (!file) {
    return {
      text: agentSkillInvocation(skill),
      outcome: { label, found: true, ...icon, name: skill.name },
    }
  }

  const result = await readAgentSkillFile(mode, skill.name, file)
  switch (result.kind) {
    case 'ok':
      return {
        text: `<skill_file name="${skill.name}" location="skill://${skill.name}/${file}">\n${result.text}\n</skill_file>`,
        outcome: { label, found: true, ...icon, name: skill.name, file },
      }
    case 'escapes-skill':
      return miss(`${file} 不在技能 ${skill.name} 的目录里，只能读该技能自己的附属文件。`)
    case 'too-large':
      return miss(`${file} 太大，读不进来；请改读技能目录里更小的那一份。`)
    default:
      return miss(
        `技能 ${skill.name} 的目录里没有 ${file}，请照 ${agentSkillLocation(skill)} 正文里写的路径再试。`,
      )
  }
}
