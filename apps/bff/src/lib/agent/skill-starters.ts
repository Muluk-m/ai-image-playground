import {
  AGENT_SKILL_INPUT_REF_RE,
  AGENT_SKILL_SCENES,
  type AgentLocalizedText,
  type AgentSkillInput,
  type AgentSkillScene,
  type AgentSkillStarter,
} from '@image-playground/shared'
import { log } from '../logger'
import { isObject } from '../type-guards'

/**
 * `meta.json` 里给场景引导用的那几段：素材位（`inputs`）、起手句（`starters`）、场景（`scene`）
 * 与验证记录（`verified`）。见 CONTEXT.md 同名词条与 ADR 0020。
 *
 * 与图标、简介同一条规矩：**写坏只回退这几段，不丢技能**，并且**一个字都不进给模型的文本**。
 */

/** 验证记录：在哪个模型下、哪天、多少分通过了人工评分。只在服务端用来算「已验证」，不发给界面。 */
export interface AgentSkillVerification {
  readonly date: string
  readonly model: string
  readonly score: number
}

export interface AgentSkillStarterMeta {
  readonly inputs: readonly AgentSkillInput[]
  readonly starters: readonly AgentSkillStarter[]
  readonly scene?: AgentSkillScene
  readonly verification?: AgentSkillVerification
}

/** 素材位 key：起手句里写成 `{key}`，与 {@link AGENT_SKILL_INPUT_REF_RE} 认的字符集一致。 */
const INPUT_KEY_RE = /^[A-Za-z0-9_-]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const TEMPLATE_INPUT_LABEL: AgentLocalizedText = { 'zh-CN': '素材', en: 'Asset' }

/**
 * 预置模板没写 `inputs` 时的素材位：`slotCount` 个名为「素材」的必填位，key 是 `asset1..N`。
 * 用户自建的模板走同一条派生，它们的存储与同步格式不变。
 */
export function templateSlotInputs(slotCount: number): AgentSkillInput[] {
  return Array.from({ length: Math.max(0, slotCount) }, (_, at) => ({
    key: `asset${at + 1}`,
    label: TEMPLATE_INPUT_LABEL,
    required: true,
    multiple: true,
  }))
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return isObject(raw) ? raw : undefined
}

