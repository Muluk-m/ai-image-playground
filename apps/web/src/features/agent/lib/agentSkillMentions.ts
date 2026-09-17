import type { AgentSkillSummary } from '@image-playground/shared'
import type { SuggestionMenuGroup } from '../../../components/SuggestionMenu'
import { i18next } from '../../../i18n'

/**
 * 技能的显式调用写成 `/skill-name 其余文字`，且**只认开头**：斜杠出现在句中时用户在写正经话，
 * 不该弹菜单。服务端按同一条规则展开（`turn-input.ts` 的 `expandSkillInvocation`）。
 */
const SLASH_QUERY_RE = /^[A-Za-z0-9-]*$/

export interface SlashSkillQuery {
  /** 斜杠本身的位置，永远是 0。选中候选时从这里开始替换。 */
  readonly start: number
  readonly query: string
}

export function getSlashSkillQuery(prompt: string, cursor: number): SlashSkillQuery | null {
  if (!prompt.startsWith('/') || cursor < 1 || cursor > prompt.length) return null
  const query = prompt.slice(1, cursor)
  if (!SLASH_QUERY_RE.test(query)) return null
  // 光标后面紧跟着的还是名字的一部分时也算：用户正在中间补字。
  const rest = prompt.slice(cursor)
  const tail = rest.split(/\s/, 1)[0] ?? ''
  return SLASH_QUERY_RE.test(tail) ? { start: 0, query } : null
}

/** 打的是名字（`/story`），但看的是标题，所以两边都匹配。 */
export function skillMatches(query: string, skill: AgentSkillSummary): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return (
    skill.name.toLowerCase().includes(normalized) || skill.title.toLowerCase().includes(normalized)
  )
}

/** 选中候选后的新提示词：整段名字被换掉，光标落在名字后面的那个空格之后。 */
export function applySkillCommand(
  prompt: string,
  cursor: number,
  name: string,
): { readonly prompt: string; readonly cursor: number } {
  const rest = prompt.slice(cursor)
  const tail = rest.replace(/^[A-Za-z0-9-]*/, '')
  const head = `/${name} `
  return { prompt: head + tail.replace(/^\s+/, ''), cursor: head.length }
}

export function buildAgentSkillGroups<T>(
  query: string,
  skills: readonly AgentSkillSummary[],
  toValue: (skill: AgentSkillSummary) => T,
): SuggestionMenuGroup<T>[] {
  // 主行是人看的标题，次行是「何时用」；插进输入框的仍是 `/name`，服务端只认它。
  const options = skills
    .filter((skill) => skillMatches(query, skill))
    .map((skill) => ({
      key: `skill:${skill.name}`,
      label: skill.title,
      description: skill.description,
      value: toValue(skill),
    }))
  if (options.length === 0) return []
  return [{ key: 'skills', heading: i18next.t('mentions.headingSkills', { ns: 'agent' }), options }]
}
