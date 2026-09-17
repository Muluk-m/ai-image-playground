import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_AGENT_SKILL_ICON } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  AGENT_SKILL_ICON_NAMES,
  agentSkillIcon,
} from '../../../../features/agent/lib/agentSkillIcons'

/**
 * 白名单与技能目录**不能各写一份**：技能的图标名只有 `apps/bff/skills/**\/meta.json` 一个来源，
 * 这条测试直接读那些文件，而不是照抄一份共享常量。加了技能却忘了往白名单里加组件，
 * 这里就红；反过来白名单多一个名字不算错（部署里的技能可能比这份前端旧）。
 */
const here = dirname(fileURLToPath(import.meta.url))
const SKILLS_ROOT = resolve(here, '../../../../../../bff/skills')

function shippedSkillIcons(): { skill: string; icon: string }[] {
  const found: { skill: string; icon: string }[] = []
  for (const mode of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!mode.isDirectory()) continue
    for (const skill of readdirSync(join(SKILLS_ROOT, mode.name), { withFileTypes: true })) {
      if (!skill.isDirectory()) continue
      const meta = JSON.parse(
        readFileSync(join(SKILLS_ROOT, mode.name, skill.name, 'meta.json'), 'utf8'),
      ) as { icon?: unknown }
      found.push({ skill: `${mode.name}/${skill.name}`, icon: String(meta.icon) })
    }
  }
  return found
}

describe('技能图标白名单', () => {
  it('覆盖随仓库发的每一个图标名', () => {
    const shipped = shippedSkillIcons()
    expect(shipped.length).toBeGreaterThan(0)
    const missing = shipped.filter((one) => !AGENT_SKILL_ICON_NAMES.includes(one.icon))
    expect(missing).toEqual([])
  })

  it('收着那个默认图标，否则回退还得再回退一次', () => {
    expect(AGENT_SKILL_ICON_NAMES).toContain(DEFAULT_AGENT_SKILL_ICON)
  })

  it('认不出的名字与缺席的名字都回退到默认图标', () => {
    const fallback = agentSkillIcon(DEFAULT_AGENT_SKILL_ICON)
    expect(agentSkillIcon('no-such-icon-anywhere')).toBe(fallback)
    expect(agentSkillIcon(undefined)).toBe(fallback)
    expect(agentSkillIcon('')).toBe(fallback)
  })

  it('不同技能用不同图标', () => {
    const icons = shippedSkillIcons().map((one) => one.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })
})
