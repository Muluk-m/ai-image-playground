import type { AgentSkillSummary } from '@image-playground/shared'
import AgentSkillIcon from '../lib/agentSkillIcons'

export default function AgentSkillBadge({
  skill,
  className = '',
}: {
  skill: AgentSkillSummary
  className?: string
}) {
  return (
    <span
      className={`agent-skill-chip inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/80 px-1.5 py-0.5 align-middle text-sm font-medium leading-5 text-foreground ${className}`}
      data-skill-name={skill.name}
      title={`/${skill.name}`}
    >
      <AgentSkillIcon name={skill.icon} className="h-4 w-4 shrink-0" />
      <span className="truncate">{skill.title}</span>
    </span>
  )
}
