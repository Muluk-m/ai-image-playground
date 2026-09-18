import type { AgentMode, AgentSkillSummary } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { fetchAgentSkills } from './agentClient'

const EMPTY_SKILLS: readonly AgentSkillSummary[] = []

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
        if (current) setLoaded({ mode, skills })
      },
      () => {
        if (current) setLoaded({ mode, skills: EMPTY_SKILLS })
      },
    )
    return () => {
      current = false
    }
  }, [mode])
  return loaded?.mode === mode ? loaded.skills : EMPTY_SKILLS
}
