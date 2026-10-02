import {
  AGENT_SKILL_INPUT_REF_RE,
  AGENT_SKILL_SCENES,
  type AgentSkillInput,
  type AgentSkillScene,
  type AgentSkillStarter,
  type AgentSkillSummary,
  localizedText,
} from '@image-playground/shared'
import type { ComposerFill } from './composerFill'

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
 * 点一条起手句交给输入框的内容。素材位暂时按位名当普通文字填进去，发出去由智能体追问缺的图；
 * 示例词取同一种语言的那一份——英文句子缺席时整句连同示例词都回退中文。
 */
export function starterFill(
  skill: AgentSkillSummary,
  starter: AgentSkillStarter,
  language: string,
): ComposerFill {
  const text = starterSegments(starter, skill.inputs, language)
    .map((segment) =>
      segment.kind === 'text' ? segment.text : localizedText(segment.input.label, language),
    )
    .join('')
  const english = language.startsWith('en') && Boolean(starter.text.en)
  const highlight = english ? starter.highlight?.en : starter.highlight?.['zh-CN']
  return { skill: skill.name, text, ...(highlight ? { highlight } : {}) }
}
