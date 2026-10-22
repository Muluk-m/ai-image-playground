import type { AgentMode, AgentSkillSummary, AgentSurface } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { fetchAgentSkills } from './agentClient'

const EMPTY_SKILLS: readonly AgentSkillSummary[] = []

/**
 * 上一次拿到的目录，按模式各留一份。新挂载的输入框先用它同步渲染：否则从素材库跳到创作页时，
 * 开头的 `/create-look` 要等请求回来才变成胶囊，中间先露一截裸文本。每次挂载仍在后台重拉，
 * 自建模板增删后照样跟上。
 */
type CatalogKey = `${AgentMode}:${AgentSurface}`
const lastSkills = new Map<CatalogKey, readonly AgentSkillSummary[]>()
const pendingSkills = new Map<CatalogKey, Promise<AgentSkillSummary[]>>()

function loadSkills(key: CatalogKey, mode: AgentMode, surface: AgentSurface) {
  const pending = pendingSkills.get(key)
  if (pending) return pending
  // 同一面板里的输入框、起手引导和历史记录共用请求；完成后允许下一次挂载刷新。
  const request = (
    surface === 'canvas' ? fetchAgentSkills(mode, undefined, 'canvas') : fetchAgentSkills(mode)
  )
    .then((skills) => {
      if (pendingSkills.get(key) === request) lastSkills.set(key, skills)
      return skills
    })
    .finally(() => {
      if (pendingSkills.get(key) === request) pendingSkills.delete(key)
    })
  pendingSkills.set(key, request)
  return request
}

/** 仅测试用：模块缓存跨用例存活。 */
export function resetAgentSkillsCache(): void {
  lastSkills.clear()
  pendingSkills.clear()
}

/**
 * Catalogs are deployment metadata, not persisted user content.
 * `surface` 是这份清单给哪种模式用：画布专属技能只在画布视图里列出，其余入口都按 Agent 模式。
 */
export function useAgentSkills(
  mode: AgentMode,
  surface: AgentSurface = 'agent',
): readonly AgentSkillSummary[] {
  const key: CatalogKey = `${mode}:${surface}`
  const [loaded, setLoaded] = useState<{
    key: CatalogKey
    skills: readonly AgentSkillSummary[]
  }>()
  useEffect(() => {
    let current = true
    void loadSkills(key, mode, surface).then(
      (skills) => {
        if (current) setLoaded({ key, skills })
      },
      () => {
        // 拉取失败时沿用上一次的目录，别把已经显示出来的胶囊打回裸文本。
        if (current) setLoaded({ key, skills: lastSkills.get(key) ?? EMPTY_SKILLS })
      },
    )
    return () => {
      current = false
    }
  }, [key, mode, surface])
  return loaded?.key === key ? loaded.skills : (lastSkills.get(key) ?? EMPTY_SKILLS)
}
