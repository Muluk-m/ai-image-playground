import type { ChangeEvent, ReactNode } from 'react'
import { useMemo, useRef } from 'react'
import Credits from '../../../components/Credits'
import {
  CreationBody,
  CreationSend,
  CreationToolbar,
} from '../../../components/creation/CreationFrame'
import LookChips, { LookCapsule } from '../../../components/LookChips'
import ParamControls from '../../../components/ParamControls'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { applyLookToComposer, useActiveLook } from '../../library/lib/activeLook'
import { checkLookSubmission } from '../../library/lib/lookSubmit'
import { useLibraryStore } from '../../library/store'
import type { AssetRecord } from '../../library/types'
import { type NodeReference, referenceFileIds } from '../lib/nodeCanvasFlow'
import { useNodeReferenceDraft } from '../lib/useNodeReferenceDraft'
import NodeComposerFrame from './NodeComposerFrame'
import NodeMediaImage from './NodeMediaImage'
import NodePromptInput from './NodePromptInput'

/** 图片卡下面的生成栏：模型、画幅、张数跟工作台是同一组 ParamControls。 */
export default function ImageNodeComposer({
  referenceTools,
  onReferenceUpload,
  resultTools,
  document,
  nodeId,
  references,
  files,
  onAsset,
  value,
  busy,
  onChange,
  onSubmit,
  templates = false,
}: {
  resultTools?: ReactNode
  referenceTools?: ReactNode
  onReferenceUpload?: (file: File, slot?: 'first' | 'last') => Promise<void>
  document: object
  nodeId: string
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  onAsset?: (asset: AssetRecord, prompt: string) => Promise<boolean>
  value: string
  busy: boolean
  onChange: (value: string) => void
  onSubmit: (temporaryReferences: string[]) => void
  templates?: boolean
}) {
  const { t } = useTranslation('canvas')
  const uploadInput = useRef<HTMLInputElement>(null)
  const {
    items: temporary,
    uploading,
    upload: uploadReference,
    remove,
  } = useNodeReferenceDraft(document, nodeId)
  const readyImageIds = referenceFileIds(references, files)
  const settings = useStore((state) => state.settings)
  const count = useStore((state) => state.params.n)
  const profile = getActiveApiProfile(settings)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(profile).model,
    quantity: Math.max(1, count),
  })
  const activeLook = useActiveLook((state) => (templates ? state.look : null))
  const libraryAssets = useLibraryStore((state) => state.assets)
  const lookImages = useMemo(
    () => references.flatMap((reference) => (reference.fileId ? [{ id: reference.fileId }] : [])),
    [references],
  )
  const lookCheck = useMemo(
    () => (activeLook ? checkLookSubmission(activeLook, lookImages, libraryAssets) : null),
    [activeLook, lookImages, libraryAssets],
  )
  const hasContext = references.some((ref) => ref.text || ref.fileId) || temporary.length > 0
  const canSend =
    !busy &&
    !uploading &&
    (lookCheck?.ok ?? true) &&
    (value.trim().length > 0 || hasContext || Boolean(activeLook))
  const submit = () => {
    if (canSend) onSubmit(temporary.map((item) => item.url))
  }
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !file.type.startsWith('image/') || uploading) return
    if (temporary.length + readyImageIds.length >= API_MAX_IMAGES) {
      useStore.getState().showToast(t('submit.tooManyInputs', { max: API_MAX_IMAGES }), 'error')
      return
    }
    try {
      if (onReferenceUpload) await onReferenceUpload(file)
      else await uploadReference(file)
    } catch {
      useStore.getState().showToast(t('import.failed'), 'error')
    }
  }
  return (
    <NodeComposerFrame
      standard
      tools={resultTools}
      label={t('nodes.composerImage')}
      references={referenceTools ? [] : references}
      files={files}
    >
      <CreationBody references={referenceTools}>
        {temporary.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label={t('nodes.temporaryReferences')}>
            {temporary.map((item, index) => (
              <div
                key={item.id}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-muted p-1"
              >
                <NodeMediaImage
                  src={item.url}
                  alt={item.name}
                  className="h-8 w-8 rounded-sm object-cover"
                />
                <span className="max-w-24 truncate text-xs">
                  {readyImageIds.length + index + 1}. {item.name}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('nodes.removeReference')}
                  disabled={busy}
                  onClick={() => remove(item.id)}
                >
                  <Icon name="close" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {templates && activeLook && (
          <LookCapsule
            look={activeLook}
            issue={
              lookCheck && !lookCheck.ok
                ? { reason: 'slot_mismatch', expected: lookCheck.expected }
                : null
            }
            onRemove={() => useActiveLook.getState().set(null)}
          />
        )}
        <NodePromptInput
          value={value}
          onChange={onChange}
          onSubmit={submit}
          onAsset={onAsset}
          label={t('nodes.composerImage')}
          className="creation-prompt w-full resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
      </CreationBody>
      <CreationToolbar
        action={
          <CreationSend
            aria-label={t('nodes.composerSend')}
            disabled={!canSend}
            busy={busy}
            onClick={submit}
          />
        }
        status={
          profile.source === 'builtin-edge' && guard.estimatedCredits !== undefined ? (
            <span className="flex items-center gap-1 text-muted-foreground" aria-live="polite">
              {t('nodes.estimatedCost')} <Credits credits={guard.estimatedCredits} />
            </span>
          ) : undefined
        }
      >
        {!referenceTools && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy || uploading}
            aria-label={t('nodes.addUpload')}
            onClick={() => uploadInput.current?.click()}
          >
            <Icon name="imageAdd" />
          </Button>
        )}
        <ParamControls showCount />
      </CreationToolbar>
      {templates && <LookChips onPick={applyLookToComposer} />}
      <input
        ref={uploadInput}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={upload}
      />
    </NodeComposerFrame>
  )
}
