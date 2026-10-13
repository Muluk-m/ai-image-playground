import { type AgentSkillScene, localizedText } from '@image-playground/shared'
import { useMemo, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
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
import { AssetSlotFace } from './AssetSlotChip'

const SCENE_ICONS: Readonly<Record<AgentSkillScene, IconName>> = {
  ecommerce: 'shop',
  poster: 'poster',
  'scene-character': 'character',
  look: 'palette',
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
              <Button
                type="button"
                onClick={() => pick(entry)}
                variant="ghost"
                size="sm"
                className="h-auto min-h-8 w-full flex-wrap justify-start gap-x-0 gap-y-1 whitespace-normal py-1.5 text-left font-normal"
              >
                <Icon name="starter" className="mr-2" />
                {t('starters.use')}
                <AgentSkillBadge className="mx-1" skill={entry.skill} />
                {starterSegments(entry.starter, entry.skill.inputs, i18n.language).map(
                  (segment, index) =>
                    segment.kind === 'text' ? (
                      <span key={index}>{segment.text}</span>
                    ) : (
                      <span key={index} data-starter-input={segment.input.key}>
                        <AssetSlotFace label={localizedText(segment.input.label, i18n.language)} />
                      </span>
                    ),
                )}
              </Button>
            </li>
          ))}
          <li>
            <Button type="button" onClick={() => setOpen(null)} variant="ghost" size="sm">
              <Icon name="chevronLeft" />
              {t('starters.back')}
            </Button>
          </li>
        </ul>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">{t('starters.lead')}</span>
          {[...groups.keys()].map((scene) => {
            const icon = SCENE_ICONS[scene]
            return (
              <Button
                key={scene}
                type="button"
                onClick={() => setOpen(scene)}
                variant="outline"
                size="sm"
              >
                <Icon name={icon} />
                {t(`starters.scene.${scene}`)}
              </Button>
            )
          })}
        </div>
      )}
    </nav>
  )
}
