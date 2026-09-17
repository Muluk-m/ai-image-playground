import type { AgentMode, AgentSkillOutcome } from '@image-playground/shared'
import { Type } from 'typebox'
import {
  agentSkillInvocation,
  agentSkillLocation,
  agentSkills,
  findAgentSkill,
  readAgentSkillFile,
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
    const label = skillLabel(mode, name)
    const suffix = typeof file === 'string' && file.trim() ? ` · ${file.trim()}` : ''
    return { title: label ? `读取技能：${label}${suffix}` : '读取技能' }
  },
  execute: (context) => async (_toolCallId, params) => {
    const loaded = await loadSkillText(context.mode, params)
    return {
      content: [{ type: 'text', text: loaded.text }],
      // 面板据 `found` 决定这一行说「读取技能」还是「没找到技能」，不靠匹配上面那段文案。
      details: { skill: loaded.outcome },
    }
  },
})

type LoadSkillParams = { readonly name?: string; readonly file?: string }

/**
 * 面板上这一步的名字。**只认这一轮看得见的那份清单**：另一个 mode 里碰巧有同名技能，
 * 不代表这一轮读得到它，拿它的标题写在这里就是在报一件没发生的事。
 */
function skillLabel(mode: AgentMode, name: unknown): string {
  const asked = typeof name === 'string' ? name.trim() : ''
  if (!asked) return ''
  return findAgentSkill(mode, asked)?.title ?? asked
}

interface LoadedSkillText {
  readonly text: string
  readonly outcome: AgentSkillOutcome
}

async function loadSkillText(mode: AgentMode, params: LoadSkillParams): Promise<LoadedSkillText> {
  const name = params.name?.trim() ?? ''
  const label = skillLabel(mode, name)
  const skill = name ? findAgentSkill(mode, name) : undefined
  // 图标跟着这一轮真找到的那条技能走，与 `/` 菜单同一张白名单；没找到时不给，界面退回默认图标。
  const icon = skill ? { icon: skill.icon } : {}
  const miss = (text: string): LoadedSkillText => ({
    text,
    outcome: { label: label || name, found: false, ...icon },
  })
  if (!skill) {
    const known = agentSkills(mode).map((one) => one.name)
    return miss(
      known.length > 0
        ? `没有名为 ${name || '(空)'} 的技能。当前可用：${known.join('、')}`
        : '当前没有可用的技能。',
    )
  }
  const file = params.file?.trim()
  if (!file) {
    return { text: agentSkillInvocation(skill), outcome: { label, found: true, ...icon } }
  }

  const result = await readAgentSkillFile(mode, skill.name, file)
  switch (result.kind) {
    case 'ok':
      return {
        text: `<skill_file name="${skill.name}" location="skill://${skill.name}/${file}">\n${result.text}\n</skill_file>`,
        outcome: { label, found: true, ...icon },
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
