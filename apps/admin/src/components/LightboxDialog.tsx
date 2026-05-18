import { useNavigate } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTask } from '@/lib/queries'
import { countInputImages, inputImageMaxIdx } from '@/lib/request-helpers'

interface LightboxDialogProps {
  taskId: string | undefined
  imgIdx: number | undefined
  imgKind: 'output' | 'input' | undefined
  fullscreen: '1' | undefined
}

export function LightboxDialog({ taskId, imgIdx, imgKind, fullscreen }: LightboxDialogProps) {
  // 通过 useTask 拿 max index（自带 Query 去重，跟 Sheet 共享同一 ['task', id]
  // 缓存，不发额外请求）
  const q = useTask(taskId)
  const maxIdx = computeMaxIdx(imgKind, q.data)
  const navigate = useNavigate()
  const open = fullscreen === '1' && !!taskId && imgKind !== undefined && imgIdx !== undefined

  const close = useCallback((): void => {
    void navigate({
      to: '.',
      search: (prev) => {
        const { fullscreen: _fs, imgIdx: _i, imgKind: _k, ...rest } = prev ?? {}
        return rest
      },
    })
  }, [navigate])

  const step = useCallback(
    (delta: number): void => {
      if (imgIdx === undefined) return
      const next = imgIdx + delta
      if (next === imgIdx) return
      if (next < 0) return
      if (typeof maxIdx === 'number' && next > maxIdx) return
      void navigate({
        to: '.',
        search: (prev) => ({ ...(prev ?? {}), imgIdx: next }),
      })
    },
    [imgIdx, maxIdx, navigate],
  )

  // 左右箭头键翻页
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step])

  if (!open || imgIdx === undefined || imgKind === undefined || !taskId) return null

  const path = imgKind === 'output' ? 'image' : 'input-image'
  const src = `/api/tasks/${encodeURIComponent(taskId)}/${path}?idx=${imgIdx}`

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? close() : null)}>
      <DialogContent
        className="flex h-[90vh] w-[95vw] max-w-none flex-col gap-2 bg-background/95 p-4 sm:rounded-lg"
        hideCloseButton
      >
        <DialogTitle className="sr-only">
          {imgKind === 'output' ? '输出图' : '参考图'} #{imgIdx + 1}
        </DialogTitle>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {imgKind === 'output' ? '输出图' : '参考图'} #{imgIdx + 1}
            {typeof maxIdx === 'number' ? <> / {maxIdx + 1}</> : null}
          </span>
          <Button variant="ghost" size="sm" onClick={close}>
            关闭 (Esc)
          </Button>
        </div>
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <Button
            variant="ghost"
            size="icon"
            disabled={imgIdx <= 0}
            onClick={() => step(-1)}
            aria-label="上一张"
            className="absolute left-2 z-10"
          >
            <ChevronLeft />
          </Button>
          <img
            src={src}
            alt={`${imgKind} ${imgIdx + 1}`}
            className="max-h-full max-w-full object-contain"
          />
          <Button
            variant="ghost"
            size="icon"
            disabled={typeof maxIdx === 'number' && imgIdx >= maxIdx}
            onClick={() => step(1)}
            aria-label="下一张"
            className="absolute right-2 z-10"
          >
            <ChevronRight />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function computeMaxIdx(
  imgKind: 'output' | 'input' | undefined,
  data:
    | { result_meta: { images: unknown[] }; provider: string; request_payload: unknown }
    | undefined,
): number | undefined {
  if (!data) return undefined
  if (imgKind === 'output') {
    const n = data.result_meta.images.length
    return n > 0 ? n - 1 : undefined
  }
  if (imgKind === 'input') {
    return inputImageMaxIdx(countInputImages(data.provider, data.request_payload))
  }
  return undefined
}
