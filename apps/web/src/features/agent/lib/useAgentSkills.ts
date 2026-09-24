import type { AgentMode, AgentSkillSummary } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { fetchAgentSkills } from './agentClient'

const EMPTY_SKILLS: readonly AgentSkillSummary[] = []

/**
 * 上一次拿到的目录，按模式各留一份。新挂载的输入框先用它同步渲染：否则从素材库跳到创作页时，
 * 开头的 `/create-look` 要等请求回来才变成胶囊，中间先露一截裸文本。每次挂载仍在后台重拉，
 * 自建模板增删后照样跟上。
 */
const lastSkills = new Map<AgentMode, readonly AgentSkillSummary[]>()

/** 仅测试用：模块缓存跨用例存活。 */
export function resetAgentSkillsCache(): void {
  lastSkills.clear()
}

/** Catalogs are deployment metadata, not persisted user content. */
export function useAgentSkills(mode: AgentMode): readonly AgentSkillSummary[] {
  const [loaded, setLoaded] = useState<{
    mode: AgentMode
    skills: readonly AgentSkillSummary[]
  }>()
  useEffect(() => {
    let current = true
    void fetchAgentSkills(mode).then(
      (skills) => {
        lastSkills.set(mode, skills)
        if (current) setLoaded({ mode, skills })
      },
      () => {
        // 拉取失败时沿用上一次的目录，别把已经显示出来的胶囊打回裸文本。
        if (current) setLoaded({ mode, skills: lastSkills.get(mode) ?? EMPTY_SKILLS })
      },
    )
    return () => {
      current = false
    }
  }, [mode])
  return loaded?.mode === mode ? loaded.skills : (lastSkills.get(mode) ?? EMPTY_SKILLS)
}
