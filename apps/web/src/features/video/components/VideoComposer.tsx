import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_MODEL_SUPPORT,
  VIDEO_RESOLUTION_LABELS,
  VIDEO_RESOLUTION_MULTIPLIERS,
  type VideoModelSupport,
  videoRateMultiplier,
} from '@image-playground/shared'
import { useEffect, useMemo, useState } from 'react'
import { CARD, FIELD, LABEL, PANEL_SECTION, PRIMARY_BUTTON } from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { type VideoModelOption, videoModelOptions } from '../../../lib/channels/videoChannels'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { FOLLOWS_FIRST_FRAME } from '../lib/aspect'
import { useVideoStore } from '../store'
import StoryboardComposer, { REFERENCE_LABEL } from '../storyboard/components/StoryboardComposer'
import {
  CAMERA_MOVES,
  VIDEO_COMPOSER_SOURCE_LABELS,
  VIDEO_COMPOSER_SOURCES,
  VIDEO_SOURCES,
  type VideoFrameSlot,
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
        {guard.estimatedCredits === undefined
          ? hint
          : `${hint} · ${guard.estimatedCredits} 积分 / 秒`}
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
  const draft = useVideoStore((s) => s.draft)
  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: draft.duration,
    unitMultiplier: videoRateMultiplier(draft.resolution),
  })

  usePasteImageFiles('video', (files) => {
    if (draft.source !== 'image' || !files[0]) return
    const slot: VideoFrameSlot =
      !draft.firstFrameImageId || !support.lastFrame || draft.lastFrameImageId ? 'first' : 'last'
    void useVideoStore.getState().addFrameFromFile(slot, files[0])
  })

  const lastFrameReason = support.lastFrame ? undefined : `${support.label} 不支持尾帧`
  const summary = `${support.label} · ${draft.duration} 秒 · ${VIDEO_RESOLUTION_LABELS[draft.resolution]}`

  return (
    <>
      {draft.source === 'image' && (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className={LABEL}>首帧 · 尾帧</span>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              拖入 · 粘贴 · 下方直接点
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
              hint="可选"
              disabledReason={lastFrameReason}
              onPick={() => onPickFrame('last')}
            />
          </div>
          <FrameSourceStrip
            showLastFrame={support.lastFrame}
            onPickAll={() => onPickFrame('first')}
          />
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className={LABEL}>描述</span>
          <span className="text-[11px] text-gray-400 dark:text-gray-500">动作 · 镜头 · 光线</span>
        </div>
        <textarea
          value={draft.prompt}
          onChange={(event) => useVideoStore.getState().setPrompt(event.target.value)}
          rows={4}
          aria-label="描述"
          placeholder="画面里发生什么，镜头怎么动"
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
        <div className={`${LABEL} mb-1.5`}>模型</div>
        <div className="grid grid-cols-2 gap-2">
          {options.map((option) => (
            <ModelCard
              key={option.modelId}
              option={option}
              hint={option.support.tagline}
              selected={option.modelId === draft.model}
              onSelect={() => useVideoStore.getState().setModel(option.modelId)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <ChipRow
          label="时长"
          options={VIDEO_DURATIONS.filter((duration) => support.durations.includes(duration))}
          value={draft.duration}
          render={(duration) => `${duration} 秒`}
          onChange={(duration) => useVideoStore.getState().setDuration(duration)}
        />
        <ChipRow
          label="比例"
          options={VIDEO_ASPECT_RATIOS.filter((ratio) => support.aspectRatios.includes(ratio))}
          value={draft.aspectRatio}
          render={(ratio) => ratio}
          onChange={(ratio) => useVideoStore.getState().setAspectRatio(ratio)}
          disabled={draft.source === 'image'}
          note={draft.source === 'image' ? FOLLOWS_FIRST_FRAME : undefined}
        />
        <ChipRow
          label="清晰度"
          options={support.resolutions}
          value={draft.resolution}
          render={(resolution) => {
            const multiplier = VIDEO_RESOLUTION_MULTIPLIERS[resolution]
            const label = VIDEO_RESOLUTION_LABELS[resolution]
            return multiplier === 1 ? label : `${label} ×${multiplier}`
          }}
          onChange={(resolution) => useVideoStore.getState().setResolution(resolution)}
        />
      </div>

      <div className={PANEL_SECTION}>
        <div className="mb-2 flex items-baseline justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{summary}</span>
          {guard.estimatedCredits !== undefined && (
            <span className="font-medium text-gray-800 dark:text-gray-100">
              {guard.estimatedCredits} 积分
            </span>
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
          disabled={guard.blocked}
          title={guard.disabledReason}
          onClick={() => void useVideoStore.getState().submit()}
          className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
        >
          {guard.estimatedCredits === undefined ? '生成' : `生成 · ${guard.estimatedCredits} 积分`}
        </button>
      </div>
    </>
  )
}

export default function VideoComposer() {
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
    return options.length === 0 ? <div className={CARD}>当前部署没有可用的视频模型</div> : null
  }

  const sources = isClientCapabilityEnabled('generation:storyboard')
    ? VIDEO_COMPOSER_SOURCES
    : VIDEO_SOURCES

  return (
    <div className={`${CARD} flex flex-col gap-4`}>
      <Segmented
        label="视频来源"
        options={sources}
        labels={VIDEO_COMPOSER_SOURCE_LABELS}
        value={storyboard ? 'storyboard' : draft.source}
        onChange={(source) => {
          setStoryboard(source === 'storyboard')
          if (source !== 'storyboard') useVideoStore.getState().setSource(source)
        }}
      />

      {storyboard ? (
        <StoryboardComposer support={support} onPickReference={() => setPickerSlot('first')} />
      ) : (
        <VideoSubmitPanel support={support} options={options} onPickFrame={setPickerSlot} />
      )}

      {pickerSlot && (
        <FramePicker
          slot={pickerSlot}
          label={storyboard ? REFERENCE_LABEL : undefined}
          onClose={() => setPickerSlot(null)}
        />
      )}
    </div>
  )
}
