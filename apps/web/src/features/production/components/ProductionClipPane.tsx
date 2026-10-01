import {
  type ProductionClipPlan,
  type ProductionDocument,
  type ProductionMediaReference,
  productionClipVideo,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  type VideoRequest,
  videoPromptRejection,
  videoRateMultiplier,
  videoRequestRejection,
} from '@image-playground/shared'
import { Film, Plus, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Checkbox } from '../../../components/ui/checkbox'
import { Input } from '../../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import type { ProductionResponse } from '../lib/productionClient'
import { setProductionPanelContext } from '../lib/productionContext'
import { useProductionEditor } from '../lib/useProductionEditor'
import ProductionDependencyNotice from './ProductionDependencyNotice'
import ProductionReferencePreview from './ProductionReferencePreview'

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <label>
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!options.some((one) => one.value === value) && value && (
            <SelectItem value={value}>{value}</SelectItem>
          )}
          {options.map((one) => (
            <SelectItem key={one.value} value={one.value}>
              {one.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

export default function ProductionClipPane({
  document,
  onSaved,
  onClose,
  renderGenerations,
}: {
  document: ProductionDocument
  onSaved: (next: ProductionResponse) => void
  onClose: () => void
  renderGenerations?: (clip: ProductionClipPlan, preparationBlocked?: string) => ReactNode
}) {
  const { t } = useTranslation('production')
  const { t: tv } = useTranslation('video')
  const edit = useProductionEditor(document, onSaved, 'clips')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const clips = edit.content.clips ?? []
  const selected = clips.find((one) => one.id === selectedId) ?? clips[0]
  useEffect(() => {
    if (!selected) return
    setProductionPanelContext(document.conversationId, {
      documentId: document.id,
      revision: document.revision,
      target: 'clip',
      clipId: selected.id,
    })
    return () => setProductionPanelContext(document.conversationId, null)
  }, [document.conversationId, document.id, document.revision, selected?.id])
  const options = videoModelOptions()
  const option = options.find((one) => one.modelId === selected?.model)
  const guard = usePrivateSubmissionGuard({
    model: selected?.model ?? '',
    quantity: selected?.video.duration_seconds ?? 1,
    unitMultiplier: videoRateMultiplier(
      selected?.model ?? '',
      selected?.video.resolution ?? '720p',
    ),
  })
  const update = (clip: ProductionClipPlan) =>
    edit.update({ ...edit.content, clips: clips.map((one) => (one.id === clip.id ? clip : one)) })
  const changeVideo = (patch: Partial<VideoRequest>) => {
    if (selected) update({ ...selected, video: { ...selected.video, ...patch } })
  }
  const invalid =
    selected &&
    (videoRequestRejection(
      selected.model,
      productionClipVideo(selected),
      selected.references.length,
    ) ??
      videoPromptRejection(selected.model, selected.prompt))
  const channelUnsupported =
    selected?.references.some((one) => one.usage === 'reference') &&
    !option?.support.referenceImages
  const shots = edit.content.shots ?? []
  const missing = selected?.shotIds.filter((id) => !shots.some((shot) => shot.id === id)) ?? []
  const add = () => {
    const model = options[0]
    const clip: ProductionClipPlan = {
      id: crypto.randomUUID(),
      name: t('clip.new'),
      shotIds: [],
      prompt: '',
      model: model?.modelId ?? '',
      video: {
        duration_seconds: model?.support.durations[0] ?? 5,
        aspect_ratio: model?.support.aspectRatios[0] ?? '16:9',
        resolution: model?.support.resolutions[0] ?? '720p',
      },
      references: [],
      sourceRevision: document.revision,
    }
    edit.update({ ...edit.content, clips: [...clips, clip] })
    setSelectedId(clip.id)
  }
  const references: { name: string; reference: ProductionMediaReference }[] = []
  for (const shot of shots)
    if (selected?.shotIds.includes(shot.id)) {
      if (shot.keyframe) references.push({ name: shot.description, reference: shot.keyframe })
      for (const character of edit.content.characters ?? [])
        for (const look of character.looks)
          if (shot.lookIds.includes(look.id) && look.reference)
            references.push({ name: `${character.name} · ${look.name}`, reference: look.reference })
      const location = edit.content.locations?.find((one) => one.id === shot.locationId)
      if (location?.reference)
        references.push({ name: location.name, reference: location.reference })
    }
  const uniqueReferences = references.filter(
    (one, index) =>
      references.findIndex(
        (other) => JSON.stringify(other.reference) === JSON.stringify(one.reference),
      ) === index,
  )
  const canSave = clips.every(
    (one) =>
      one.name.trim() &&
      one.prompt.trim() &&
      one.shotIds.length > 0 &&
      !videoRequestRejection(one.model, productionClipVideo(one), one.references.length) &&
      !videoPromptRejection(one.model, one.prompt),
  )
  return (
    <aside className="production-document" aria-label={t('clip.title')}>
      <header className="production-pane-header">
        <span>
          <Film size={17} />
          {t('clip.title')}
        </span>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="production-document-tools">
        <button type="button" onClick={add} disabled={edit.saving || clips.length >= 40}>
          <Plus size={14} />
          {t('clip.add')}
        </button>
        {edit.draft && (
          <>
            <button
              type="button"
              className="production-primary"
              disabled={!canSave || edit.saving}
              onClick={() => void edit.save()}
            >
              {t('asset.save')}
            </button>
            <button type="button" disabled={edit.saving} onClick={edit.discard}>
              {t('discard')}
            </button>
          </>
        )}
      </div>
      {edit.error && (
        <p className="production-error" role="alert">
          {t(edit.error)}
        </p>
      )}
      <nav className="production-look-tabs production-clip-tabs">
        {clips.map((one) => (
          <button
            key={one.id}
            type="button"
            aria-pressed={one.id === selected?.id}
            onClick={() => setSelectedId(one.id)}
          >
            {one.name}
          </button>
        ))}
      </nav>
      <div className="production-document-scroll">
        {!selected ? (
          <p className="production-prose">{t('clip.empty')}</p>
        ) : (
          <div className="production-asset-form">
            {!edit.draft && (
              <ProductionDependencyNotice
                document={document}
                target={{ kind: 'clip', id: selected.id }}
                onSaved={onSaved}
              />
            )}
            <label>
              {t('clip.name')}
              <Input
                aria-label={t('clip.name')}
                value={selected.name}
                onChange={(event) => update({ ...selected, name: event.target.value })}
              />
            </label>
            <fieldset className="production-clip-shots">
              <legend>{t('clip.shots')}</legend>
              {shots.map((shot, index) => (
                <label key={shot.id}>
                  <Checkbox
                    checked={selected.shotIds.includes(shot.id)}
                    onCheckedChange={(checked) =>
                      update({
                        ...selected,
                        shotIds:
                          checked === true
                            ? [...selected.shotIds, shot.id]
                            : selected.shotIds.filter((id) => id !== shot.id),
                      })
                    }
                  />
                  <span>
                    {index + 1}. {shot.description}
                  </span>
                </label>
              ))}
              {!shots.length && <p>{t('clip.noShots')}</p>}
            </fieldset>
            <ol className="production-clip-order">
              {selected.shotIds.map((id, index) => (
                <li key={id}>
                  <span>
                    {shots.find((one) => one.id === id)?.description ?? t('clip.missingShot')}
                  </span>
                  <button
                    type="button"
                    disabled={index === 0}
                    aria-label={`${t('asset.up')} ${index + 1}`}
                    onClick={() => {
                      const ids = [...selected.shotIds]
                      ;[ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]
                      update({ ...selected, shotIds: ids })
                    }}
                  >
                    {t('asset.up')}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('clip.removeShot')} ${index + 1}`}
                    onClick={() =>
                      update({ ...selected, shotIds: selected.shotIds.filter((one) => one !== id) })
                    }
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ol>
            <label>
              {t('clip.prompt')}
              <Textarea
                aria-label={t('clip.prompt')}
                rows={6}
                value={selected.prompt}
                onChange={(event) => update({ ...selected, prompt: event.target.value })}
              />
            </label>
            <Choice
              label={tv('field.model')}
              value={selected.model}
              options={options.map((one) => ({ value: one.modelId, label: one.label }))}
              onChange={(model) => update({ ...selected, model })}
            />
            <div className="production-clip-params">
              <Choice
                label={tv('composer.durationLabel')}
                value={String(selected.video.duration_seconds)}
                options={VIDEO_DURATIONS.map((value) => ({
                  value: String(value),
                  label: tv('shared.seconds', { seconds: value }),
                }))}
                onChange={(value) => changeVideo({ duration_seconds: Number(value) })}
              />
              <Choice
                label={tv('field.aspectRatio')}
                value={selected.video.aspect_ratio}
                options={VIDEO_ASPECT_RATIOS.map((value) => ({ value, label: value }))}
                onChange={(value) => {
                  if (VIDEO_ASPECT_RATIOS.includes(value as VideoRequest['aspect_ratio']))
                    changeVideo({ aspect_ratio: value as VideoRequest['aspect_ratio'] })
                }}
              />
              <Choice
                label={tv('field.resolution')}
                value={selected.video.resolution}
                options={VIDEO_RESOLUTIONS.map((value) => ({ value, label: value }))}
                onChange={(value) => {
                  if (VIDEO_RESOLUTIONS.includes(value as VideoRequest['resolution']))
                    changeVideo({ resolution: value as VideoRequest['resolution'] })
                }}
              />
            </div>
            <section className="production-clip-references">
              <h3>{t('clip.references')}</h3>
              {uniqueReferences.map((one) => (
                <button
                  type="button"
                  key={JSON.stringify(one.reference)}
                  disabled={selected.references.some(
                    (ref) => JSON.stringify(ref.reference) === JSON.stringify(one.reference),
                  )}
                  onClick={() =>
                    update({
                      ...selected,
                      references: [
                        ...selected.references,
                        { reference: one.reference, usage: 'reference' },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  {one.name}
                </button>
              ))}
              {selected.references.map((one, index) => (
                <div
                  className="production-clip-reference"
                  key={`${JSON.stringify(one.reference)}:${index}`}
                >
                  <ProductionReferencePreview
                    conversationId={document.conversationId}
                    reference={one.reference}
                    name={`${index + 1}`}
                  />
                  <Choice
                    label={`${t('clip.usage')} ${index + 1}`}
                    value={one.usage}
                    options={(['first-frame', 'last-frame', 'reference'] as const).map((value) => ({
                      value,
                      label: t(`clip.${value}`),
                    }))}
                    onChange={(value) =>
                      update({
                        ...selected,
                        references: selected.references.map((ref, i) =>
                          i === index ? { ...ref, usage: value as typeof one.usage } : ref,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    aria-label={`${t('asset.removeReference')} ${index + 1}`}
                    onClick={() =>
                      update({
                        ...selected,
                        references: selected.references.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </section>
            {(invalid || !option || channelUnsupported || missing.length > 0) && (
              <p role="alert" className="production-error">
                {invalid
                  ? tv(`reject.${invalid.code}`, { ...invalid.params })
                  : missing.length
                    ? t('clip.missingShot')
                    : t('clip.unavailable')}
              </p>
            )}
            <p className="production-prose">
              {t('clip.expected', { seconds: selected.video.duration_seconds })}
              {guard.estimatedCredits !== undefined &&
                ` · ${t('clip.estimate', { credits: guard.estimatedCredits })}`}
            </p>
            {renderGenerations?.(
              selected,
              edit.draft
                ? t('clip.saveBeforeGenerate')
                : missing.length
                  ? t('clip.missingShot')
                  : invalid || !option || channelUnsupported
                    ? t('clip.unavailable')
                    : undefined,
            )}
            {edit.draft && <p className="production-prose">{t('clip.saveBeforeGenerate')}</p>}
            <div className="production-asset-danger">
              {deleteId === selected.id ? (
                <>
                  <p>{t('clip.deleteImpact')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      edit.update({
                        ...edit.content,
                        clips: clips.filter((one) => one.id !== selected.id),
                      })
                      setDeleteId(null)
                    }}
                  >
                    {t('asset.deleteConfirm')}
                  </button>
                  <button type="button" onClick={() => setDeleteId(null)}>
                    {t('cancel')}
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setDeleteId(selected.id)}>
                  {t('asset.delete')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
