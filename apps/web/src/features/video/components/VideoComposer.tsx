import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODEL_SUPPORT,
  VIDEO_RESOLUTION_LABELS,
  type VideoModelSupport,
  videoDurationsForResolution,
  videoPromptRejection,
  videoRateMultiplier,
} from '@image-playground/shared'
import { useEffect, useMemo, useState } from 'react'
import Credits from '../../../components/Credits'
import { CARD, FIELD, LABEL, PANEL_SECTION, PRIMARY_BUTTON } from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { useTranslation } from '../../../i18n'
import { type VideoModelOption, videoModelOptions } from '../../../lib/channels/videoChannels'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { videoRejectionText, videoTaglineLabel } from '../lib/labels'
import { useVideoStore } from '../store'
import StoryboardComposer from '../storyboard/components/StoryboardComposer'
import {
  CAMERA_MOVES,
  VIDEO_COMPOSER_SOURCES,
  VIDEO_SOURCES,
  type VideoFrameSlot,
  videoComposerSourceLabels,
  videoFrameSlotLabel,
} from '../types'
import ChipRow from './ChipRow'
import { SUGGESTION_CHIP } from './chipStyles'
import FramePicker from './FramePicker'
import FrameSlot from './FrameSlot'
import FrameSourceStrip from './FrameSourceStrip'

/** 每秒单价：向门禁问 1 秒 × 倍率 1 的价，没有计费时它不给数，卡片就只写模型名。 */
function ModelCard({
  option,
  hint,
  selected,
  onSelect,
}: {
  option: VideoModelOption
  hint: string
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation(['video', 'common'])
  const guard = usePrivateSubmissionGuard({
    model: option.modelId,
    quantity: 1,
    unitMultiplier: 1,
  })
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`rounded-xl border px-2.5 py-2 text-left transition ${
        selected
          ? 'border-blue-400 bg-blue-500/10'
          : 'border-gray-200 hover:border-blue-300 dark:border-white/[0.12]'
      }`}
    >
      <span className="block text-[13px] font-medium text-gray-800 dark:text-gray-100">
        {option.label}
      </span>
      <span className="block text-[11px] text-gray-500 dark:text-gray-400">
        {guard.estimatedCredits === undefined ? (
          hint
        ) : (
          <>
            {hint} · <Credits credits={guard.estimatedCredits} /> {t('composer.perSecond')}
          </>
        )}
      </span>
    </button>
  )
}

