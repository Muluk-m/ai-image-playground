import { type ProductionContent, productionDeleteImpact } from '@image-playground/shared'
import { useTranslation } from '../../../i18n'

export default function ProductionDeleteImpactNotice({
  content,
  target,
}: {
  content: ProductionContent
  target: { kind: 'character' | 'look' | 'location' | 'scene' | 'shot'; id: string }
}) {
  const { t } = useTranslation('production')
  const impact = productionDeleteImpact(content, target)
  const shots =
    target.kind === 'shot'
      ? []
      : (content.shots ?? []).filter((shot) => impact.shotIds.includes(shot.id))
  const clips = (content.clips ?? []).filter((clip) => impact.clipIds.includes(clip.id))
  return (
    <section className="production-delete-impact" aria-label={t('deletion.title')}>
      <strong>{t('deletion.title')}</strong>
      <p>{t('deletion.preserve')}</p>
      {shots.length > 0 && (
        <>
          <h4>{t('deletion.shots', { count: shots.length })}</h4>
          <ul>
            {shots.map((shot) => (
              <li key={shot.id}>
                {t('storyboard.shot', {
                  number: (content.shots ?? []).findIndex((one) => one.id === shot.id) + 1,
                })}{' '}
                · {shot.description.slice(0, 120) || shot.id}
              </li>
            ))}
          </ul>
        </>
      )}
      {clips.length > 0 && (
        <>
          <h4>{t('deletion.clips', { count: clips.length })}</h4>
          <ul>
            {clips.map((clip) => (
              <li key={clip.id}>
                {clip.name || clip.id}
                {clip.adopted ? <span>{t('deletion.adopted')}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {!shots.length && !clips.length && <p>{t('deletion.none')}</p>}
    </section>
  )
}
