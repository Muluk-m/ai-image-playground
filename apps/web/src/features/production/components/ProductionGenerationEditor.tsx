import type { VideoRequest } from '@image-playground/shared'
import {
  VIDEO_MODEL_SUPPORT,
  validateVideoRequest,
  videoDurationsForResolution,
} from '@image-playground/shared'
import { useState } from 'react'
import { useTranslation } from '../../../i18n'
import { getStoredChannels } from '../../../lib/channels/channelStore'
import type { GenerationFields } from '../lib/productionGenerationClient'
import ProductionReferenceEditor from './ProductionReferenceEditor'

export default function ProductionGenerationEditor({
  value,
  busy,
  onConfirm,
  submitLabel,
  conversationId,
}: {
  conversationId: string
  value: GenerationFields
  busy: boolean
  submitLabel?: string
  onConfirm: (value: GenerationFields) => void
}) {
  const { t } = useTranslation('production')
  const [fields, setFields] = useState(value)
  const [addingReference, setAddingReference] = useState(false)
  const models = getStoredChannels()
    .flatMap((c) => c.models)
    .filter((m) => m.media === (value.video ? 'video' : 'image'))
  const modelIds = Array.from(new Set([fields.model, ...models.map((m) => m.id)]))
  const support = fields.video ? VIDEO_MODEL_SUPPORT[fields.model] : undefined
  const finalFields = (): GenerationFields => {
    if (!fields.video) return fields
    const {
      first_frame_index: _first,
      last_frame_index: _last,
      reference_image_indices: _refs,
      ...video
    } = fields.video
    const first = fields.references.findIndex((ref) => ref.usage === 'first-frame')
    const last = fields.references.findIndex((ref) => ref.usage === 'last-frame')
    const references = fields.references.flatMap((ref, index) =>
      ref.usage === 'reference' ? [index] : [],
    )
    return {
      ...fields,
      video: {
        ...video,
        ...(first >= 0 ? { first_frame_index: first } : {}),
        ...(last >= 0 ? { last_frame_index: last } : {}),
        ...(references.length ? { reference_image_indices: references } : {}),
      },
    }
  }
  const final = finalFields()
  const validation = final.video
    ? validateVideoRequest(final.model, final.video, final.references.length)
    : { ok: true as const }
  const videoField = <K extends keyof VideoRequest>(key: K, value: VideoRequest[K]) =>
    setFields((current) => ({
      ...current,
      video: current.video ? { ...current.video, [key]: value } : undefined,
    }))
  return (
    <div className="production-generation-editor">
      <label>
        {t('generation.prompt')}
        <textarea
          value={fields.prompt}
          disabled={busy}
          rows={4}
          onChange={(event) => setFields({ ...fields, prompt: event.target.value })}
        />
      </label>
      <label>
        {t('generation.model')}
        <select
          value={fields.model}
          disabled={busy}
          onChange={(event) => setFields({ ...fields, model: event.target.value })}
        >
          {modelIds.map((model) => (
            <option value={model} key={model}>
              {VIDEO_MODEL_SUPPORT[model]?.label ?? model}
            </option>
          ))}
        </select>
      </label>
      {fields.video && support && (
        <div className="production-generation-params">
          <label>
            {t('generation.duration')}
            <select
              disabled={busy}
              value={fields.video.duration_seconds}
              onChange={(e) => videoField('duration_seconds', Number(e.target.value))}
            >
              {videoDurationsForResolution(support, fields.video.resolution).map((v) => (
                <option key={v} value={v}>
                  {v}s
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('generation.ratio')}
            <select
              disabled={busy}
              value={fields.video.aspect_ratio}
              onChange={(e) =>
                videoField('aspect_ratio', e.target.value as VideoRequest['aspect_ratio'])
              }
            >
              {support.aspectRatios.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            {t('generation.resolution')}
            <select
              disabled={busy}
              value={fields.video.resolution}
              onChange={(e) =>
                videoField('resolution', e.target.value as VideoRequest['resolution'])
              }
            >
              {support.resolutions.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <small>{t('generation.references', { count: fields.references.length })}</small>
      {fields.references.map((item, index) => (
        <div key={`${item.reference.kind}:${index}`}>
          <ProductionReferenceEditor
            conversationId={conversationId}
            name={t('generation.reference', { number: index + 1 })}
            value={item.reference}
            disabled={busy}
            onChange={(reference) =>
              setFields((current) => ({
                ...current,
                references: reference
                  ? current.references.map((one, i) => (i === index ? { ...one, reference } : one))
                  : current.references.filter((_, i) => i !== index),
              }))
            }
          />
          {fields.video && (
            <select
              aria-label={t('generation.referenceUsage')}
              disabled={busy}
              value={item.usage ?? 'reference'}
              onChange={(event) => {
                const usage = event.target.value as 'first-frame' | 'last-frame' | 'reference'
                setFields((current) => ({
                  ...current,
                  references: current.references.map((one, i) =>
                    i === index ? { ...one, usage } : one,
                  ),
                }))
              }}
            >
              <option value="reference">{t('generation.referenceImage')}</option>
              <option value="first-frame">{t('generation.firstFrame')}</option>
              <option value="last-frame">{t('generation.lastFrame')}</option>
            </select>
          )}
        </div>
      ))}
      {addingReference ? (
        <ProductionReferenceEditor
          conversationId={conversationId}
          name={t('generation.addReference')}
          disabled={busy}
          onChange={(reference) => {
            if (reference) {
              setFields((current) => ({
                ...current,
                references: [
                  ...current.references,
                  { reference, ...(fields.video ? { usage: 'reference' as const } : {}) },
                ],
              }))
              setAddingReference(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          disabled={busy || fields.references.length >= 14}
          onClick={() => setAddingReference(true)}
        >
          {t('generation.addReference')}
        </button>
      )}
      {!validation.ok && <p role="alert">{validation.reason}</p>}
      <button
        type="button"
        disabled={busy || !fields.prompt.trim() || !fields.model || !validation.ok}
        onClick={() => onConfirm(final)}
      >
        {submitLabel ?? t('generation.confirm')}
      </button>
    </div>
  )
}
