import { Pause, Play, Trash2, X } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import Overlay from '../../../components/Overlay'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import type { TimelineClip, TimelineEl } from '../lib/canvasDoc'
import type { CanvasEditor } from '../lib/editor'
import { isTimelineSource, sourceSeconds, timelineWidth } from '../lib/timeline'
import {
  clipDuration,
  clipRange,
  locateTime,
  moveClip,
  removeClip,
  startOfClip,
  totalDuration,
  trimClip,
} from '../lib/timelineEdit'
import { useTimelineEditor } from '../timelineEditorStore'

/** 片段轨上一秒多宽（像素）。短片段也留够拖边缘的宽度。 */
const TRACK_PX_PER_SECOND = 28
const MIN_CARD_WIDTH = 72
/** 方向键一次移动播放头多少秒。 */
const STEP_SECONDS = 0.1
/** 离出点这么近就当作这一段播完了：timeupdate 大约 4 次 / 秒，等它正好越过出点会多播一截。 */
const END_EPSILON = 0.04

function clock(seconds: number): string {
  const whole = Math.max(0, seconds)
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, '0')}`
}

/** 画布里存的封面可能是云端媒体引用，要先换成可显示的地址。 */
function usePoster(source: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<string>()
  useEffect(() => {
    if (!source) return
    let cancelled = false
    void resolveMediaSource(source, 'preview')
      .then((url) => {
        if (!cancelled) setResolved(url)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [source])
  return source?.startsWith('data:') ? source : resolved
}

/** 画布挂载点：有正在编辑的时间线才渲染编辑器。 */
export default function TimelineEditorHost({ editor }: { editor: CanvasEditor }) {
  const openId = useTimelineEditor((state) => state.openId)
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const element = openId ? editor.getElement(openId) : undefined
  if (element?.type !== 'timeline') return null
  return <TimelineEditor key={element.id} editor={editor} timeline={element} />
}

/**
 * 全屏编辑一条时间线：上面预览，下面片段轨。改的是草稿，关闭时一次写回画布——
 * 整个编辑过程是一条撤销记录，⌘Z 一下回到打开前。
 */
function TimelineEditor({ editor, timeline }: { editor: CanvasEditor; timeline: TimelineEl }) {
  const { t } = useTranslation('canvas')
  const [clips, setClips] = useState<TimelineClip[]>(() => timeline.clips)
  const [selected, setSelected] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const [playIndex, setPlayIndex] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const pendingSeek = useRef<number | null>(null)

  const sourceOf = useCallback(
    (id: string) => sourceSeconds(editor.getElement(id)) ?? measured[id],
    [editor, measured],
  )
  const total = totalDuration(clips, sourceOf)

  // 旧视频没有生成记录，时长只能从播放地址的元数据里读，读到才能裁到真正的结尾。
  useEffect(() => {
    const unknown = clips
      .map((clip) => editor.getElement(clip.elementId))
      .filter(
        (el): el is Extract<typeof el, { type: 'image' }> =>
          isTimelineSource(el) && sourceSeconds(el) === undefined && !(el!.id in measured),
      )
    const probes = unknown.map((el) => {
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.crossOrigin = 'use-credentials'
      probe.onloadedmetadata = () => {
        if (Number.isFinite(probe.duration))
          setMeasured((current) => ({ ...current, [el.id]: probe.duration }))
      }
      probe.src = queueOutputUrl(el.video!.taskId, el.video!.outputIndex)
      return probe
    })
    return () => {
      for (const probe of probes) {
        probe.removeAttribute('src')
        probe.load()
      }
    }
  }, [clips, editor, measured])

  const urlOf = (index: number) => {
    const el = editor.getElement(clips[index]?.elementId ?? '')
    return el?.type === 'image' && el.video
      ? queueOutputUrl(el.video.taskId, el.video.outputIndex)
      : null
  }

  /** 把预览放到全局 t 秒：换段就换源，同一段直接 seek。 */
  const seek = (target: number) => {
    const clamped = Math.min(Math.max(0, target), total)
    setTime(clamped)
    if (clips.length === 0) return
    const { index, sourceTime } = locateTime(clips, sourceOf, clamped)
    const node = video.current
    const url = urlOf(index)
    setPlayIndex(index)
    if (!node || !url) return
    if (node.getAttribute('src') !== url) {
      pendingSeek.current = sourceTime
      node.src = url
      node.load()
    } else {
      node.currentTime = sourceTime
    }
  }

  const advance = (from: number) => {
    // 缺失的段在预览里跳过，播放头照样按它的时长往后走。
    for (let next = from + 1; next < clips.length; next += 1) {
      if (urlOf(next)) return seek(startOfClip(clips, sourceOf, next))
    }
    setPlaying(false)
    video.current?.pause()
    setTime(total)
  }

  const onTimeUpdate = () => {
    const node = video.current
    const clip = clips[playIndex]
    if (!node || !clip) return
    const range = clipRange(clip, sourceOf(clip.elementId))
    setTime(startOfClip(clips, sourceOf, playIndex) + Math.max(0, node.currentTime - range.in))
    if (node.currentTime >= range.out - END_EPSILON && playing) advance(playIndex)
  }

  const togglePlay = () => {
    const node = video.current
    if (!node) return
    if (playing) {
      node.pause()
      setPlaying(false)
      return
    }
    if (time >= total - END_EPSILON) seek(0)
    setPlaying(true)
    void node.play().catch(() => setPlaying(false))
  }

  const update = (next: TimelineClip[]) => {
    setClips(next)
    setSelected((current) => Math.min(current, Math.max(0, next.length - 1)))
    // 排序、裁剪都会挪动全局时间轴，播放头回到被改的那段开头最不迷路。
    setPlaying(false)
    video.current?.pause()
  }

  const close = () => {
    const changed = JSON.stringify(clips) !== JSON.stringify(timeline.clips)
    if (changed && editor.getElement(timeline.id))
      editor.doc.updateElements(
        [
          {
            id: timeline.id,
            patch: { clips, width: timelineWidth(clips, (id) => editor.getElement(id)) },
          },
        ],
        { history: true },
      )
    useTimelineEditor.getState().close()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return
    if (event.key === ' ') {
      event.preventDefault()
      togglePlay()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      seek(time + (event.key === 'ArrowLeft' ? -STEP_SECONDS : STEP_SECONDS))
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && clips[selected]) {
      event.preventDefault()
      update(removeClip(clips, selected))
    }
  }

  const missingNow = clips.length > 0 && !urlOf(playIndex)

  return (
    <Overlay onClose={close} tier="raised" layout="fill" backdrop="none">
      <div
        className="flex h-full w-full flex-col bg-background text-foreground outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={t('timeline.editorTitle')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        ref={(node) => node?.focus()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-medium">
            {t('timeline.editorTitle')} · {clips.length} · {clock(total)}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={close}
            aria-label={t('timeline.done')}
          >
            <X />
            {t('timeline.done')}
          </Button>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
          <video
            ref={video}
            className="max-h-full max-w-full"
            playsInline
            crossOrigin="use-credentials"
            onLoadedMetadata={() => {
              const node = video.current
              if (node && pendingSeek.current !== null) {
                node.currentTime = pendingSeek.current
                pendingSeek.current = null
                if (playing) void node.play().catch(() => setPlaying(false))
              }
            }}
            onTimeUpdate={onTimeUpdate}
            onEnded={() => playing && advance(playIndex)}
          >
            <track kind="captions" />
          </video>
          {missingNow && (
            <p className="absolute text-sm text-muted-foreground">{t('timeline.missing')}</p>
          )}
          {clips.length === 0 && (
            <p className="absolute text-sm text-muted-foreground">{t('timeline.empty')}</p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-4 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={togglePlay}
            disabled={clips.length === 0}
            aria-label={playing ? t('timeline.pause') : t('timeline.play')}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <span className="w-24 text-xs tabular-nums text-muted-foreground">
            {clock(time)} / {clock(total)}
          </span>
          <input
            type="range"
            className="flex-1"
            min={0}
            max={Math.max(total, 0.1)}
            step={0.1}
            value={time}
            aria-label={t('timeline.playhead')}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </div>

        <ClipTrack
          editor={editor}
          clips={clips}
          sourceOf={sourceOf}
          selected={selected}
          onSelect={(index) => {
            setSelected(index)
            seek(startOfClip(clips, sourceOf, index))
          }}
          onChange={update}
        />
      </div>
    </Overlay>
  )
}

function ClipTrack({
  editor,
  clips,
  sourceOf,
  selected,
  onSelect,
  onChange,
}: {
  editor: CanvasEditor
  clips: TimelineClip[]
  sourceOf: (id: string) => number | undefined
  selected: number
  onSelect: (index: number) => void
  onChange: (clips: TimelineClip[]) => void
}) {
  const { t } = useTranslation('canvas')
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  return (
    <ol
      className="flex gap-2 overflow-x-auto border-t border-border bg-muted/40 p-3"
      aria-label={t('timeline.track')}
    >
      {clips.map((clip, index) => (
        <ClipCard
          // 同一段视频可以在时间线上出现多次，下标才是这一张卡的身份。
          key={`${index}-${clip.elementId}`}
          editor={editor}
          clip={clip}
          index={index}
          source={sourceOf(clip.elementId)}
          selected={selected === index}
          dragging={dragFrom === index}
          onSelect={() => onSelect(index)}
          onDragStart={() => setDragFrom(index)}
          onDrop={() => {
            if (dragFrom !== null) onChange(moveClip(clips, dragFrom, index))
            setDragFrom(null)
          }}
          onTrim={(edge, seconds) => {
            const next = [...clips]
            next[index] = trimClip(clip, edge, seconds, sourceOf(clip.elementId))
            onChange(next)
          }}
          onRemove={() => onChange(removeClip(clips, index))}
        />
      ))}
    </ol>
  )
}

function ClipCard({
  editor,
  clip,
  index,
  source,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDrop,
  onTrim,
  onRemove,
}: {
  editor: CanvasEditor
  clip: TimelineClip
  index: number
  source: number | undefined
  selected: boolean
  dragging: boolean
  onSelect: () => void
  onDragStart: () => void
  onDrop: () => void
  onTrim: (edge: 'in' | 'out', seconds: number) => void
  onRemove: () => void
}) {
  const { t } = useTranslation('canvas')
  const element = editor.getElement(clip.elementId)
  const missing = !isTimelineSource(element)
  const poster = usePoster(element?.type === 'image' ? editor.doc.files[element.fileId] : undefined)
  const range = clipRange(clip, source)
  const duration = clipDuration(clip, source)
  const width = Math.max(MIN_CARD_WIDTH, duration * TRACK_PX_PER_SECOND)

  // 拖边缘裁剪：按拖动的像素折算秒数，松手前每次移动都写一次草稿，预览跟手。
  const startTrim = (edge: 'in' | 'out') => (event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const origin = edge === 'in' ? range.in : range.out
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) =>
      onTrim(edge, origin + (moveEvent.clientX - startX) / TRACK_PX_PER_SECOND)
    const up = () => {
      target.removeEventListener('pointermove', move as EventListener)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move as EventListener)
    target.addEventListener('pointerup', up)
  }

  return (
    <li
      className={`relative shrink-0 overflow-hidden rounded-md border ${
        selected ? 'border-primary ring-2 ring-primary/40' : 'border-border'
      } ${dragging ? 'opacity-50' : ''}`}
      style={{ width }}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="block h-20 w-full bg-black text-left"
        onClick={onSelect}
        aria-label={t('timeline.clipLabel', { index: index + 1, seconds: duration.toFixed(1) })}
        aria-pressed={selected}
      >
        {poster && !missing ? (
          <img src={poster} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {missing ? t('timeline.missing') : ''}
          </span>
        )}
      </button>
      <div className="flex items-center justify-between gap-1 px-1 py-0.5 text-[11px] tabular-nums">
        <span>{clock(duration)}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1"
          aria-label={t('timeline.removeClip', { index: index + 1 })}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      {!missing && (
        <>
          <span
            role="slider"
            tabIndex={0}
            aria-label={t('timeline.trimIn', { index: index + 1 })}
            aria-valuemin={0}
            aria-valuemax={range.out}
            aria-valuenow={range.in}
            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-primary/70"
            onPointerDown={startTrim('in')}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              event.stopPropagation()
              onTrim('in', range.in + (event.key === 'ArrowLeft' ? -STEP_SECONDS : STEP_SECONDS))
            }}
          />
          <span
            role="slider"
            tabIndex={0}
            aria-label={t('timeline.trimOut', { index: index + 1 })}
            aria-valuemin={range.in}
            aria-valuemax={source ?? range.out}
            aria-valuenow={range.out}
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-primary/70"
            onPointerDown={startTrim('out')}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              event.stopPropagation()
              onTrim('out', range.out + (event.key === 'ArrowLeft' ? -STEP_SECONDS : STEP_SECONDS))
            }}
          />
        </>
      )}
    </li>
  )
}
