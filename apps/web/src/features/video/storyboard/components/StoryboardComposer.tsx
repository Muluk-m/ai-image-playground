import {
  STORYBOARD_SHOT_COUNTS,
  STORYBOARD_TOTAL_SECONDS,
  VIDEO_ASPECT_RATIOS,
  type VideoModelSupport,
} from '@image-playground/shared'
import { Checkbox } from '../../../../components/Checkbox'
import Pending from '../../../../components/Pending'
import { FIELD, LABEL, PANEL_SECTION, PRIMARY_BUTTON } from '../../../../components/panelStyles'
import { useTranslation } from '../../../../i18n'
import ChipRow from '../../components/ChipRow'
import { useVideoStore } from '../../store'
import { STORYBOARD_PLAN_TYPICAL_SECONDS, useStoryboardStore } from '../store'
import { STORYBOARD_STYLES, storyboardStyleLabel } from '../types'
import StoryboardReferences from './StoryboardReferences'

export default function StoryboardComposer({ support }: { support: VideoModelSupport }) {
  const { t } = useTranslation(['video', 'common'])
  const videoDraft = useVideoStore((s) => s.draft)
  const draft = useStoryboardStore((s) => s.draft)
  const loadingSince = useStoryboardStore((s) => s.loadingSince)
  const idleLabel = draft.shotImages ? t('plan.submitWithImages') : t('plan.submit')

  const submit = () =>
    void useStoryboardStore.getState().plan({ ...draft, aspectRatio: videoDraft.aspectRatio })

  return (
    <>
      <div>
        <div className={`${LABEL} mb-1.5`}>{t('plan.ideaLabel')}</div>
        <textarea
          value={draft.idea}
          onChange={(event) => useStoryboardStore.getState().setIdea(event.target.value)}
          rows={4}
          aria-label={t('plan.ideaLabel')}
          placeholder={t('plan.ideaPlaceholder')}
          className={`${FIELD} resize-none`}
        />
      </div>

      <StoryboardReferences />

      <div className="flex flex-col gap-2.5">
        <ChipRow
          label={t('plan.totalSecondsLabel')}
          options={STORYBOARD_TOTAL_SECONDS}
          value={draft.totalSeconds}
          render={(seconds) => t('shared.seconds', { seconds })}
          onChange={(seconds) => useStoryboardStore.getState().setTotalSeconds(seconds)}
        />
        <ChipRow
          label={t('plan.shotsLabel')}
          options={STORYBOARD_SHOT_COUNTS}
          value={draft.shots}
          render={(count) => `${count}`}
          onChange={(count) => useStoryboardStore.getState().setShots(count)}
        />
        <ChipRow
          label={t('field.aspectRatio')}
          options={VIDEO_ASPECT_RATIOS.filter((ratio) => support.aspectRatios.includes(ratio))}
          value={videoDraft.aspectRatio}
          render={(ratio) => ratio}
          onChange={(ratio) => useVideoStore.getState().setAspectRatio(ratio)}
        />
        <ChipRow
          label={t('plan.styleLabel')}
          options={STORYBOARD_STYLES}
          value={draft.style}
          render={storyboardStyleLabel}
          onChange={(style) => useStoryboardStore.getState().setStyle(style)}
        />
      </div>

      <Checkbox
        checked={draft.shotImages}
        onChange={(checked) => useStoryboardStore.getState().setShotImages(checked)}
        label={t('plan.shotImages')}
      />

      <div className={PANEL_SECTION}>
        <button
          type="button"
          disabled={loadingSince !== null || !draft.idea.trim()}
          onClick={submit}
          className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
        >
          {loadingSince === null ? (
            idleLabel
          ) : (
            <Pending label={t('common:state.generating')} startedAt={loadingSince} />
          )}
        </button>
        {loadingSince !== null && (
          <p className={`${LABEL} mt-1.5 text-center`}>
            {t('shared.typicalSeconds', { seconds: STORYBOARD_PLAN_TYPICAL_SECONDS })}
          </p>
        )}
      </div>
    </>
  )
}
