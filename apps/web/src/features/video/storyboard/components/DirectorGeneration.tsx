import {
  VIDEO_RESOLUTION_LABELS,
  validateVideoPrompt,
  validateVideoRequest,
  videoRateMultiplier,
} from '@image-playground/shared'
import { useState } from 'react'
import SubmissionBillingAction from '../../../../components/SubmissionBillingAction'
import { videoModelOptions } from '../../../../lib/channels/videoChannels'
import { usePrivateSubmissionGuard } from '../../../../lib/privateOverlay'
import { useStore } from '../../../../store'
import { useVideoStore } from '../../store'
import { useStoryboardStore, wholeVideoFrameId } from '../store'
import type { StoryboardRecord, StoryboardShotRecord } from '../types'

export default function DirectorGeneration({
  record,
  shot,
  initialScope,
  onClose,
  onLibrary,
  onSubmitted,
}: {
  record: StoryboardRecord
  shot?: StoryboardShotRecord
  initialScope: 'whole' | 'shot'
  onClose: () => void
  onLibrary: () => void
  onSubmitted: () => void
}) {
  const [scope, setScope] = useState(initialScope)
  const [submitting, setSubmitting] = useState(false)
  const draft = useVideoStore((s) => s.draft)
  const saveState = useStoryboardStore((s) => s.saveStates[record.id])
  const options = videoModelOptions()
  const option = options.find((item) => item.modelId === draft.model)
  const seconds = scope === 'shot' ? (shot?.seconds ?? 0) : record.totalSeconds
  const imageId = scope === 'shot' ? shot?.imageId : wholeVideoFrameId(record)
  const prompt = scope === 'shot' ? (shot?.videoPrompt ?? '') : record.videoPrompt
  const check = validateVideoRequest(
    draft.model,
    {
      duration_seconds: seconds,
      resolution: draft.resolution,
      aspect_ratio: record.aspectRatio,
      ...(imageId ? { first_frame_index: 0 } : {}),
    },
    imageId ? 1 : 0,
  )
  const promptCheck = validateVideoPrompt(draft.model, prompt)
  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: seconds,
    unitMultiplier: videoRateMultiplier(draft.model, draft.resolution),
  })
  const reason = !option
    ? '请选择可用的视频模型'
    : scope === 'shot' && !imageId
      ? '请先生成当前镜头的分镜图'
      : !check.ok
        ? check.reason
        : !promptCheck.ok
          ? promptCheck.reason
          : guard.disabledReason
  const submit = async () => {
    setSubmitting(true)
    try {
      const taskId =
        scope === 'shot' && shot
          ? await useStoryboardStore.getState().generateShotVideo(record.id, shot.no)
          : await useStoryboardStore.getState().generateWholeVideo(record.id)
      if (taskId) onSubmitted()
    } catch (error) {
      useStore
        .getState()
        .showToast(error instanceof Error ? error.message : '视频提交失败，请重试', 'error')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="vd-stack">
      <div className="vd-row vd-between">
        <h3>生成视频</h3>
        <button type="button" onClick={onClose}>
          返回编辑
        </button>
      </div>
      <div className="vd-inset">
        <strong>{record.title}</strong>
        <p>来源：当前分镜 · 提交时保存版本快照</p>
        <button type="button" onClick={onLibrary}>
          更换分镜
        </button>
      </div>
      <div className="vd-stack" role="group" aria-label="生成范围">
        <button type="button" aria-pressed={scope === 'whole'} onClick={() => setScope('whole')}>
          整条视频 · {record.totalSeconds} 秒
        </button>
        <button
          type="button"
          disabled={!shot}
          aria-pressed={scope === 'shot'}
          onClick={() => setScope('shot')}
        >
          当前镜头 · {shot?.seconds ?? 0} 秒
        </button>
      </div>
      <label>
        视频模型
        <select
          aria-label="分镜视频模型"
          value={draft.model}
          onChange={(e) => useVideoStore.getState().setModel(e.target.value)}
        >
          {!option && <option value="">选择模型</option>}
          {options.map((item) => (
            <option key={item.modelId} value={item.modelId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        清晰度
        <select
          aria-label="分镜视频清晰度"
          value={draft.resolution}
          onChange={(e) =>
            useVideoStore.getState().setResolution(e.target.value as typeof draft.resolution)
          }
        >
          {option?.support.resolutions.map((r) => (
            <option key={r} value={r}>
              {VIDEO_RESOLUTION_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <p className="vd-muted">
        {record.aspectRatio} ·{' '}
        {imageId ? '使用首张画面作为视频首帧，其余镜头通过脚本描述' : '根据完整脚本文生视频'}
      </p>
      {reason && (
        <p className="vd-error" role="status">
          {reason}
        </p>
      )}
      {saveState === 'error' && <p className="vd-error">分镜尚未保存成功；重试保存后才能生成。</p>}
      <SubmissionBillingAction blockedAction={guard.blockedAction} />
      {guard.estimatedCredits !== undefined && (
        <div className="vd-row vd-between">
          <span>预计积分</span>
          <strong>{guard.estimatedCredits}</strong>
        </div>
      )}
      <button
        type="button"
        className="vd-primary"
        disabled={
          submitting ||
          !option ||
          !check.ok ||
          !promptCheck.ok ||
          guard.blocked ||
          (scope === 'shot' && !imageId)
        }
        onClick={() => void submit()}
      >
        {submitting ? '提交中…' : `生成 ${seconds} 秒视频`}
      </button>
    </div>
  )
}
