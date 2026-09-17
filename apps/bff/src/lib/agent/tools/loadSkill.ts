import type { AgentMode } from '@image-playground/shared'
import { Type } from 'typebox'
import {
  agentSkillInvocation,
  agentSkillLocation,
  agentSkills,
  findAgentSkill,
  findAgentSkillInAnyMode,
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
  call: ({ name, file }) => {
    const asked = typeof name === 'string' ? name.trim() : ''
    // 起跑这一刻拿不到这一轮的 mode（pi 只给参数），所以按 name 跨 mode 找一份标题；
    // 找不到就照模型说的名字写。mode 门禁在 `execute` 里，不在这一行标题上。
    const label = asked ? (findAgentSkillInAnyMode(asked)?.title ?? asked) : ''
    const suffix = typeof file === 'string' && file.trim() ? ` · ${file.trim()}` : ''
    return { title: label ? `读取技能：${label}${suffix}` : '读取技能' }
  },
  execute: (context) => async (_toolCallId, params) => ({
    content: [{ type: 'text', text: await loadSkillText(context.mode, params) }],
    details: {},
  }),
})

type LoadSkillParams = { readonly name?: string; readonly file?: string }

async function loadSkillText(mode: AgentMode, params: LoadSkillParams): Promise<string> {
  const name = params.name?.trim() ?? ''
  const skill = name ? findAgentSkill(mode, name) : undefined
  if (!skill) {
    const known = agentSkills(mode).map((one) => one.name)
    return known.length > 0
      ? `没有名为 ${name || '(空)'} 的技能。当前可用：${known.join('、')}`
      : '当前没有可用的技能。'
  }
  const file = params.file?.trim()
  if (!file) return agentSkillInvocation(skill)

  const result = await readAgentSkillFile(mode, skill.name, file)
  switch (result.kind) {
    case 'ok':
      return `<skill_file name="${skill.name}" location="skill://${skill.name}/${file}">\n${result.text}\n</skill_file>`
    case 'escapes-skill':
      return `${file} 不在技能 ${skill.name} 的目录里，只能读该技能自己的附属文件。`
    case 'too-large':
      return `${file} 太大，读不进来；请改读技能目录里更小的那一份。`
    default:
      return `技能 ${skill.name} 的目录里没有 ${file}，请照 ${agentSkillLocation(skill)} 正文里写的路径再试。`
  }
}
