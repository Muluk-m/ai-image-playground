import { Type } from 'typebox'
import { loadSkillText, replayedSkillTexts, skillLabel } from '../../../../lib/agent/skill-loader'
import { agentSkills, findAgentSkill } from '../../../../lib/agent/skills'
import { defineAgentTool } from '../adapter'

export { replayedSkillTexts }

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
    const loaded = await loadSkillText(context.mode, context.userId, params, context.experience)
    return {
      content: [{ type: 'text', text: loaded.text }],
      // 面板据 `found` 决定这一行说「读取技能」还是「没找到技能」，不靠匹配上面那段文案。
      details: { skill: loaded.outcome },
    }
  },
})
