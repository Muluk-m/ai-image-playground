import type { ChangeEvent } from 'react'
import { useRef } from 'react'
import ParamControls from '../../../components/ParamControls'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import type { NodeReference } from '../lib/nodeCanvasFlow'
import NodeComposerFrame from './NodeComposerFrame'

/** 图片卡下面的生成栏：模型、画幅、张数跟工作台是同一组 ParamControls。 */
export default function ImageNodeComposer({
  references,
  files,
  value,
  busy,
  position,
  onChange,
  onSubmit,
  onUploadFile,
}: {
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  value: string
  busy: boolean
  position: { left: number; top: number }
  onChange: (value: string) => void
  onSubmit: () => void
  onUploadFile: (file: File) => void
}) {
  const { t } = useTranslation('canvas')
  const uploadInput = useRef<HTMLInputElement>(null)
  const hasContext = references.some((ref) => ref.text || ref.fileId)
  const canSend = !busy && (value.trim().length > 0 || hasContext)
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onUploadFile(file)
  }
  return (
    <NodeComposerFrame
      label={t('nodes.composerImage')}
      position={position}
      references={references}
      files={files}
    >
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
            if (canSend) onSubmit()
          }
        }}
      />
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={busy}
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
          onClick={onSubmit}
        >
          <Icon name="generate" />
        </Button>
      </div>
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
