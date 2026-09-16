import {
  VIDEO_RESOLUTION_LABELS,
  videoPromptRejection,
  videoRateMultiplier,
  videoRequestRejection,
} from '@image-playground/shared'
import { useState } from 'react'
import Credits from '../../../../components/Credits'
import SubmissionBillingAction from '../../../../components/SubmissionBillingAction'
import { describeError, useTranslation } from '../../../../i18n'
import { videoModelOptions } from '../../../../lib/channels/videoChannels'
import { usePrivateSubmissionGuard } from '../../../../lib/privateOverlay'
import { useStore } from '../../../../store'
import { videoRejectionText } from '../../lib/labels'
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
  const { t } = useTranslation('video')
  const [scope, setScope] = useState(initialScope)
  const [submitting, setSubmitting] = useState(false)
  const draft = useVideoStore((s) => s.draft)
  const saveState = useStoryboardStore((s) => s.saveStates[record.id])
  const options = videoModelOptions()
  const option = options.find((item) => item.modelId === draft.model)
  const seconds = scope === 'shot' ? (shot?.seconds ?? 0) : record.totalSeconds
  const imageId = scope === 'shot' ? shot?.imageId : wholeVideoFrameId(record)
  const prompt = scope === 'shot' ? (shot?.videoPrompt ?? '') : record.videoPrompt
  const requestRejection = videoRequestRejection(
    draft.model,
    {
      duration_seconds: seconds,
      resolution: draft.resolution,
      aspect_ratio: record.aspectRatio,
      ...(imageId ? { first_frame_index: 0 } : {}),
    },
    imageId ? 1 : 0,
  )
  const promptRejection = videoPromptRejection(draft.model, prompt)
  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: seconds,
    unitMultiplier: videoRateMultiplier(draft.model, draft.resolution),
  })
  const reason = !option
    ? t('generation.needModel')
    : scope === 'shot' && !imageId
      ? t('generation.needShotImage')
      : requestRejection
        ? videoRejectionText(requestRejection)
        : promptRejection
          ? videoRejectionText(promptRejection)
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
        .showToast(
          error instanceof Error ? describeError(error) : t('generation.submitFailed'),
          'error',
        )
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="vd-stack">
      <div className="vd-row vd-between">
        <h3>{t('action.generateVideo')}</h3>
        <button type="button" onClick={onClose}>
          {t('action.backToEdit')}
        </button>
      </div>
      <div className="vd-inset">
        <strong>{record.title}</strong>
        <p>{t('generation.sourceNote')}</p>
        <button type="button" onClick={onLibrary}>
          {t('generation.changeBoard')}
        </button>
      </div>
      <div className="vd-stack" role="group" aria-label={t('generation.scopeLabel')}>
        <button type="button" aria-pressed={scope === 'whole'} onClick={() => setScope('whole')}>
          {t('generation.wholeScope', { seconds: record.totalSeconds })}
        </button>
        <button
          type="button"
          disabled={!shot}
          aria-pressed={scope === 'shot'}
          onClick={() => setScope('shot')}
        >
          {t('generation.shotScope', { seconds: shot?.seconds ?? 0 })}
        </button>
      </div>
      <label>
        {t('generation.modelLabel')}
        <select
          aria-label={t('generation.modelAria')}
          value={draft.model}
          onChange={(e) => useVideoStore.getState().setModel(e.target.value)}
        >
          {!option && <option value="">{t('generation.selectModel')}</option>}
          {options.map((item) => (
            <option key={item.modelId} value={item.modelId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('field.resolution')}
        <select
          aria-label={t('generation.resolutionAria')}
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
        {t('generation.hint', {
          aspect: record.aspectRatio,
          mode: imageId ? t('generation.withFirstFrame') : t('generation.textOnly'),
        })}
      </p>
      {reason && (
        <p className="vd-error" role="status">
          {reason}
        </p>
      )}
      {saveState === 'error' && <p className="vd-error">{t('generation.saveError')}</p>}
      <SubmissionBillingAction blockedAction={guard.blockedAction} />
      {guard.estimatedCredits !== undefined && (
        <div className="vd-row vd-between">
          <span>{t('generation.estimatedCredits')}</span>
          <Credits credits={guard.estimatedCredits} className="font-semibold" />
        </div>
      )}
      <button
        type="button"
        className="vd-primary"
        disabled={
          submitting ||
          !option ||
          !!requestRejection ||
          !!promptRejection ||
          guard.blocked ||
          (scope === 'shot' && !imageId)
        }
        onClick={() => void submit()}
      >
        {submitting ? t('generation.submitting') : t('generation.submit', { seconds })}
      </button>
    </div>
  )
}
