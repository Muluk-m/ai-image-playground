import {
  STORYBOARD_SHOT_COUNTS,
  STORYBOARD_TOTAL_SECONDS,
  VIDEO_ASPECT_RATIOS,
  type VideoModelSupport,
} from '@image-playground/shared'
import { Checkbox } from '../../../../components/Checkbox'
import Pending from '../../../../components/Pending'
import { FIELD, LABEL, PANEL_SECTION, PRIMARY_BUTTON } from '../../../../components/panelStyles'
import ChipRow from '../../components/ChipRow'
import FrameSlot from '../../components/FrameSlot'
import FrameSourceStrip from '../../components/FrameSourceStrip'
import { useVideoStore } from '../../store'
import { STORYBOARD_PLAN_TYPICAL_SECONDS, useStoryboardStore } from '../store'
import { STORYBOARD_STYLES } from '../types'

export const REFERENCE_LABEL = '参考图'

export default function StoryboardComposer({
  support,
  onPickReference,
}: {
  support: VideoModelSupport
  onPickReference: () => void
}) {
  const videoDraft = useVideoStore((s) => s.draft)
  const draft = useStoryboardStore((s) => s.draft)
  const loadingSince = useStoryboardStore((s) => s.loadingSince)
  const idleLabel = draft.shotImages ? '生成脚本与分镜图' : '生成脚本'

  const submit = () =>
    void useStoryboardStore.getState().plan({
      ...draft,
      aspectRatio: videoDraft.aspectRatio,
      referenceImageId: videoDraft.firstFrameImageId,
    })

  return (
    <>
      <div>
        <div className={`${LABEL} mb-1.5`}>创意</div>
        <textarea
          value={draft.idea}
          onChange={(event) => useStoryboardStore.getState().setIdea(event.target.value)}
          rows={4}
          aria-label="创意"
          placeholder="一句话或一段脚本"
          className={`${FIELD} resize-none`}
        />
      </div>

      <div>
        <div className={`${LABEL} mb-1.5`}>{REFERENCE_LABEL} · 可选</div>
        <div className="grid grid-cols-2 gap-2">
          <FrameSlot
            slot="first"
            label={REFERENCE_LABEL}
            imageId={videoDraft.firstFrameImageId}
            onPick={onPickReference}
          />
        </div>
        <FrameSourceStrip
          showLastFrame={false}
          fillLabel={`填入${REFERENCE_LABEL}`}
          onPickAll={onPickReference}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <ChipRow
          label="总时长"
          options={STORYBOARD_TOTAL_SECONDS}
          value={draft.totalSeconds}
          render={(seconds) => `${seconds} 秒`}
          onChange={(seconds) => useStoryboardStore.getState().setTotalSeconds(seconds)}
        />
        <ChipRow
          label="镜数"
          options={STORYBOARD_SHOT_COUNTS}
          value={draft.shots}
          render={(count) => `${count}`}
          onChange={(count) => useStoryboardStore.getState().setShots(count)}
        />
        <ChipRow
          label="比例"
          options={VIDEO_ASPECT_RATIOS.filter((ratio) => support.aspectRatios.includes(ratio))}
          value={videoDraft.aspectRatio}
          render={(ratio) => ratio}
          onChange={(ratio) => useVideoStore.getState().setAspectRatio(ratio)}
        />
        <ChipRow
          label="风格"
          options={STORYBOARD_STYLES}
          value={draft.style}
          render={(style) => style}
          onChange={(style) => useStoryboardStore.getState().setStyle(style)}
        />
      </div>

      <Checkbox
        checked={draft.shotImages}
        onChange={(checked) => useStoryboardStore.getState().setShotImages(checked)}
        label="先出分镜图"
      />

      <div className={PANEL_SECTION}>
        <button
          type="button"
          disabled={loadingSince !== null || !draft.idea.trim()}
          onClick={submit}
          className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
        >
          {loadingSince === null ? idleLabel : <Pending label="生成中" startedAt={loadingSince} />}
        </button>
        {loadingSince !== null && (
          <p className={`${LABEL} mt-1.5 text-center`}>通常 {STORYBOARD_PLAN_TYPICAL_SECONDS} 秒</p>
        )}
      </div>
    </>
  )
}
