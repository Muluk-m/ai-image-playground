import { useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import type { CanvasEditor } from '../lib/editor'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import { sliceCanvasImage } from '../lib/nodeCanvasSlice'

export default function NodeSliceMenu({
  editor,
  canvas,
  nodeId,
  onCreated,
}: {
  editor: CanvasEditor
  canvas: NodeCanvasDocument
  nodeId: string
  onCreated: (ids: string[]) => void
}) {
  const { t } = useTranslation('canvas')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  async function slice(grid: 2 | 3) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setOpen(false)
    try {
      const ids = await sliceCanvasImage(editor, canvas, nodeId, grid)
      if (ids.length) onCreated(ids)
    } catch {
      useStore.getState().showToast(t('nodes.sliceFailed'), 'error')
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          title={t('nodes.slice')}
          aria-label={busy ? t('nodes.slicing') : t('nodes.slice')}
        >
          <Icon name="grid" size="md" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 space-y-1 p-2"
        side="bottom"
        align="center"
        collisionPadding={12}
      >
        <p className="px-2 py-1 text-xs text-muted-foreground">{t('nodes.sliceHint')}</p>
        {([2, 3] as const).map((grid) => (
          <Button
            key={grid}
            variant="ghost"
            className="w-full justify-start"
            onClick={() => void slice(grid)}
          >
            <Icon name="grid" size="sm" />
            {t('nodes.sliceGrid', { grid, count: grid * grid })}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
