import type { CanvasNode } from '@image-playground/shared'
import { type ChangeEvent, useRef } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import type { NodeReference } from '../lib/nodeCanvasFlow'

/** 贴在选中节点下面的输入框：这句话只生成这一张卡。 */
export default function NodeComposer({
  node,
  references,
  files,
  value,
  busy,
  position,
  onChange,
  onSubmit,
  onUploadFile,
}: {
  node: CanvasNode
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
  const image = node.type === 'image'
  const hasContext = references.some((ref) => ref.text || ref.fileId)
  const canSend = !busy && (image ? value.trim().length > 0 || hasContext : value.trim().length > 0)
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onUploadFile(file)
  }
  return (
    <div
      className="studio-node-composer nodrag nopan nowheel"
      style={{ left: position.left, top: position.top }}
      role="group"
      aria-label={image ? t('nodes.composerImage') : t('nodes.composerText')}
    >
      {references.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" aria-label={t('nodes.contextLabel')}>
          {references.map((ref) => {
            const source = ref.fileId ? files[ref.fileId] : undefined
            const label = ref.label || t(ref.kind === 'text' ? 'nodes.addText' : 'nodes.addImage')
            return (
              <span
                key={ref.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-1.5 py-1 text-xs"
              >
                {source ? (
                  <img src={source} alt="" className="h-6 w-6 rounded-sm object-cover" />
                ) : (
                  <Icon
                    name={ref.kind === 'text' ? 'text' : ref.kind === 'video' ? 'video' : 'image'}
                    size="xs"
                  />
                )}
                <span className="max-w-40 truncate">{label}</span>
              </span>
            )
          })}
        </div>
      )}
      <Textarea
        value={value}
        placeholder={image ? t('nodes.composerImage') : t('nodes.composerText')}
        className="min-h-24 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (canSend) onSubmit()
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        {image ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => uploadInput.current?.click()}
          >
            <Icon name="upload" size="xs" />
            {t('nodes.addUpload')}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          size="icon"
          className="rounded-full"
          aria-label={image ? t('nodes.composerSend') : t('nodes.composerWrite')}
          disabled={!canSend}
          onClick={onSubmit}
        >
          <Icon name="send" size="sm" />
        </Button>
      </div>
      {image && (
        <input
          ref={uploadInput}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          onChange={upload}
        />
      )}
    </div>
  )
}
