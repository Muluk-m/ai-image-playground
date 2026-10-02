import { type AgentSkillScene, localizedText } from '@image-playground/shared'
import {
  ChevronLeft,
  CornerDownRight,
  LayoutGrid,
  type LucideIcon,
  Presentation,
  Store,
  UserRound,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { fillAgentComposer } from '../lib/composerFill'
import {
  type SceneStarter,
  sceneStarters,
  starterFill,
  starterSegments,
} from '../lib/skillStarters'
import { useAgentSkills } from '../lib/useAgentSkills'
import AgentSkillBadge from './AgentSkillBadge'

const SCENE_ICONS: Readonly<Record<AgentSkillScene, LucideIcon>> = {
  ecommerce: Store,
  poster: Presentation,
  'scene-character': UserRound,
  look: LayoutGrid,
}

/**
 * 输入框下方按场景组织的引导（见 CONTEXT.md「场景」「起手句」）：一行场景按钮，点开换成这个场景的
 * 起手句，点一条把技能与句子交给输入框。数据只来自技能目录，只露出已验证的技能；目录拉不到
 * 或没有可露出的技能时整块不渲染。
 */
export default function SkillStarterGuide() {
  const { t, i18n } = useTranslation('agent')
  const skills = useAgentSkills('image')
  const groups = useMemo(() => sceneStarters(skills), [skills])
  const [open, setOpen] = useState<AgentSkillScene | null>(null)
  const starters = open ? groups.get(open) : undefined

  if (groups.size === 0) return null

  const pick = ({ skill, starter }: SceneStarter) =>
    fillAgentComposer(starterFill(skill, starter, i18n.language))

  return (
    <nav aria-label={t('starters.aria')} className="mx-auto w-full max-w-4xl px-1 pt-4">
      {starters ? (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {starters.map((entry, at) => (
            <li key={`${entry.skill.name}-${at}`}>
              <button
                type="button"
                onClick={() => pick(entry)}
                className="flex w-full flex-wrap items-center gap-y-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <CornerDownRight className="mr-2 h-4 w-4 shrink-0" />
                {t('starters.use')}
                <AgentSkillBadge className="mx-1" skill={entry.skill} />
                {starterSegments(entry.starter, entry.skill.inputs, i18n.language).map(
                  (segment, index) =>
                    segment.kind === 'text' ? (
                      <span key={index}>{segment.text}</span>
                    ) : (
                      <span
                        key={index}
                        data-starter-input={segment.input.key}
                        className="mx-0.5 rounded border border-dashed border-primary/50 px-1 text-primary"
                      >
                        {localizedText(segment.input.label, i18n.language)}
                      </span>
                    ),
                )}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('starters.back')}
            </button>
          </li>
        </ul>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">{t('starters.lead')}</span>
          {[...groups.keys()].map((scene) => {
            const Icon = SCENE_ICONS[scene]
            return (
              <button
                key={scene}
                type="button"
                onClick={() => setOpen(scene)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-3.5 py-1.5 text-sm transition-colors hover:border-primary/60 hover:text-primary"
              >
                <Icon className="h-4 w-4" />
                {t(`starters.scene.${scene}`)}
              </button>
            )
          })}
        </div>
      )}
    </nav>
  )
}
