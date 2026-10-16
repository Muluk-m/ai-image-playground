import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import type { NodeReference } from '../lib/nodeCanvasFlow'
import NodeComposerFrame from './NodeComposerFrame'

/** 文本卡下面的输入栏。只把这句话写进这张卡，不带图片的模型、画幅和张数。 */
export default function TextNodeComposer({
  references,
  files,
  value,
  onChange,
  onSubmit,
}: {
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  const { t } = useTranslation('canvas')
  const canSend = value.trim().length > 0
  return (
    <NodeComposerFrame label={t('nodes.composerText')} references={references} files={files}>
      <Textarea
        value={value}
        placeholder={t('nodes.composerText')}
        aria-label={t('nodes.composerText')}
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
      <div className="flex items-end justify-end gap-2">
        <Button
          type="button"
          size="icon"
          className="flex-shrink-0 rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          aria-label={t('nodes.composerWrite')}
          disabled={!canSend}
          onClick={onSubmit}
        >
          <Icon name="send" />
        </Button>
      </div>
    </NodeComposerFrame>
  )
}
