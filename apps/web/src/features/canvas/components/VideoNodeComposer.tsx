import { videoRateMultiplier } from '@image-playground/shared'
import { type ReactNode, useEffect, useRef } from 'react'
import Credits from '../../../components/Credits'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import type { AssetRecord } from '../../library/types'
import { clampDraftToSupport } from '../../video/lib/draft'
import { useVideoStore } from '../../video/store'
import type { VideoDraft } from '../../video/types'
import { type NodeReference, referenceFileIds } from '../lib/nodeCanvasFlow'
import {
  effectiveNodeVideoMode,
  nodeVideoInputs,
  nodeVideoModes,
  nodeVideoSupport,
} from '../lib/nodeVideoModes'
import { useNodeReferenceDraft } from '../lib/useNodeReferenceDraft'
import CanvasVideoParams from './CanvasVideoParams'
import NodeComposerFrame from './NodeComposerFrame'
import NodeMediaImage from './NodeMediaImage'
import NodePromptInput from './NodePromptInput'

export default function VideoNodeComposer({
  onAsset,
  value,
  onChange,
  onSubmit,
  busy,
  position,
  referenceTools,
  resultTools,
  references,
  files,
  document,
  nodeId,
  meta,
  onMeta,
}: {
  onAsset?: (asset: AssetRecord, prompt: string) => Promise<boolean>
  value: string
  onChange: (text: string) => void
  onSubmit: (
    draft: VideoDraft,
    refs: readonly NodeReference[],
    roles: Record<string, string>,
    files: Readonly<Record<string, string>>,
  ) => void
  busy: boolean
  position: { left: number; top: number }
  resultTools?: ReactNode
  referenceTools: ReactNode
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  document: object
  nodeId: string
  meta: Record<string, string>
  onMeta: (patch: Record<string, string>, trackUndo?: boolean) => void
}) {
  const { t } = useTranslation('canvas')
  const globalDraft = useVideoStore((state) => state.draft)
  let saved: Partial<VideoDraft> = {}
  try {
    const parsed = JSON.parse(meta.nodeVideoDraft ?? '{}')
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.model === 'string' &&
      typeof parsed.duration === 'number' &&
      typeof parsed.resolution === 'string' &&
      typeof parsed.aspectRatio === 'string'
    )
      saved = {
        model: parsed.model,
        duration: parsed.duration,
        resolution: parsed.resolution,
        aspectRatio: parsed.aspectRatio,
        voices: Array.isArray(parsed.voices)
          ? parsed.voices.filter((one: unknown) => typeof one === 'string')
          : undefined,
      }
  } catch {
    /* Older nodes start from the workbench's current draft. */
  }
  const options = videoModelOptions()
  const option =
    options.find((one) => one.modelId === (saved.model ?? globalDraft.model)) ?? options[0]
  const legacyFirst = references.find((ref) => meta[`role:${ref.id}`] === 'first')?.id
  const legacyLast = references.find((ref) => meta[`role:${ref.id}`] === 'last')?.id
  const mode = option
    ? effectiveNodeVideoMode(
        option.support,
        meta.nodeVideoMode ?? (legacyLast ? 'frames' : legacyFirst ? 'first' : undefined),
      )
    : 'text'
  const requestedDraft = { ...globalDraft, ...saved, model: option?.modelId ?? globalDraft.model }
  const support = option
    ? nodeVideoSupport(option.support, mode, Boolean(requestedDraft.voices?.length))
    : undefined
  const draft = support ? clampDraftToSupport(requestedDraft, support) : requestedDraft
  useEffect(() => {
    if (!meta.nodeVideoDraft && option) onMeta({ nodeVideoDraft: JSON.stringify(draft) }, false)
  }, [meta.nodeVideoDraft, option?.modelId])
  const changeDraft = (patch: Partial<VideoDraft>) => {
    const next = { ...draft, ...patch }
    const support = options.find((one) => one.modelId === next.model)?.support
    if (support)
      onMeta({
        nodeVideoDraft: JSON.stringify(
          clampDraftToSupport(
            next,
            nodeVideoSupport(
              support,
              effectiveNodeVideoMode(support, mode),
              Boolean(next.voices?.length),
            ),
          ),
        ),
      })
  }
  const uploads = useNodeReferenceDraft(document, nodeId)
  const allFiles = {
    ...files,
    ...Object.fromEntries(uploads.items.map((item) => [item.id, item.url])),
  }
  const allRefs = [
    ...references,
    ...uploads.items.map(
      (item): NodeReference => ({ id: item.id, fileId: item.id, label: item.name, kind: 'image' }),
    ),
  ]
  const inputs = nodeVideoInputs(mode, allRefs, {
    first: meta.videoFirstFrame ?? legacyFirst,
    last: meta.videoLastFrame ?? legacyLast,
  })
  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: draft.duration,
    unitMultiplier: videoRateMultiplier(draft.model, draft.resolution),
  })
  const imageCount = inputs.refs.filter((ref) => ref.kind === 'image').length
  const referenceMax = option?.support.referenceImages?.max ?? API_MAX_IMAGES
  const inputError = inputs.missing
    ? t('nodes.chooseFrame')
    : mode === 'reference' && imageCount > referenceMax
      ? t('nodes.tooManyVideoReferences', { max: referenceMax })
      : inputs.refs.some((ref) => ref.kind === 'image' && (!ref.fileId || !allFiles[ref.fileId]))
        ? t('nodes.mediaMissing')
        : undefined
  const canSend =
    !inputError &&
    !busy &&
    !uploads.uploading &&
    Boolean(option) &&
    !inputs.missing &&
    Boolean(value.trim() || inputs.refs.some((ref) => ref.text))
  const send = () => {
    if (canSend) onSubmit(draft, inputs.refs, inputs.roles, allFiles)
  }
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadSlot = useRef<'first' | 'last' | 'reference'>('reference')
  const setSlot = (slot: 'first' | 'last', id: string) =>
    onMeta({ [slot === 'first' ? 'videoFirstFrame' : 'videoLastFrame']: id })
  const swap = () =>
    onMeta({ videoFirstFrame: inputs.last?.id ?? '', videoLastFrame: inputs.first?.id ?? '' })
  const modeLabels = {
    text: t('nodes.videoModeText'),
    first: t('nodes.videoModeFirst'),
    frames: t('nodes.videoModeFrames'),
    reference: t('nodes.videoModeReference'),
  }
  return (
    <NodeComposerFrame
      label={t('nodes.composerVideo')}
      position={position}
      references={[]}
      files={{}}
    >
      {resultTools}
      {option && (
        <Select value={mode} onValueChange={(next) => onMeta({ nodeVideoMode: next })}>
          <SelectTrigger
            className="h-8 w-auto max-w-full text-xs"
            aria-label={t('nodes.videoMode')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {nodeVideoModes(option.support).map((one) => (
              <SelectItem key={one} value={one}>
                {modeLabels[one]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {referenceTools}
      {(mode === 'first' || mode === 'frames') && (
        <div className="flex items-center gap-2">
          {(['first', ...(mode === 'frames' ? ['last'] : [])] as ('first' | 'last')[]).map(
            (slot) => {
              const ref = inputs[slot]
              return (
                <div
                  key={slot}
                  className="min-w-0 flex-1 rounded-lg border bg-muted/30 p-2"
                  draggable={Boolean(ref)}
                  onDragStart={(event) =>
                    event.dataTransfer.setData('application/x-canvas-frame', slot)
                  }
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const source = event.dataTransfer.getData('application/x-canvas-frame')
                    if (source && source !== slot) swap()
                  }}
                >
                  <div className="mb-1 text-xs text-muted-foreground">
                    {t(slot === 'first' ? 'nodes.firstFrame' : 'nodes.lastFrame')}
                  </div>
                  {ref?.fileId && allFiles[ref.fileId] ? (
                    <NodeMediaImage
                      src={allFiles[ref.fileId]}
                      alt={ref.label}
                      className="mb-2 h-16 w-full rounded-sm object-cover"
                    />
                  ) : (
                    <div className="mb-2 flex h-16 items-center justify-center text-muted-foreground">
                      <Icon name="image" />
                    </div>
                  )}
                  <Select value={ref?.id ?? ''} onValueChange={(id) => setSlot(slot, id)}>
                    <SelectTrigger
                      className="h-7 w-full text-xs"
                      aria-label={t(slot === 'first' ? 'nodes.firstFrame' : 'nodes.lastFrame')}
                    >
                      <SelectValue placeholder={t('nodes.chooseFrame')} />
                    </SelectTrigger>
                    <SelectContent>
                      {allRefs
                        .filter((one) => one.kind === 'image' && !one.asset)
                        .map((one) => (
                          <SelectItem key={one.id} value={one.id}>
                            {one.label || t('nodes.addImage')}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || uploads.uploading}
                    className="mt-1 w-full text-xs"
                    onClick={() => {
                      uploadSlot.current = slot
                      uploadInput.current?.click()
                    }}
                  >
                    <Icon name="upload" size="xs" />
                    {t('nodes.addUpload')}
                  </Button>
                </div>
              )
            },
          )}
          {mode === 'frames' && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('nodes.swapFrames')}
              disabled={!inputs.first || !inputs.last || busy}
              onClick={swap}
            >
              <Icon name="refresh" />
            </Button>
          )}
        </div>
      )}
      {mode === 'reference' && (
        <div className="flex flex-wrap items-center gap-2">
          {uploads.items.map((item, index) => (
            <div key={item.id} className="flex items-center gap-1 rounded-md border p-1">
              <NodeMediaImage
                src={item.url}
                alt={item.name}
                className="h-8 w-8 rounded-sm object-cover"
              />
              <span className="text-xs">
                {referenceFileIds(references, files).length + index + 1}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('nodes.removeReference')}
                onClick={() => uploads.remove(item.id)}
              >
                <Icon name="close" />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || uploads.uploading}
            onClick={() => {
              uploadSlot.current = 'reference'
              uploadInput.current?.click()
            }}
          >
            <Icon name="imageAdd" />
            {t('nodes.addUpload')}
          </Button>
        </div>
      )}
      <NodePromptInput
        value={value}
        onChange={onChange}
        onSubmit={send}
        onAsset={onAsset}
        label={t('nodes.composerVideo')}
        className="max-h-40 min-h-20 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
      />
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          {option ? (
            <CanvasVideoParams
              hasFirstFrame={Boolean(inputs.first)}
              size="sm"
              controlled={{ draft, onChange: changeDraft, support }}
            />
          ) : (
            <span className="text-xs text-muted-foreground">{t('nodes.noVideoModel')}</span>
          )}
        </div>
        <Button
          size="icon"
          className="shrink-0 rounded-full"
          aria-label={t('nodes.composerSend')}
          disabled={!canSend}
          onClick={send}
        >
          <Icon name={busy ? 'loading' : 'generate'} />
        </Button>
      </div>
      {inputError && (
        <p role="status" className="text-xs text-muted-foreground">
          {inputError}
        </p>
      )}
      {guard.estimatedCredits !== undefined && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {t('nodes.estimatedCost')} <Credits credits={guard.estimatedCredits} />
        </div>
      )}
      <input
        ref={uploadInput}
        type="file"
        accept="image/*"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file?.type.startsWith('image/')) return
          if (
            allRefs.filter((ref) => ref.kind === 'image').length >=
            (mode === 'reference' ? referenceMax : API_MAX_IMAGES)
          ) {
            useStore.getState().showToast(
              t('submit.tooManyInputs', {
                max: mode === 'reference' ? referenceMax : API_MAX_IMAGES,
              }),
              'error',
            )
            return
          }
          const slot = uploadSlot.current
          try {
            const item = await uploads.upload(file)
            if (item && slot !== 'reference') setSlot(slot, item.id)
          } catch {
            useStore.getState().showToast(t('import.failed'), 'error')
          }
        }}
      />
    </NodeComposerFrame>
  )
}
