import {
  type AgentMessageView,
  type AgentMode,
  type AgentSkillOutcome,
  LOOK_SKILL_NAME_PREFIX,
} from '@image-playground/shared'
import {
  agentSkillInvocation,
  agentSkillLocation,
  agentSkills,
  isCanvasOnlySkill,
  readAgentSkillFile,
  resolveAgentSkill,
} from './skills'

export interface LoadSkillParams {
  readonly name?: string
  readonly file?: string
}

/**
 * 面板上这一步的名字：读到了就用它的标题。没读到时退回模型写的那个名字——除非它是一条
 * 模板的内部标识，那串 id 对用户没有任何意义，宁可只写「读取技能」。
 */
export function skillLabel(name: string, title: string | undefined): string {
  if (title) return title
  return name.startsWith(LOOK_SKILL_NAME_PREFIX) ? '' : name
}

export interface LoadedSkillText {
  readonly text: string
  readonly outcome: AgentSkillOutcome
}

export async function loadSkillText(
  mode: AgentMode,
  userId: string | null,
  params: LoadSkillParams,
  experience?: 'chat' | 'canvas',
): Promise<LoadedSkillText> {
  const name = params.name?.trim() ?? ''
  // 画布技能只给画布模式：Agent 模式里模型照名字硬读也读不到，与技能清单同一条规则。
  const hidden = experience !== 'canvas' && isCanvasOnlySkill(name)
  const skill = name && !hidden ? await resolveAgentSkill(mode, name, userId) : undefined
  const label = skillLabel(name, skill?.title)
  // 图标跟着这一轮真找到的那条技能走，与 `/` 菜单同一张白名单；没找到时不给，界面退回默认图标。
  const icon = skill ? { icon: skill.icon } : {}
  const miss = (text: string): LoadedSkillText => ({
    text,
    outcome: { label: label || name, found: false, ...icon },
  })
  if (!skill) {
    // 只报内置技能：用户自建的模板不该在这里被一条条念出来，那是他的东西，也念不完。
    const known = agentSkills(mode)
      .map((one) => one.name)
      .filter((one) => experience === 'canvas' || !isCanvasOnlySkill(one))
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
  /** 这一轮的模式：Agent 模式不把画布技能的正文补回去（读也读不到，见 {@link loadSkillText}）。 */
  experience?: 'chat' | 'canvas',
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
      const { text, outcome } = await loadSkillText(mode, userId, one, experience)
      return outcome.found ? ([one.toolCallId, text] as const) : null
    }),
  )
  return new Map(loaded.filter((one) => one !== null))
}