function nonEmpty(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/** 中文必须有；英文缺席或为空就不带，界面回退中文。 */
function localized(raw: unknown): AgentLocalizedText | undefined {
  const value = record(raw)
  const zh = nonEmpty(value?.['zh-CN'])
  if (!zh) return undefined
  const en = nonEmpty(value?.en)
  return en ? { 'zh-CN': zh, en } : { 'zh-CN': zh }
}

function warnField(skill: string, field: string, detail?: Record<string, unknown>): void {
  log.warn(
    { event: 'agent.skill_meta_invalid', skill, field, ...detail },
    'agent skill meta.json field ignored; skill stays',
  )
}

/**
 * 一条技能的素材位。写了 `inputs` 就按写的来（写坏的那一项丢掉）；预置模板没写时由 `slotCount`
 * 派生；两样都没有就是空数组——素材位始终在，界面不必再分「有没有」。
 */
export function parseAgentSkillInputs(
  raw: unknown,
  slotCount: number | undefined,
  skill: string,
): AgentSkillInput[] {
  if (raw === undefined) return slotCount ? templateSlotInputs(slotCount) : []
  if (!Array.isArray(raw)) {
    warnField(skill, 'inputs')
    return []
  }
  const seen = new Set<string>()
  return raw.flatMap((item, at): AgentSkillInput[] => {
    const value = record(item)
    const key = typeof value?.key === 'string' ? value.key : ''
    const label = localized(value?.label)
    if (!INPUT_KEY_RE.test(key) || seen.has(key) || !label) {
      warnField(skill, 'inputs', { index: at })
      return []
    }
    seen.add(key)
    return [
      {
        key,
        label,
        required: value?.required !== false,
        multiple: value?.multiple === true,
      },
    ]
  })
}

function unknownRefs(text: string, keys: ReadonlySet<string>): string[] {
  return [...text.matchAll(AGENT_SKILL_INPUT_REF_RE)]
    .map(([, key]) => key ?? '')
    .filter((key) => !keys.has(key))
}

/** 示例词必须落在句子自己的文字里：`{key}` 引用会被换成位名，落在它上面的选不中。 */
function inPlainText(text: string, word: string): boolean {
  return text
    .split(AGENT_SKILL_INPUT_REF_RE)
    .some((part, at) => at % 2 === 0 && part.includes(word))
}

/** 示例词只留出现在对应语言句子里的那一份；一份都不剩就不带。 */
function starterHighlight(
  raw: unknown,
  text: AgentLocalizedText,
  skill: string,
  index: number,
): AgentLocalizedText | undefined {
  if (raw === undefined) return undefined
  const value = localized(raw)
  const zh = value && inPlainText(text['zh-CN'], value['zh-CN']) ? value['zh-CN'] : undefined
  const en = value?.en && text.en && inPlainText(text.en, value.en) ? value.en : undefined
  if (!zh || (value?.en && !en)) warnField(skill, 'starters.highlight', { index })
  if (!zh) return undefined
  return en ? { 'zh-CN': zh, en } : { 'zh-CN': zh }
}

/**
 * 起手句。**引用了未声明素材位的那一条丢掉并打日志**，别的起手句与技能本身都留下：
 * 一条坏句子不该让整个场景消失，更不该让技能消失。
 */
export function parseAgentSkillStarters(
  raw: unknown,
  inputs: readonly AgentSkillInput[],
  skill: string,
): AgentSkillStarter[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnField(skill, 'starters')
    return []
  }
  const keys = new Set(inputs.map((input) => input.key))
  return raw.flatMap((item, at): AgentSkillStarter[] => {
    const value = record(item)
    const text = localized(value?.text)
    if (!text) {
      warnField(skill, 'starters', { index: at })
      return []
    }
    const unknown = [...unknownRefs(text['zh-CN'], keys), ...unknownRefs(text.en ?? '', keys)]
    if (unknown.length > 0) {
      log.warn(
        { event: 'agent.skill_starter_dropped', skill, index: at, unknownInputs: unknown },
        'agent skill starter references an undeclared input; starter dropped',
      )
      return []
    }
    const highlight = starterHighlight(value?.highlight, text, skill, at)
    return [highlight ? { text, highlight } : { text }]
  })
}

export function parseAgentSkillScene(raw: unknown, skill: string): AgentSkillScene | undefined {
  if (raw === undefined) return undefined
  const scene = AGENT_SKILL_SCENES.find((one) => one === raw)
  if (!scene) warnField(skill, 'scene')
  return scene
}

export function parseAgentSkillVerification(
  raw: unknown,
  skill: string,
): AgentSkillVerification | undefined {
  if (raw === undefined) return undefined
  const value = record(raw)
  const date = typeof value?.date === 'string' && DATE_RE.test(value.date) ? value.date : ''
  const model = nonEmpty(value?.model)
  const score = value?.score
  if (!date || !model || typeof score !== 'number' || !Number.isFinite(score)) {
    warnField(skill, 'verified')
    return undefined
  }
  return { date, model, score }
}

/** `meta.json` 里这几段一起读。`slotCount` 来自同一份文件里已经验过的模板标记。 */
export function parseAgentSkillStarterMeta(
  raw: Record<string, unknown>,
  slotCount: number | undefined,
  skill: string,
): AgentSkillStarterMeta {
  const inputs = parseAgentSkillInputs(raw.inputs, slotCount, skill)
  const scene = parseAgentSkillScene(raw.scene, skill)
  const verification = parseAgentSkillVerification(raw.verified, skill)
  return {
    inputs,
    starters: parseAgentSkillStarters(raw.starters, inputs, skill),
    ...(scene ? { scene } : {}),
    ...(verification ? { verification } : {}),
  }
}

/**
 * 「已验证」：有验证记录，且记录的模型就是这条技能此刻会用的模型。预置模板用的是钉死的那个，
 * 别的技能用部署的默认出图模型（见 ADR 0020）。任一边一变，这条技能就退出场景引导。
 */
export function isAgentSkillVerified(
  skill: { readonly verification?: AgentSkillVerification; readonly template?: { model: string } },
  imageModel: string | undefined,
): boolean {
  const model = skill.template?.model ?? imageModel
  return Boolean(skill.verification && model && skill.verification.model === model)
}
