import type { VideoRequest } from '@image-playground/shared'
import {
  VIDEO_MODEL_SUPPORT,
  videoDurationsForResolution,
  videoRateMultiplier,
  videoRequestRejection,
} from '@image-playground/shared'
import { useId, useState } from 'react'
import Credits from '../../../components/Credits'
import ParamControls, { type UnsupportedParam } from '../../../components/ParamControls'
import { Button } from '../../../components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { getStoredChannels } from '../../../lib/channels/channelStore'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { DEFAULT_PARAMS, type TaskParams } from '../../../types'
import type { GenerationFields } from '../lib/productionGenerationClient'
import ProductionReferenceEditor from './ProductionReferenceEditor'

const UNSUPPORTED: ReadonlySet<UnsupportedParam> = new Set(['transparent', 'noRewrite'])

function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id}>{label}</label>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
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
  const { t: tVideo } = useTranslation('video')
  const [fields, setFields] = useState<GenerationFields>(() =>
    structuredClone({
      model: value.model,
      prompt: value.prompt,
      params: value.params,
      video: value.video,
      references: value.references,
    }),
  )
  const [addingReference, setAddingReference] = useState(false)
  const models = getStoredChannels()
    .flatMap((channel) => channel.models)
    .filter((model) => (model.media ?? 'image') === (value.video ? 'video' : 'image'))
  const modelIds = Array.from(new Set([fields.model, ...models.map((model) => model.id)])).filter(
    Boolean,
  )
  const imageChannel = fields.video
    ? undefined
    : getStoredChannels().find((channel) =>
        channel.models.some(
          (model) => model.id === fields.model && (model.media ?? 'image') === 'image',
        ),
      )
  const imageModel = imageChannel?.models.find((model) => model.id === fields.model)
  const imageParams = {
    ...DEFAULT_PARAMS,
    ...Object.fromEntries(
      Object.entries(fields.params ?? {}).filter(([, value]) => value !== undefined),
    ),
  } as TaskParams
  const imageInvalid =
    !fields.video &&
    (!imageModel?.capabilities.includes('generate') ||
      (fields.references.length > 0 && !imageModel.capabilities.includes('edit')) ||
      (fields.params?.quality &&
        fields.params.quality !== 'auto' &&
        !imageModel.capabilities.includes('quality')) ||
      (fields.params?.size &&
        fields.params.size !== 'auto' &&
        !imageModel.capabilities.includes('size')) ||
      (imageChannel?.kind === 'gemini-queue'
        ? Boolean(fields.params?.output_format || fields.params?.output_compression !== undefined)
        : Boolean(
            fields.params?.gemini_aspect_ratio ||
              fields.params?.gemini_image_size ||
              fields.params?.gemini_thinking_level,
          )) ||
      (fields.params?.output_compression !== undefined &&
        (!Number.isInteger(fields.params.output_compression) ||
          fields.params.output_compression < 0 ||
          fields.params.output_compression > 100 ||
          !['jpeg', 'webp'].includes(fields.params.output_format ?? ''))))
  const support = fields.video ? VIDEO_MODEL_SUPPORT[fields.model] : undefined
  const sourceVideo = fields.video
  const first = fields.references.findIndex((item) => item.usage === 'first-frame')
  const last = fields.references.findIndex((item) => item.usage === 'last-frame')
  const references = fields.references.flatMap((item, index) =>
    item.usage === 'reference' ? [index] : [],
  )
  const final: GenerationFields = sourceVideo
    ? {
        ...fields,
        video: {
          ...sourceVideo,
          first_frame_index: first >= 0 ? first : undefined,
          last_frame_index: last >= 0 ? last : undefined,
          reference_image_indices: references.length ? references : undefined,
        },
      }
    : fields
  const invalid = final.video
    ? videoRequestRejection(final.model, final.video, final.references.length)
    : null
  const duplicateFrame =
    fields.references.filter((item) => item.usage === 'first-frame').length > 1 ||
    fields.references.filter((item) => item.usage === 'last-frame').length > 1
  const guard = usePrivateSubmissionGuard({
    model: fields.model,
    quantity: fields.video?.duration_seconds ?? 1,
    unitMultiplier: fields.video ? videoRateMultiplier(fields.model, fields.video.resolution) : 1,
  })
  const charging = submitLabel === undefined
  const blocked =
    busy ||
    !fields.prompt.trim() ||
    !fields.model ||
    Boolean(invalid) ||
    Boolean(imageInvalid) ||
    duplicateFrame ||
    (charging && guard.blocked)
  const videoField = <K extends keyof VideoRequest>(key: K, next: VideoRequest[K]) =>
    setFields((current) => ({
      ...current,
      video: current.video ? { ...current.video, [key]: next } : undefined,
    }))
  return (
    <div className="production-generation-editor">
      <label>
        {t('generation.prompt')}
        <Textarea
          value={fields.prompt}
          disabled={busy}
          rows={4}
          onChange={(event) => setFields({ ...fields, prompt: event.target.value })}
        />
      </label>
      <Choice
        label={t('generation.model')}
        value={fields.model}
        disabled={busy}
        options={modelIds.map((model) => ({
          value: model,
          label: VIDEO_MODEL_SUPPORT[model]?.label ?? model,
        }))}
        onChange={(model) => setFields({ ...fields, model })}
      />
      {!fields.video && imageChannel && (
        <fieldset disabled={busy} className="flex flex-wrap gap-2" key={fields.model}>
          <ParamControls
            unsupported={UNSUPPORTED}
            controlled={{
              profile: {
                id: `production:${imageChannel.id}`,
                source: 'builtin-edge',
                channelId: imageChannel.id,
                selectedModelId: fields.model,
              },
              params: imageParams,
              onChange: (patch) => {
                if (busy) return
                setFields((current) => {
                  const {
                    size,
                    quality,
                    output_format,
                    output_compression,
                    gemini_aspect_ratio,
                    gemini_image_size,
                    gemini_thinking_level,
                  } = { ...current.params, ...patch }
                  return {
                    ...current,
                    params: {
                      ...current.params,
                      size,
                      quality,
                      output_format,
                      output_compression: output_compression ?? undefined,
                      gemini_aspect_ratio,
                      gemini_image_size,
                      gemini_thinking_level,
                    },
                  }
                })
              },
            }}
          />
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => setFields((current) => ({ ...current, params: {} }))}
          >
            {t('generation.resetImageParameters')}
          </Button>
        </fieldset>
      )}
      {imageInvalid && <p role="alert">{t('generation.invalidImageParameters')}</p>}
      {fields.video && support && (
        <div className="production-generation-params">
          <Choice
            label={t('generation.duration')}
            value={String(fields.video.duration_seconds)}
            disabled={busy}
            options={videoDurationsForResolution(support, fields.video.resolution).map(
              (duration) => ({ value: String(duration), label: `${duration}s` }),
            )}
            onChange={(duration) => videoField('duration_seconds', Number(duration))}
          />
          <Choice
            label={t('generation.ratio')}
            value={fields.video.aspect_ratio}
            disabled={busy}
            options={support.aspectRatios.map((ratio) => ({ value: ratio, label: ratio }))}
            onChange={(ratio) => videoField('aspect_ratio', ratio as VideoRequest['aspect_ratio'])}
          />
          <Choice
            label={t('generation.resolution')}
            value={fields.video.resolution}
            disabled={busy}
            options={support.resolutions.map((resolution) => ({
              value: resolution,
              label: resolution,
            }))}
            onChange={(resolution) =>
              videoField('resolution', resolution as VideoRequest['resolution'])
            }
          />
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
            <Choice
              label={t('generation.referenceUsage')}
              value={item.usage ?? 'reference'}
              disabled={busy}
              options={[
                { value: 'reference', label: t('generation.referenceImage') },
                { value: 'first-frame', label: t('generation.firstFrame') },
                { value: 'last-frame', label: t('generation.lastFrame') },
              ]}
              onChange={(value) => {
                const usage = value as 'first-frame' | 'last-frame' | 'reference'
                setFields((current) => ({
                  ...current,
                  references: current.references.map((one, i) =>
                    i === index ? { ...one, usage } : one,
                  ),
                }))
              }}
            />
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
        <Button
          type="button"
          variant="outline"
          disabled={busy || fields.references.length >= 14}
          onClick={() => setAddingReference(true)}
        >
          {t('generation.addReference')}
        </Button>
      )}
      {invalid && <p role="alert">{tVideo(`reject.${invalid.code}`, { ...invalid.params })}</p>}
      {duplicateFrame && <p role="alert">{t('generation.duplicateFrame')}</p>}
      {charging && guard.blocked && (
        <p role="status">
          {guard.disabledReason}
          {guard.blockedAction && (
            <Button type="button" variant="link" onClick={guard.blockedAction.run}>
              {guard.blockedAction.label}
            </Button>
          )}
        </p>
      )}
      <Button
        type="button"
        aria-label={submitLabel ?? t('generation.confirm')}
        disabled={blocked}
        onClick={() => {
          if (!blocked) onConfirm(final)
        }}
      >
        {submitLabel ?? t('generation.confirm')}
        {charging && guard.estimatedCredits !== undefined && (
          <>
            {' '}
            · <Credits credits={guard.estimatedCredits} />
          </>
        )}
      </Button>
    </div>
  )
}
