import type { AgentSkillSummary } from '@image-playground/shared'
import { type LookPurpose, type LookRecord, lookSkillName } from '../types'

/**
 * 列表与 chip 上的一条模板，不分来源：用户自建的来自本机库，预置的来自技能清单里带
 * `template` 的那些。两边字段对齐成同一形状，界面只认这一种。
 */
export interface LookItem {
  /** 智能体认的技能标识：自建 `look-<id>`，预置就是技能名。 */
  readonly skillName: string
  readonly origin: 'user' | 'builtin'
  readonly name: string
  readonly description: string
  readonly purpose: LookPurpose
  readonly model: string
  readonly size: string
  readonly slotCount: number
  /** 自建是本机 imageId，预置是 BFF 上的图片地址。 */
  readonly cover: { kind: 'image'; imageId: string } | { kind: 'url'; url: string } | null
  readonly references: ReadonlyArray<
    { kind: 'image'; imageId: string } | { kind: 'url'; url: string }
  >
  /** 只有自建有；预置模板不能改。 */
  readonly record?: LookRecord
  /** 只有预置有；正文要经 loadSkill 读，列表上用不到。 */
  readonly skill?: AgentSkillSummary
}

export function lookItemFromRecord(record: LookRecord): LookItem {
  return {
    skillName: lookSkillName(record.id),
    origin: 'user',
    name: record.name,
    description: record.description,
    purpose: record.purpose,
    model: record.model,
    size: record.size,
    slotCount: record.slotCount,
    cover: record.coverImageId
      ? { kind: 'image', imageId: record.coverImageId }
      : record.referenceImageIds[0]
        ? { kind: 'image', imageId: record.referenceImageIds[0] }
        : null,
    references: record.referenceImageIds.map((imageId) => ({ kind: 'image', imageId })),
    record,
  }
}

export function lookItemFromSkill(skill: AgentSkillSummary): LookItem | null {
  const template = skill.template
  if (!template) return null
  return {
    skillName: skill.name,
    origin: 'builtin',
    name: skill.title,
    description: skill.summary.trim() || skill.description,
    purpose: template.purpose,
    model: template.model,
    size: template.size,
    slotCount: template.slotCount,
    cover: { kind: 'url', url: template.coverUrl },
    references: template.referenceUrls.map((url) => ({ kind: 'url', url })),
    skill,
  }
}

/** 自建在前（最近用过的靠前），预置在后。 */
export function mergeLookItems(
  records: readonly LookRecord[],
  skills: readonly AgentSkillSummary[],
): LookItem[] {
  const mine = [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt).map(lookItemFromRecord)
  const builtin = skills.map(lookItemFromSkill).filter((item): item is LookItem => item !== null)
  return [...mine, ...builtin]
}

/** 钉死的模型不在当前清单里，这条模板出不了图。 */
export function lookNeedsRetune(item: LookItem, availableModels: ReadonlySet<string>): boolean {
  return availableModels.size > 0 && !availableModels.has(item.model)
}

export function matchLooksByName(items: readonly LookItem[], keyword: string): LookItem[] {
  const query = keyword.trim().toLowerCase()
  if (!query) return [...items]
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query),
  )
}
