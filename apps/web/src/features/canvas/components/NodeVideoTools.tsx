import { type CanvasNode } from '@image-playground/shared'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { useStore } from '../../../store'
import type { CanvasEditor } from '../lib/editor'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import { extractNodeVideoFrame, trimNodeVideo } from '../lib/nodeVideoTools'

export const NodeVideoPlayheadContext = createContext<Map<string, number>>(new Map())
export default function NodeVideoTools({
  editor,
  canvas,
  node,
  onCreated,
}: {
  editor: CanvasEditor
  canvas: NodeCanvasDocument
  node: Extract<CanvasNode, { type: 'video' }>
  onCreated: (ids: string[]) => void
}) {
  const { t } = useTranslation('canvas')
  const { t: common } = useTranslation('common')
  const playheads = useContext(NodeVideoPlayheadContext)
  const [open, setOpen] = useState(false)
  const [trimming, setTrimming] = useState(false)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [duration, setDuration] = useState(0)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const preview = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = preview.current
    return () => {
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [trimming])
  const valid =
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end <= duration &&
    end - start >= 0.1
  async function capture(which: 'first' | 'last' | 'current') {
    if (running.current) return
    running.current = true
    setBusy(true)
    setOpen(false)
    try {
      const id = await extractNodeVideoFrame(
        editor,
        canvas,
        node.id,
        which,
        playheads.get(node.id) ?? 0,
      )
      if (id) onCreated([id])
    } catch {
      useStore.getState().showToast(t('videoToolbar.frameFailed'), 'error')
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  const frameLabels = {
    current: t('nodes.framecurrent'),
    first: t('nodes.framefirst'),
    last: t('nodes.framelast'),
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={t('nodes.videoTools')}
            title={t('nodes.videoTools')}
          >
            <Icon name="video" size="md" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 space-y-1 p-2" collisionPadding={12}>
          {(['current', 'first', 'last'] as const).map((which) => (
            <Button
              key={which}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => void capture(which)}
            >
              {frameLabels[which]}
            </Button>
          ))}
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              setOpen(false)
              setDuration(0)
              setTrimming(true)
            }}
          >
            {t('nodes.trimVideo')}
          </Button>
        </PopoverContent>
      </Popover>
      {trimming && (
        <Overlay label={t('nodes.trimVideo')} onClose={() => setTrimming(false)}>
          <div className="w-full max-w-xl space-y-4 rounded-xl border bg-card p-4 shadow-lg">
            <h2 className="text-base font-semibold">{t('nodes.trimVideo')}</h2>
            <video
              ref={preview}
              className="max-h-[45vh] w-full rounded-lg bg-black"
              controls
              playsInline
              crossOrigin="use-credentials"
              src={queueOutputUrl(node.data.video.taskId, node.data.video.outputIndex)}
              onLoadedMetadata={(event) => {
                const seconds = event.currentTarget.duration
                if (!Number.isFinite(seconds)) return
                setDuration(seconds)
                const first = Number(node.data.meta?.videoTrimIn ?? 0)
                const last = Number(node.data.meta?.videoTrimOut ?? seconds)
                setStart(Number.isFinite(first) && first >= 0 && first < seconds ? first : 0)
                setEnd(Number.isFinite(last) && last > 0 ? Math.min(last, seconds) : seconds)
              }}
              onTimeUpdate={(event) => {
                if (valid && event.currentTarget.currentTime >= end) event.currentTarget.pause()
              }}
            >
              <track kind="captions" />
            </video>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-sm">
                {t('nodes.trimStart')}
                <Input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={Number.isFinite(start) ? start : ''}
                  onChange={(e) => setStart(e.target.valueAsNumber)}
                />
              </label>
              <label className="space-y-1 text-sm">
                {t('nodes.trimEnd')}
                <Input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={Number.isFinite(end) ? end : ''}
                  onChange={(e) => setEnd(e.target.valueAsNumber)}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{t('nodes.trimHint')}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={!valid}
                onClick={() => {
                  if (preview.current) {
                    preview.current.currentTime = start
                    void preview.current.play().catch(() => {})
                  }
                }}
              >
                {t('videoOverlay.play')}
              </Button>
              <Button variant="ghost" onClick={() => setTrimming(false)}>
                {common('action.cancel')}
              </Button>
              <Button
                disabled={!valid}
                onClick={() => {
                  if (trimNodeVideo(canvas, node.id, start, end, duration)) setTrimming(false)
                }}
              >
                {common('action.save')}
              </Button>
            </div>
          </div>
        </Overlay>
      )}
    </>
  )
}
