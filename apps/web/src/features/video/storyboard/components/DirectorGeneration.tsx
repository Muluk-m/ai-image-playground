import {
  VIDEO_RESOLUTION_LABELS,
  videoDurationsForResolution,
  videoPromptRejection,
  videoRateMultiplier,
  videoRequestRejection,
} from '@image-playground/shared'
import { useState } from 'react'
import Credits from '../../../../components/Credits'
import Field from '../../../../components/Field'
import SubmissionBillingAction from '../../../../components/SubmissionBillingAction'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/ui/select'
import { describeError, useTranslation } from '../../../../i18n'
import { videoModelOptions } from '../../../../lib/channels/videoChannels'
import { usePrivateSubmissionGuard } from '../../../../lib/privateOverlay'
import { useStore } from '../../../../store'
import { videoRejectionText } from '../../lib/labels'
import { useVideoStore } from '../../store'
import { promptAtDuration } from '../lib/director'
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
  const [selectedSeconds, setSelectedSeconds] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const draft = useVideoStore((s) => s.draft)
  const saveState = useStoryboardStore((s) => s.saveStates[record.id])
  const options = videoModelOptions()
  const option = options.find((item) => item.modelId === draft.model)
  const sourceSeconds = scope === 'shot' ? (shot?.seconds ?? 0) : record.totalSeconds
  const durations = option ? videoDurationsForResolution(option.support, draft.resolution) : []
  const preferredSeconds = selectedSeconds ?? sourceSeconds
  const seconds = durations.reduce<number>(
    (nearest, value) =>
      Math.abs(value - preferredSeconds) < Math.abs(nearest - preferredSeconds) ? value : nearest,
    durations[0] ?? sourceSeconds,
  )
  const imageId = scope === 'shot' ? shot?.imageId : wholeVideoFrameId(record)
  const prompt = promptAtDuration(
    scope === 'shot' ? (shot?.videoPrompt ?? '') : record.videoPrompt,
    sourceSeconds,
    seconds,
  )
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
          ? await useStoryboardStore.getState().generateShotVideo(record.id, shot.no, seconds)
          : await useStoryboardStore.getState().generateWholeVideo(record.id, seconds)
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
        <button
          type="button"
          aria-pressed={scope === 'whole'}
          onClick={() => {
            setScope('whole')
            setSelectedSeconds(null)
          }}
        >
          {t('generation.wholeScope', { seconds: record.totalSeconds })}
        </button>
        <button
          type="button"
          disabled={!shot}
          aria-pressed={scope === 'shot'}
          onClick={() => {
            setScope('shot')
            setSelectedSeconds(null)
          }}
        >
          {t('generation.shotScope', { seconds: shot?.seconds ?? 0 })}
        </button>
      </div>
      <Field label={t('generation.modelLabel')}>
        <Select
          value={draft.model}
          onValueChange={(value) => useVideoStore.getState().setModel(value)}
        >
          <SelectTrigger aria-label={t('generation.modelAria')} className="text-foreground">
            <SelectValue placeholder={t('generation.selectModel')} />
          </SelectTrigger>
          <SelectContent>
            {options.map((item) => (
              <SelectItem key={item.modelId} value={item.modelId}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('field.resolution')}>
        <Select
          value={draft.resolution}
          onValueChange={(value) =>
            useVideoStore.getState().setResolution(value as typeof draft.resolution)
          }
        >
          <SelectTrigger aria-label={t('generation.resolutionAria')} className="text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {option?.support.resolutions.map((r) => (
              <SelectItem key={r} value={r}>
                {VIDEO_RESOLUTION_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('generation.durationLabel')}>
        <Select
          value={String(seconds)}
          onValueChange={(value) => setSelectedSeconds(Number(value))}
        >
          <SelectTrigger aria-label={t('generation.durationAria')} className="text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {durations.map((duration) => (
              <SelectItem key={duration} value={String(duration)}>
                {t('shared.seconds', { seconds: duration })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {seconds !== sourceSeconds && (
        <p className="vd-muted">
          {t('generation.durationAdjusted', { source: sourceSeconds, target: seconds })}
        </p>
      )}
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