/** 文生 / 图生的参数与提交。分镜页签换成 StoryboardComposer，两者共用左栏的模型与选图。 */
function VideoSubmitPanel({
  support,
  options,
  onPickFrame,
}: {
  support: VideoModelSupport
  options: readonly VideoModelOption[]
  onPickFrame: (slot: VideoFrameSlot) => void
}) {
  const { t } = useTranslation(['video', 'common'])
  const draft = useVideoStore((s) => s.draft)
  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: draft.duration,
    unitMultiplier: videoRateMultiplier(draft.model, draft.resolution),
  })

  usePasteImageFiles('video', (files) => {
    if (draft.source !== 'image' || !files[0]) return
    const slot: VideoFrameSlot =
      !draft.firstFrameImageId || !support.lastFrame || draft.lastFrameImageId ? 'first' : 'last'
    void useVideoStore.getState().addFrameFromFile(slot, files[0])
  })

  const lastFrameReason = support.lastFrame
    ? undefined
    : t('composer.lastFrameUnsupported', { model: support.label })
  const promptRejection = videoPromptRejection(draft.model, draft.prompt)
  const durations = videoDurationsForResolution(support, draft.resolution)
  const summary = t('composer.summary', {
    model: support.label,
    seconds: draft.duration,
    resolution: VIDEO_RESOLUTION_LABELS[draft.resolution],
  })

  return (
    <>
      {draft.source === 'image' && (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className={LABEL}>{t('composer.framesLabel')}</span>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {t('composer.framesHint')}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <FrameSlot
              slot="first"
              imageId={draft.firstFrameImageId}
              onPick={() => onPickFrame('first')}
            />
            <FrameSlot
              slot="last"
              imageId={draft.lastFrameImageId}
              hint={t('composer.lastFrameOptional')}
              disabledReason={lastFrameReason}
              onPick={() => onPickFrame('last')}
            />
          </div>
          <FrameSourceStrip
            showLastFrame={support.lastFrame}
            selectedImageIds={draft.firstFrameImageId ? [draft.firstFrameImageId] : []}
            onSelect={(imageId) => useVideoStore.getState().setFrame('first', imageId)}
            onPickAll={() => onPickFrame('first')}
          />
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className={LABEL}>{t('field.description')}</span>
          {promptRejection ? (
            <span className="text-[11px] text-red-600 dark:text-red-400">
              {draft.prompt.length} / {support.promptMaxChars}
            </span>
          ) : (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {t('composer.promptHint')}
            </span>
          )}
        </div>
        <textarea
          value={draft.prompt}
          onChange={(event) => useVideoStore.getState().setPrompt(event.target.value)}
          rows={4}
          aria-label={t('field.description')}
          placeholder={t('composer.promptPlaceholder')}
          className={`${FIELD} resize-none`}
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {CAMERA_MOVES.map((move) => (
            <button
              key={move}
              type="button"
              onClick={() => useVideoStore.getState().addCameraMove(move)}
              className={SUGGESTION_CHIP}
            >
              + {move}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className={`${LABEL} mb-1.5`}>{t('field.model')}</div>
        <div className="grid grid-cols-2 gap-2">
          {options.map((option) => (
            <ModelCard
              key={option.modelId}
              option={option}
              hint={videoTaglineLabel(option.modelId)}
              selected={option.modelId === draft.model}
              onSelect={() => useVideoStore.getState().setModel(option.modelId)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <ChipRow
          label={t('composer.durationLabel')}
          options={support.durations}
          value={draft.duration}
          render={(duration) => t('shared.seconds', { seconds: duration })}
          optionDisabled={(duration) => !durations.includes(duration)}
          onChange={(duration) => useVideoStore.getState().setDuration(duration)}
        />
        <ChipRow
          label={t('field.aspectRatio')}
          options={VIDEO_ASPECT_RATIOS.filter((ratio) => support.aspectRatios.includes(ratio))}
          value={draft.aspectRatio}
          render={(ratio) => ratio}
          onChange={(ratio) => useVideoStore.getState().setAspectRatio(ratio)}
          disabled={draft.source === 'image'}
          note={draft.source === 'image' ? t('aspect.followsFirstFrame') : undefined}
        />
        <ChipRow
          label={t('field.resolution')}
          options={support.resolutions}
          value={draft.resolution}
          render={(resolution) => {
            const multiplier = videoRateMultiplier(draft.model, resolution)
            const label = VIDEO_RESOLUTION_LABELS[resolution]
            return multiplier === 1 ? label : `${label} ×${multiplier}`
          }}
          optionDisabled={(resolution) =>
            !videoDurationsForResolution(support, resolution).includes(draft.duration)
          }
          onChange={(resolution) => useVideoStore.getState().setResolution(resolution)}
        />
      </div>

      <div className={PANEL_SECTION}>
        <div className="mb-2 flex items-baseline justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{summary}</span>
          {guard.estimatedCredits !== undefined && (
            <Credits
              credits={guard.estimatedCredits}
              className="font-medium text-gray-800 dark:text-gray-100"
            />
          )}
        </div>
        {guard.blocked && guard.disabledReason && (
          <p className="mb-1.5 text-[11px] text-red-600 dark:text-red-400">
            {guard.disabledReason}
          </p>
        )}
        <SubmissionBillingAction
          blockedAction={guard.blockedAction}
          className="mb-1.5 text-[11px]"
        />
        <button
          type="button"
          disabled={guard.blocked || !!promptRejection}
          title={promptRejection ? videoRejectionText(promptRejection) : guard.disabledReason}
          onClick={() => void useVideoStore.getState().submit()}
          className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
        >
          {guard.estimatedCredits === undefined ? (
            t('common:action.generate')
          ) : (
            <>
              {t('common:action.generate')} · <Credits credits={guard.estimatedCredits} />
            </>
          )}
        </button>
      </div>
    </>
  )
}

export default function VideoComposer() {
  const { t } = useTranslation(['video', 'common'])
  const draft = useVideoStore((s) => s.draft)
  const options = useMemo(() => videoModelOptions(), [])
  const [pickerSlot, setPickerSlot] = useState<VideoFrameSlot | null>(null)
  const [storyboard, setStoryboard] = useState(false)
  const support = VIDEO_MODEL_SUPPORT[draft.model]

  // draft 的默认 model 是空的：channel 列表要到 boot 拉完才有，早于本组件第一次渲染。
  useEffect(() => {
    if (!support) useVideoStore.getState().syncModelOptions()
  }, [support])

  if (!support) {
    return options.length === 0 ? <div className={CARD}>{t('error.noModel')}</div> : null
  }

  const sources = isClientCapabilityEnabled('generation:storyboard')
    ? VIDEO_COMPOSER_SOURCES
    : VIDEO_SOURCES

  return (
    <div className={`${CARD} flex flex-col gap-4`}>
      <Segmented
        label={t('composer.sourceLabel')}
        options={sources}
        labels={videoComposerSourceLabels()}
        value={storyboard ? 'storyboard' : draft.source}
        onChange={(source) => {
          setStoryboard(source === 'storyboard')
          if (source !== 'storyboard') useVideoStore.getState().setSource(source)
        }}
      />

      {storyboard ? (
        <StoryboardComposer support={support} />
      ) : (
        <VideoSubmitPanel support={support} options={options} onPickFrame={setPickerSlot} />
      )}

      {pickerSlot && (
        <FramePicker
          label={videoFrameSlotLabel(pickerSlot)}
          onSelect={(imageId) => {
            useVideoStore.getState().setFrame(pickerSlot, imageId)
            setPickerSlot(null)
          }}
          onClose={() => setPickerSlot(null)}
        />
      )}
    </div>
  )
}
