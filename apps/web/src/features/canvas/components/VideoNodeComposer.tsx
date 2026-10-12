import type { ReactNode } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import CanvasVideoParams from './CanvasVideoParams'
import NodeComposerFrame from './NodeComposerFrame'

export default function VideoNodeComposer({
  value,
  onChange,
  onSubmit,
  busy,
  position,
  referenceTools,
  hasFirstFrame,
}: {
  value: string
  onChange: (text: string) => void
  onSubmit: () => void
  busy: boolean
  position: { left: number; top: number }
  referenceTools: ReactNode
  hasFirstFrame: boolean
}) {
  const { t } = useTranslation('canvas')
  const available = videoModelOptions().length > 0
  return (
    <NodeComposerFrame
      label={t('nodes.composerVideo')}
      position={position}
      references={[]}
      files={{}}
    >
      {referenceTools}
      <Textarea
        aria-label={t('nodes.composerVideo')}
        placeholder={t('nodes.composerVideo')}
        className="min-h-20 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && available) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-wrap gap-2">
          {available ? (
            <CanvasVideoParams hasFirstFrame={hasFirstFrame} size="sm" />
          ) : (
            <span className="text-xs text-muted-foreground">{t('nodes.noVideoModel')}</span>
          )}
        </div>
        <Button
          size="icon"
          className="rounded-full"
          aria-label={t('nodes.composerSend')}
          disabled={busy || !available}
          onClick={onSubmit}
        >
          <Icon name={busy ? 'loading' : 'generate'} />
        </Button>
      </div>
    </NodeComposerFrame>
  )
}
