import type { ProductionContent, ProductionShot } from '@image-playground/shared'
import { useTranslation } from '../../../i18n'

export default function ProductionShotSummary({
  shot,
  index,
  content,
}: {
  shot: ProductionShot
  index: number
  content: ProductionContent
}) {
  const { t } = useTranslation('production')
  const looks = (content.characters ?? []).flatMap((character) =>
    character.looks.map((look) => ({ ...look, label: `${character.name} · ${look.name}` })),
  )
  const location = content.locations?.find((item) => item.id === shot.locationId)
  const scene = content.scenes.find((item) => item.id === shot.scriptSceneId)
  return (
    <div
      className="production-shot-summary"
      aria-label={t('storyboard.shot', { number: index + 1 })}
    >
      <p className="production-shot-description">{shot.description || t('storyboard.unset')}</p>
      {shot.dialogue && <blockquote>{shot.dialogue}</blockquote>}
      <dl>
        <div>
          <dt>{t('storyboard.camera')}</dt>
          <dd>{shot.camera || t('storyboard.unset')}</dd>
        </div>
        <div>
          <dt>{t('storyboard.duration')}</dt>
          <dd>
            {shot.durationSeconds === undefined
              ? t('storyboard.unset')
              : t('storyboard.seconds', { count: shot.durationSeconds })}
          </dd>
        </div>
      </dl>
      <div className="production-shot-references">
        {shot.scriptSceneId && (
          <span data-missing={!scene}>{scene?.title ?? t('storyboard.missing')}</span>
        )}
        {shot.locationId && (
          <span data-missing={!location}>{location?.name ?? t('storyboard.missing')}</span>
        )}
        {shot.lookIds.map((id) => {
          const look = looks.find((item) => item.id === id)
          return (
            <span key={id} data-missing={!look}>
              {look?.label ?? t('storyboard.missing')}
            </span>
          )
        })}
      </div>
    </div>
  )
}
