import type { ChangeEvent, ReactNode } from 'react'
import { useRef } from 'react'
import Credits from '../../../components/Credits'
import ParamControls from '../../../components/ParamControls'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { type NodeReference, referenceFileIds } from '../lib/nodeCanvasFlow'
import { useNodeReferenceDraft } from '../lib/useNodeReferenceDraft'
import NodeComposerFrame from './NodeComposerFrame'
import NodeMediaImage from './NodeMediaImage'

/** 图片卡下面的生成栏：模型、画幅、张数跟工作台是同一组 ParamControls。 */
export default function ImageNodeComposer({
  referenceTools,
  resultTools,
  document,
  nodeId,
  references,
  files,
  value,
  busy,
  position,
  onChange,
  onSubmit,
}: {
  resultTools?: ReactNode
  referenceTools?: ReactNode
  document: object
  nodeId: string
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  value: string
  busy: boolean
  position: { left: number; top: number }
  onChange: (value: string) => void
  onSubmit: (temporaryReferences: string[]) => void
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
  const hasContext = references.some((ref) => ref.text || ref.fileId) || temporary.length > 0
  const canSend = !busy && !uploading && (value.trim().length > 0 || hasContext)
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
      await uploadReference(file)
    } catch {
      useStore.getState().showToast(t('import.failed'), 'error')
    }
  }
  return (
    <NodeComposerFrame
      label={t('nodes.composerImage')}
      position={position}
      references={referenceTools ? [] : references}
      files={files}
    >
      {resultTools}
      {referenceTools}
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
      <Textarea
        value={value}
        placeholder={t('nodes.composerImage')}
        aria-label={t('nodes.composerImage')}
        rows={3}
        className="max-h-40 min-h-[4.5rem] w-full resize-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={busy || uploading}
            aria-label={t('nodes.addUpload')}
            onClick={() => uploadInput.current?.click()}
          >
            <Icon name="imageAdd" />
          </Button>
          <ParamControls showCount size="sm" />
        </div>
        <Button
          type="button"
          size="icon"
          className="flex-shrink-0 rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          aria-label={t('nodes.composerSend')}
          disabled={!canSend}
          onClick={submit}
        >
          <Icon name="generate" />
        </Button>
      </div>
      {profile.source === 'builtin-edge' && guard.estimatedCredits !== undefined && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          {t('nodes.estimatedCost')} <Credits credits={guard.estimatedCredits} />
        </div>
      )}
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
