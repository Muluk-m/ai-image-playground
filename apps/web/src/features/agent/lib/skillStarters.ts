import {
  AGENT_SKILL_INPUT_REF_RE,
  AGENT_SKILL_SCENES,
  type AgentSkillInput,
  type AgentSkillScene,
  type AgentSkillStarter,
  type AgentSkillSummary,
  localizedText,
  localizedTextLocale,
} from '@image-playground/shared'
import type { ComposerFill, ComposerFillSlot, TextRange } from './composerFill'

/** 一个场景展开后最多摆几条起手句：多了就不是「起手」，是一张菜单。 */
export const SCENE_STARTER_LIMIT = 3

export interface SceneStarter {
  readonly skill: AgentSkillSummary
  readonly starter: AgentSkillStarter
}

/**
 * 场景引导要摆的东西：只收**已验证**、归了场景、且有起手句的技能，按固定的场景顺序分组。
 * 没有可露出技能的场景不出现在结果里——界面上也就没有那颗点开是空的按钮。
 */
export function sceneStarters(
  skills: readonly AgentSkillSummary[],
): ReadonlyMap<AgentSkillScene, readonly SceneStarter[]> {
  const groups = new Map<AgentSkillScene, SceneStarter[]>()
  for (const scene of AGENT_SKILL_SCENES) {
    const entries = skills
      .filter((skill) => skill.verified && skill.scene === scene)
      .flatMap((skill) => skill.starters.map((starter) => ({ skill, starter })))
      .slice(0, SCENE_STARTER_LIMIT)
    if (entries.length > 0) groups.set(scene, entries)
  }
  return groups
}

export type StarterSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'input'; readonly input: AgentSkillInput }

/** 按界面语言取句子，再把 `{key}` 拆成素材位。服务端已经丢掉了引用未声明位的句子。 */
export function starterSegments(
  starter: AgentSkillStarter,
  inputs: readonly AgentSkillInput[],
  language: string,
): StarterSegment[] {
  const text = localizedText(starter.text, language)
  const segments: StarterSegment[] = []
  let at = 0
  for (const match of text.matchAll(AGENT_SKILL_INPUT_REF_RE)) {
    const input = inputs.find((one) => one.key === match[1])
    if (!input) continue
    if (match.index > at) segments.push({ kind: 'text', text: text.slice(at, match.index) })
    segments.push({ kind: 'input', input })
    at = match.index + match[0].length
  }
  if (at < text.length) segments.push({ kind: 'text', text: text.slice(at) })
  return segments
}

/**
 * 点一条起手句交给输入框的内容。素材位在文字里占位名那一段，并标出来交给输入框变成空位胶囊；
 * 示例词取同一种语言的那一份——英文句子缺席时整句连同示例词都回退中文。
 */
export function starterFill(
  skill: AgentSkillSummary,
  starter: AgentSkillStarter,
  language: string,
): ComposerFill {
  // 示例词跟着句子取同一种语言：句子回退了中文，示例词也取中文那份。
  const word = starter.highlight?.[localizedTextLocale(starter.text, language)]
  let text = ''
  let highlight: TextRange | undefined
  const slots: ComposerFillSlot[] = []
  for (const segment of starterSegments(starter, skill.inputs, language)) {
    if (segment.kind === 'input') {
      const label = localizedText(segment.input.label, language)
      const { key, multiple } = segment.input
      slots.push({ key, label, multiple, start: text.length, end: text.length + label.length })
      text += label
      continue
    }
    // 只在句子自己的文字里找示例词：位名里碰巧含着同一个词时不能选到位名上。
    const at = word && !highlight ? segment.text.indexOf(word) : -1
    if (word && at >= 0)
      highlight = { start: text.length + at, end: text.length + at + word.length }
    text += segment.text
  }
  return {
    skill: skill.name,
    text,
    ...(highlight ? { highlight } : {}),
    ...(slots.length > 0 ? { slots } : {}),
  }
}
