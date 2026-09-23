import { Check, Download, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Checkbox } from '../../../components/Checkbox'
import { VideoIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import type { CanvasDoc, ImageEl } from '../../canvas/lib/canvasDoc'
import { exportCanvasSelection } from '../../canvas/lib/exportImages'
import { canvasImageName } from '../../canvas/lib/imageInfo'
import { projectDisplayName } from '../../canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../canvas/projectStore'

/**
 * 弹窗里的图按原生比例铺到三四百像素宽，而侧栏那份缩略图是 0.25 倍栅格化的，放这么大就是一团糊。
 * 所以这里读画布的位图单源：本地位图就是它自己，云端媒体取 `preview` 变体
 * （`resolveMediaSource` 自带会话热表 + 本机缓存 + 并发限流，反复开弹窗不会反复回源）。
 * 表里没有这个键 = 还在取，值为 `null` = 取不到。
 */
function useWorkPreviews(
  doc: CanvasDoc,
  works: readonly ImageEl[],
): ReadonlyMap<string, string | null> {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string | null>>(new Map())
  // works 每次渲染都是新数组，用「对象 + 位图」的身份当依赖。
  const signature = works.map(previewKey).join(' ')
  const files = doc.files

  useEffect(() => {
    let alive = true
    void (async () => {
      for (const work of works) {
        const key = previewKey(work)
        if (previews.has(key)) continue
        const source = files[work.fileId]
        const resolved = source
          ? await resolveMediaSource(source, 'preview').catch(() => null)
          : null
        if (!alive) return
        setPreviews((prev) => new Map(prev).set(key, resolved))
      }
    })()
    return () => {
      alive = false
    }
  }, [signature, files])

  return previews
}

function previewKey(work: ImageEl): string {
  return `${work.id}:${work.fileId}`
}

/**
 * 「全部产物」弹窗：把创作记录里分散在各任务下的图片与视频铺成一张网格，
 * 支持勾选若干件后一次导出（多件打成一个 zip，由 exportCanvasSelection 统一处理）。
 * 打开时默认全选——来这儿的人多半就是要把这块画布的产物整批拿走。
 */
export default function AgentCreationsGallery({
  doc,
  works,
  onClose,
}: {
  doc: CanvasDoc
  works: readonly ImageEl[]
  onClose: () => void
}) {
  const { t } = useTranslation(['agent', 'common'])
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(works.map((work) => work.id)),
  )
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const previews = useWorkPreviews(doc, works)

  const live = works.filter((work) => selected.has(work.id))
  const allSelected = live.length === works.length && works.length > 0

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runExport = async () => {
    if (progress || live.length === 0) return
    setProgress({ done: 0, total: live.length })
    try {
      await exportCanvasSelection(
        doc,
        live.map((work) => work.id),
        {
          onProgress: (done, total) => setProgress({ done, total }),
          baseName: project ? projectDisplayName(project.name) : undefined,
        },
      )
    } finally {
      setProgress(null)
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('creations.galleryTitle')}
        className="flex max-h-[84vh] w-[min(920px,94vw)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">{t('creations.galleryTitle')}</h2>
          <span className="text-[11px] text-muted-foreground">
            {t('creations.itemCount', { count: works.length })}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:action.close')}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {works.length === 0 ? (
          <p className="px-5 py-12 text-center text-xs text-muted-foreground">
            {t('creations.galleryEmpty')}
          </p>
        ) : (
          // 瀑布流：产物比例各不相同，等比铺开才能看清自己在选哪张；
          // 方格 + object-cover 会把竖图裁成一条，人物直接被切掉头。
          <div className="columns-2 flex-1 gap-3 overflow-y-auto p-4 sm:columns-3 lg:columns-4">
            {works.map((work) => {
              const src = previews.get(previewKey(work))
              const name = canvasImageName(work)
              const isSelected = selected.has(work.id)
              return (
                <button
                  key={work.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggle(work.id)}
                  title={name}
                  className={`group relative mb-3 block w-full break-inside-avoid overflow-hidden rounded-xl border text-left transition ${isSelected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/60'} bg-background`}
                >
                  {src ? (
                    <img src={src} alt="" loading="lazy" className="block h-auto w-full" />
                  ) : (
                    // 取图期间按画布上的比例占位，图到了不会把整列推一下。
                    <div
                      style={{ aspectRatio: `${work.width} / ${work.height}` }}
                      className="grid min-h-16 w-full place-items-center bg-muted px-2 text-center text-[11px] text-muted-foreground"
                    >
                      {src === null ? t('creations.previewUnavailable') : '…'}
                    </div>
                  )}
                  {work.video && (
                    <VideoIcon
                      className="absolute left-2 top-2 h-5 w-5 rounded bg-black/60 p-0.5 text-white"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    aria-hidden="true"
                    className={`absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full border ${isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background/80 text-transparent'}`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="block truncate px-2 py-1.5 text-[11px] text-foreground">
                    {name}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <footer className="flex items-center gap-3 border-t border-border px-4 py-3">
          <Checkbox
            checked={allSelected}
            onChange={(checked) =>
              setSelected(checked ? new Set(works.map((work) => work.id)) : new Set())
            }
            label={t('creations.selectAll')}
          />
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t('creations.selectedCount', { count: live.length })}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void runExport()}
            disabled={live.length === 0 || progress !== null}
            className="flex h-9 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            {progress
              ? t('creations.exporting', { done: progress.done, total: progress.total })
              : t('creations.exportSelected', { count: live.length })}
          </button>
        </footer>
      </div>
    </Overlay>
  )
}
