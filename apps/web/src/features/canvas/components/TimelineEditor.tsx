import { Pause, Play, Trash2, X } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
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
import { useStore } from '../../../store'
import type { TimelineClip, TimelineEl } from '../lib/canvasDoc'
import type { CanvasEditor } from '../lib/editor'
import { isTimelineSource, sourceSeconds, timelineWidth } from '../lib/timeline'
import {
  clipDuration,
  clipRange,
  followSelection,
  locateTime,
  MIN_CLIP_SECONDS,
  moveClip,
  removeClip,
  sameClips,
  startOfClip,
  totalDuration,
  trimClip,
} from '../lib/timelineEdit'
import { useTimelineEditor } from '../timelineEditorStore'

/** 片段轨上一秒多宽（像素）。短片段也留够拖边缘的宽度。 */
const TRACK_PX_PER_SECOND = 28
const MIN_CARD_WIDTH = 72
/** 方向键一次移动播放头 / 出入点多少秒。 */
const STEP_SECONDS = 0.1
/** 离出点这么近就换下一段。按帧检查，一帧（~33ms）以内。 */
const END_EPSILON = 0.03

function clock(seconds: number): string {
  const whole = Math.max(0, seconds)
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, '0')}`
}

/** 画布里存的封面可能是云端媒体引用，要先换成可显示的地址。 */
function usePoster(source: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<string>()
  useEffect(() => {
    if (!source || source.startsWith('data:')) return
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

/** 画布挂载点：有正在编辑的时间线才渲染编辑器；时间线没了（被删、换了项目）就收起。 */
export default function TimelineEditorHost({ editor }: { editor: CanvasEditor }) {
  const openId = useTimelineEditor((state) => state.openId)
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const element = openId ? editor.getElement(openId) : undefined
  const gone = openId !== null && element?.type !== 'timeline'
  useEffect(() => {
    // 不收起的话 openId 留在全局，撤销恢复这条时间线或切回项目时编辑器会自己弹出来。
    if (gone) useTimelineEditor.getState().close()
  }, [gone])
  if (element?.type !== 'timeline') return null
  return <TimelineEditor key={element.id} editor={editor} timeline={element} />
}

/**
 * 全屏编辑一条时间线：上面预览，下面片段轨。改的是草稿，关闭时一次写回画布——
 * 整个编辑过程是一条撤销记录，⌘Z 一下回到打开前。
 */
function TimelineEditor({ editor, timeline }: { editor: CanvasEditor; timeline: TimelineEl }) {
  const { t } = useTranslation('canvas')
  const [baseline] = useState(timeline.clips)
  const [clips, setClips] = useState<TimelineClip[]>(timeline.clips)
  const [selected, setSelected] = useState<number | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playIndex, setPlayIndex] = useState(0)
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const video = useRef<HTMLVideoElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const pendingSeek = useRef<number | null>(null)
  // 播放循环与媒体事件回调里读这几份 ref，不读闭包：状态在两次渲染之间就会变。
  const live = useRef({ clips, playing, playIndex })
  live.current = { clips, playing, playIndex }

  const sourceOf = useCallback(
    (id: string) => sourceSeconds(editor.getElement(id)) ?? measured[id],
    [editor, measured],
  )
  const total = totalDuration(clips, sourceOf)

  useProbeUnknownDurations(editor, clips, setMeasured)

  useEffect(() => {
    root.current?.focus()
  }, [])

  const urlOf = (list: readonly TimelineClip[], index: number) => {
    const el = editor.getElement(list[index]?.elementId ?? '')
    return el?.type === 'image' && el.video
      ? queueOutputUrl(el.video.taskId, el.video.outputIndex)
      : null
  }

  /** 把预览放到全局 target 秒（按给定的片段表）：换段就换源，同一段直接定位。 */
  const seek = (target: number, list: readonly TimelineClip[] = live.current.clips) => {
    const length = totalDuration(list, sourceOf)
    const clamped = Math.min(Math.max(0, target), length)
    setTime(clamped)
    if (list.length === 0) return
    const { index, sourceTime } = locateTime(list, sourceOf, clamped)
    setPlayIndex(index)
    live.current.playIndex = index
    const node = video.current
    const url = urlOf(list, index)
    if (!node || !url) return
    if (node.getAttribute('src') !== url) {
      pendingSeek.current = sourceTime
      node.src = url
      node.load()
    } else if (pendingSeek.current !== null) {
      // 上一次换源的元数据还没到：改写待定位的位置，别让它回头覆盖这一次。
      pendingSeek.current = sourceTime
    } else {
      node.currentTime = sourceTime
      if (live.current.playing) void node.play().catch(() => setPlaying(false))
    }
  }

  const stop = () => {
    live.current.playing = false
    setPlaying(false)
    video.current?.pause()
  }

  /** 从 from 之后找下一段有源的接着播；缺失的段跳过。没有了就停在末尾。 */
  const advance = (from: number) => {
    const list = live.current.clips
    for (let next = from + 1; next < list.length; next += 1) {
      if (urlOf(list, next)) return seek(startOfClip(list, sourceOf, next), list)
    }
    stop()
    setTime(totalDuration(list, sourceOf))
  }

  // 打开即把第一段载进预览，按播放才有画面。
  useEffect(() => {
    seek(0)
  }, [])

  // 播放中逐帧检查出点：timeupdate 只有约 4 次 / 秒，等它越过出点会多播一截。
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const node = video.current
    const tick = () => {
      const current = live.current
      const clip = current.clips[current.playIndex]
      if (node && clip && pendingSeek.current === null) {
        const range = clipRange(clip, sourceOf(clip.elementId))
        setTime(
          startOfClip(current.clips, sourceOf, current.playIndex) +
            Math.max(0, node.currentTime - range.in),
        )
        if (node.currentTime >= range.out - END_EPSILON) advance(current.playIndex)
      }
      if (live.current.playing) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  const togglePlay = () => {
    const node = video.current
    if (!node) return
    if (playing) return stop()
    const list = live.current.clips
    if (list.length === 0) return
    live.current.playing = true
    setPlaying(true)
    if (time >= total - END_EPSILON) return seek(0)
    // 当前段的源不在了：从下一段有源的开始。
    if (!urlOf(list, playIndex)) return advance(playIndex)
    if (node.getAttribute('src') !== urlOf(list, playIndex)) return seek(time)
    void node.play().catch(() => stop())
  }

  /** 改了片段表：停下，播放头留在原处（超出新总长就到末尾），预览按新表重新定位。 */
  const update = (next: TimelineClip[], change?: Parameters<typeof followSelection>[1]) => {
    stop()
    setClips(next)
    live.current.clips = next
    if (change) setSelected((current) => followSelection(current, change))
    seek(time, next)
  }

  const close = () => {
    const current = editor.getElement(timeline.id)
    if (current?.type === 'timeline' && !sameClips(clips, baseline, sourceOf)) {
      if (current.clips !== baseline)
        useStore.getState().showToast(t('timeline.changedElsewhere'), 'info')
      editor.doc.updateElements(
        [
          {
            id: timeline.id,
            patch: { clips, width: timelineWidth(clips, (id) => editor.getElement(id)) },
          },
        ],
        { history: true },
      )
    }
    stop()
    useTimelineEditor.getState().close()
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // 所有按键停在编辑器里：画布的 Delete / ⌘Z / 字母工具键会作用到画布本身。
    event.stopPropagation()
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      return
    }
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.getAttribute('role') === 'slider') return
    if (event.key === ' ') {
      event.preventDefault()
      togglePlay()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      seek(time + (event.key === 'ArrowLeft' ? -STEP_SECONDS : STEP_SECONDS))
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) {
      event.preventDefault()
      update(removeClip(clips, selected), { kind: 'remove', index: selected })
    }
  }

  const missingNow = clips.length > 0 && !urlOf(clips, playIndex)

  return (
    <Overlay onClose={close} tier="raised" layout="fill" backdrop="none">
      <div
        ref={root}
        className="flex h-full w-full flex-col bg-background text-foreground outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={t('timeline.editorTitle')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
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
              if (!node || pendingSeek.current === null) return
              node.currentTime = pendingSeek.current
              pendingSeek.current = null
              if (live.current.playing) void node.play().catch(() => stop())
            }}
            onEnded={() => {
              if (live.current.playing) advance(live.current.playIndex)
            }}
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
            aria-valuetext={clock(time)}
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
          onMove={(from, to) => update(moveClip(clips, from, to), { kind: 'move', from, to })}
          onTrim={(index, edge, seconds) => {
            const next = [...clips]
            next[index] = trimClip(clips[index]!, edge, seconds, sourceOf(clips[index]!.elementId))
            update(next)
          }}
          onRemove={(index) => update(removeClip(clips, index), { kind: 'remove', index })}
        />
      </div>
    </Overlay>
  )
}

/**
 * 旧视频没有生成记录，时长只能从播放地址的元数据里读，读到才能裁到真正的结尾。
 * 每个源只探一次（失败也记下），不随每次编辑重建。
 */
function useProbeUnknownDurations(
  editor: CanvasEditor,
  clips: readonly TimelineClip[],
  setMeasured: (update: (current: Record<string, number>) => Record<string, number>) => void,
) {
  const tried = useRef(new Set<string>())
  const unknownKey = [
    ...new Set(
      clips
        .map((clip) => editor.getElement(clip.elementId))
        .filter((el) => isTimelineSource(el) && sourceSeconds(el) === undefined)
        .map((el) => el!.id),
    ),
  ]
    .sort()
    .join('|')
  useEffect(() => {
    const probes: HTMLVideoElement[] = []
    for (const id of unknownKey.split('|').filter(Boolean)) {
      if (tried.current.has(id)) continue
      tried.current.add(id)
      const el = editor.getElement(id)
      if (el?.type !== 'image' || !el.video) continue
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.crossOrigin = 'use-credentials'
      probe.onloadedmetadata = () => {
        if (Number.isFinite(probe.duration))
          setMeasured((current) => ({ ...current, [id]: probe.duration }))
      }
      probe.src = queueOutputUrl(el.video.taskId, el.video.outputIndex)
      probes.push(probe)
    }
    return () => {
      for (const probe of probes) {
        probe.onloadedmetadata = null
        probe.removeAttribute('src')
        probe.load()
      }
    }
  }, [editor, unknownKey, setMeasured])
}

function ClipTrack({
  editor,
  clips,
  sourceOf,
  selected,
  onSelect,
  onMove,
  onTrim,
  onRemove,
}: {
  editor: CanvasEditor
  clips: TimelineClip[]
  sourceOf: (id: string) => number | undefined
  selected: number | null
  onSelect: (index: number) => void
  onMove: (from: number, to: number) => void
  onTrim: (index: number, edge: 'in' | 'out', seconds: number) => void
  onRemove: (index: number) => void
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
          onDragEnd={() => setDragFrom(null)}
          onDrop={() => {
            if (dragFrom !== null) onMove(dragFrom, index)
            setDragFrom(null)
          }}
          onTrim={(edge, seconds) => onTrim(index, edge, seconds)}
          onRemove={() => onRemove(index)}
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
  onDragEnd,
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
  onDragEnd: () => void
  onDrop: () => void
  onTrim: (edge: 'in' | 'out', seconds: number) => void
  onRemove: () => void
}) {
  const { t } = useTranslation('canvas')
  const [trimming, setTrimming] = useState(false)
  const element = editor.getElement(clip.elementId)
  const missing = !isTimelineSource(element)
  const poster = usePoster(element?.type === 'image' ? editor.doc.files[element.fileId] : undefined)
  const range = clipRange(clip, source)
  const duration = clipDuration(clip, source)
  const width = Math.max(MIN_CARD_WIDTH, duration * TRACK_PX_PER_SECOND)
  // 源时长未知就不知道结尾在哪：出点等读到时长再开放。
  const outKnown = source !== undefined || clip.out !== undefined

  // 拖边缘裁剪：按拖动的像素折算秒数，每次移动都从按下时的位置算起，不累积误差。
  const startTrim = (edge: 'in' | 'out') => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const origin = edge === 'in' ? range.in : range.out
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    setTrimming(true)
    const move = (moveEvent: PointerEvent) =>
      onTrim(edge, origin + (moveEvent.clientX - startX) / TRACK_PX_PER_SECOND)
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      target.removeEventListener('lostpointercapture', end)
      setTrimming(false)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
    target.addEventListener('lostpointercapture', end)
  }

  const trimKeys =
    (edge: 'in' | 'out', value: number, min: number, max: number) =>
    (event: ReactKeyboardEvent) => {
      const next =
        event.key === 'ArrowLeft'
          ? value - STEP_SECONDS
          : event.key === 'ArrowRight'
            ? value + STEP_SECONDS
            : event.key === 'Home'
              ? min
              : event.key === 'End'
                ? max
                : null
      if (next === null) return
      event.preventDefault()
      onTrim(edge, next)
    }

  const handle = (edge: 'in' | 'out') => {
    const isIn = edge === 'in'
    const value = isIn ? range.in : range.out
    const min = isIn ? 0 : range.in + MIN_CLIP_SECONDS
    const max = isIn ? range.out - MIN_CLIP_SECONDS : (source ?? range.out)
    return (
      <span
        role="slider"
        tabIndex={0}
        aria-label={t(isIn ? 'timeline.trimIn' : 'timeline.trimOut', { index: index + 1 })}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={t('timeline.seconds', { seconds: value.toFixed(1) })}
        className={`absolute inset-y-0 w-3 cursor-ew-resize touch-none bg-primary/70 ${
          isIn ? 'left-0' : 'right-0'
        }`}
        onPointerDown={startTrim(edge)}
        onKeyDown={trimKeys(edge, value, min, max)}
      />
    )
  }

  return (
    <li
      className={`relative shrink-0 overflow-hidden rounded-md border ${
        selected ? 'border-primary ring-2 ring-primary/40' : 'border-border'
      } ${dragging ? 'opacity-50' : ''}`}
      style={{ width }}
      // 拖边缘裁剪时不能同时开始整张卡片的排序拖拽。
      draggable={!trimming}
      onDragStart={(event) => {
        // Firefox 不带数据不会开始拖拽。
        event.dataTransfer.setData('text/plain', String(index))
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
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
      {!missing && handle('in')}
      {!missing && outKnown && handle('out')}
    </li>
  )
}
