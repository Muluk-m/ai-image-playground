import {
  STORYBOARD_SECONDS,
  STORYBOARD_SHOT_COUNTS,
  VIDEO_ASPECT_RATIOS,
  type VideoModelSupport,
} from '@image-playground/shared'
import { FIELD, LABEL, PANEL_SECTION, PRIMARY_BUTTON } from '../../../../components/panelStyles'
import ChipRow from '../../components/ChipRow'
import FrameSlot from '../../components/FrameSlot'
import FrameSourceStrip from '../../components/FrameSourceStrip'
import { useVideoStore } from '../../store'
import { useStoryboardStore } from '../store'
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
  const loading = useStoryboardStore((s) => s.loading)

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
        <FrameSourceStrip showLastFrame={false} onPickAll={onPickReference} />
      </div>

      <div className="flex flex-col gap-2.5">
        <ChipRow
          label="镜数"
          options={STORYBOARD_SHOT_COUNTS}
          value={draft.shots}
          render={(count) => `${count}`}
          onChange={(count) => useStoryboardStore.getState().setShots(count)}
        />
        <ChipRow
          label="每镜"
          options={STORYBOARD_SECONDS}
          value={draft.secondsPerShot}
          render={(seconds) => `${seconds} 秒`}
          onChange={(seconds) => useStoryboardStore.getState().setSecondsPerShot(seconds)}
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

      <div className={PANEL_SECTION}>
        <button
          type="button"
          disabled={loading || !draft.idea.trim()}
          onClick={submit}
          className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
        >
          {loading ? '生成中…' : '生成脚本与分镜图'}
        </button>
      </div>
    </>
  )
}
