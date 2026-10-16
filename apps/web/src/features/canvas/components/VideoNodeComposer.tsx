import { videoRateMultiplier } from '@image-playground/shared'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Hint } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import Credits from '../../../components/Credits'
import {
  CreationBody,
  CreationSend,
  CreationToolbar,
} from '../../../components/creation/CreationFrame'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
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
import { nodeVideoConfiguration } from '../lib/nodeVideoConfiguration'
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
  onReferenceUpload,
  onPickReference,
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
  onReferenceUpload?: (file: File, slot?: 'first' | 'last') => Promise<void>
  onPickReference?: (slot?: 'first' | 'last') => void
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  document: object
  nodeId: string
  meta: Record<string, string>
  onMeta: (patch: Record<string, string>, trackUndo?: boolean) => void
}) {
  const { t } = useTranslation('canvas')
  const globalDraft = useVideoStore((state) => state.draft)
  const options = videoModelOptions()
  const { option, mode, support, draft, legacyFirst, legacyLast } = nodeVideoConfiguration(
    meta,
    references,
    globalDraft,
    options,
  )
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
  const [frameMenu, setFrameMenu] = useState<'first' | 'last' | null>(null)
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
      standard
      tools={resultTools}
      label={t('nodes.composerVideo')}
      position={position}
      references={[]}
      files={{}}
    >
      <CreationBody
        references={
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 max-w-full">{referenceTools}</div>
            {(mode === 'first' || mode === 'frames') && (
              <div className="flex items-center gap-2">
                {(['first', ...(mode === 'frames' ? ['last'] : [])] as ('first' | 'last')[]).map(
                  (slot) => {
                    const ref = inputs[slot]
                    return (
                      <div
                        key={slot}
                        className="flex flex-col items-center gap-1"
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
                        <Popover
                          open={frameMenu === slot}
                          onOpenChange={(open) => setFrameMenu(open ? slot : null)}
                        >
                          <PopoverTrigger asChild>
                            <Button
                              variant="ghost"
                              className="creation-add overflow-hidden"
                              disabled={busy}
                              aria-label={t(
                                slot === 'first' ? 'nodes.firstFrame' : 'nodes.lastFrame',
                              )}
                              title={t(slot === 'first' ? 'nodes.firstFrame' : 'nodes.lastFrame')}
                            >
                              {ref?.fileId && allFiles[ref.fileId] ? (
                                <NodeMediaImage
                                  src={allFiles[ref.fileId]}
                                  alt={ref.label}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <Icon name="add" />
                              )}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            side="top"
                            align="start"
                            className="creation-popover w-56"
                          >
                            {onPickReference ? (
                              <Button
                                variant="ghost"
                                className="creation-menu-item"
                                onClick={() => {
                                  setFrameMenu(null)
                                  onPickReference(slot)
                                }}
                              >
                                <Icon name="fit" />
                                {t('nodes.pickFromCanvas')}
                              </Button>
                            ) : (
                              <Select
                                value={ref?.id ?? ''}
                                onValueChange={(id) => setSlot(slot, id)}
                              >
                                <SelectTrigger
                                  aria-label={t(
                                    slot === 'first' ? 'nodes.firstFrame' : 'nodes.lastFrame',
                                  )}
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
                            )}
                            <Button
                              variant="ghost"
                              className="creation-menu-item"
                              disabled={busy || uploads.uploading}
                              onClick={() => {
                                setFrameMenu(null)
                                uploadSlot.current = slot
                                uploadInput.current?.click()
                              }}
                            >
                              <Icon name="upload" />
                              {t('nodes.addUpload')}
                            </Button>
                          </PopoverContent>
                        </Popover>
                        <span className="text-xs text-muted-foreground">
                          {t(slot === 'first' ? 'nodes.firstFrame' : 'nodes.lastFrame')}
                        </span>
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
                    <Icon name="replace" />
                  </Button>
                )}
              </div>
            )}
          </div>
        }
      >
        {mode === 'reference' && !referenceTools && (
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
          className="creation-prompt w-full resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
      </CreationBody>
      <CreationToolbar
        mode={
          option ? (
            <Select value={mode} onValueChange={(next) => onMeta({ nodeVideoMode: next })}>
              <Hint tooltip={`${t('nodes.videoMode')}：${modeLabels[mode]}`}>
                <SelectTrigger className="creation-mode-trigger" aria-label={t('nodes.videoMode')}>
                  <SelectValue>
                    <span className="creation-mode-value">
                      <Icon name="video" />
                      <span className="creation-mode-full">{modeLabels[mode]}</span>
                      <span className="creation-mode-short">{modeLabels[mode]}</span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
              </Hint>
              <SelectContent>
                {nodeVideoModes(option.support).map((one) => (
                  <SelectItem key={one} value={one}>
                    {modeLabels[one]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
        action={
          <CreationSend
            aria-label={t('nodes.composerSend')}
            disabled={!canSend}
            busy={busy}
            onClick={send}
          />
        }
        status={
          <>
            {inputError && (
              <p role="status" className="text-muted-foreground">
                {inputError}
              </p>
            )}
            {guard.estimatedCredits !== undefined && (
              <span className="flex items-center gap-1 text-muted-foreground">
                {t('nodes.estimatedCost')} <Credits credits={guard.estimatedCredits} />
              </span>
            )}
          </>
        }
      >
        {option ? (
          <CanvasVideoParams
            hasFirstFrame={Boolean(inputs.first)}
            controlled={{ draft, onChange: changeDraft, support }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">{t('nodes.noVideoModel')}</span>
        )}
      </CreationToolbar>
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
            if (onReferenceUpload) {
              await onReferenceUpload(file, slot === 'reference' ? undefined : slot)
              return
            }
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
