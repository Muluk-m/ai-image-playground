import type { AgentSkillSummary } from '@image-playground/shared'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { fillAgentComposer } from '../lib/composerFill'
import AgentSkillBadge from './AgentSkillBadge'

const STARTER_SKILLS = ['storyboard-short', 'video-production', 'create-asset']

export default function CanvasAgentWelcome({ skills }: { skills: readonly AgentSkillSummary[] }) {
  const { t } = useTranslation('agent')
  const starters = STARTER_SKILLS.flatMap((name) => {
    const skill = skills.find((one) => one.name === name)
    return skill ? [skill] : []
  })
  return (
    <section className="studio-canvas-agent-welcome" aria-label={t('canvasWelcome.title')}>
      <div className="studio-canvas-agent-mark" aria-hidden="true">
        <img src="/brand/muvloom-mark.svg" alt="" />
      </div>
      <h3>{t('canvasWelcome.title')}</h3>
      <div className="studio-canvas-agent-starters">
        <Button
          variant="ghost"
          size="lg"
          onClick={() => fillAgentComposer(t('canvasWelcome.readPrompt'))}
        >
          <Icon name="canvas" />
          <span>{t('canvasWelcome.readCanvas')}</span>
          <Icon name="arrowRight" className="ml-auto text-muted-foreground" />
        </Button>
        {starters.map((skill) => (
          <Button
            key={skill.name}
            variant="ghost"
            size="lg"
            onClick={() => fillAgentComposer({ skill: skill.name, text: '' })}
          >
            <AgentSkillBadge skill={skill} className="border-0 bg-transparent p-0 font-normal" />
            <Icon name="arrowRight" className="ml-auto text-muted-foreground" />
          </Button>
        ))}
      </div>
    </section>
  )
}
