import { PROJECT_TIMELINE_MAX_CLIPS } from '@image-playground/shared'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { videoOutputUrl } from '../../../lib/channels/queueClient'
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
import { useNodeMedia } from './NodeMediaImage'

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

/** 画布挂载点：有正在编辑的时间线才渲染编辑器；时间线没了（被删、换了项目）就收起。 */
interface TimelineEditorActions {
  beginEdit?: (id: string) => { clips: TimelineClip[]; save: (clips: TimelineClip[]) => void }
  onLocate?: (id: string) => void
  onSave?: (id: string, clips: TimelineClip[]) => void
}
export default function TimelineEditorHost({
  editor,
  ...actions
}: { editor: CanvasEditor } & TimelineEditorActions) {
  const openId = useTimelineEditor((state) => state.openId)
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const element = openId ? editor.getElement(openId) : undefined
  const gone = openId !== null && element?.type !== 'timeline'
  useEffect(() => {
    // 不收起的话 openId 留在全局，撤销恢复这条时间线或切回项目时编辑器会自己弹出来。
    if (gone) useTimelineEditor.getState().close()
  }, [gone])
  if (element?.type !== 'timeline') return null
  return <TimelineEditor key={element.id} editor={editor} timeline={element} {...actions} />
}

/**
 * 全屏编辑一条时间线：上面预览，下面片段轨。改的是草稿，关闭时一次写回画布——
 * 整个编辑过程是一条撤销记录，⌘Z 一下回到打开前。
 */
function TimelineEditor({
  editor,
  timeline,
  onLocate,
  onSave,
  beginEdit,
}: { editor: CanvasEditor; timeline: TimelineEl } & TimelineEditorActions) {
  const { t } = useTranslation('canvas')
  const [session] = useState(() => beginEdit?.(timeline.id))
  const [baseline] = useState(session?.clips ?? timeline.clips)
  const [clips, setClips] = useState<TimelineClip[]>(baseline)
  const [selected, setSelected] = useState<number | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playIndex, setPlayIndex] = useState(0)
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const [videoError, setVideoError] = useState(false)
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 })
  const undoStack = useRef<TimelineClip[][]>([])
  const redoStack = useRef<TimelineClip[][]>([])
  const video = useRef<HTMLVideoElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const pendingSeek = useRef<number | null>(null)
  // 播放循环与媒体事件回调里读这几份 ref，不读闭包：状态在两次渲染之间就会变。
  const live = useRef({ clips, playing, playIndex })
  live.current = { clips, playing, playIndex }

  const sourceOf = useCallback(
    (id: string) => {
      const el = editor.getElement(id)
      return (
        sourceSeconds(el) ??
        (el?.type === 'image' && el.video ? measured[videoOutputUrl(el.video)] : undefined)
      )
    },
    [editor, measured],
  )
  const total = totalDuration(clips, sourceOf)

  useProbeUnknownDurations(editor, clips, setMeasured)

  useEffect(() => {
    root.current?.focus()
  }, [])

  const urlOf = (list: readonly TimelineClip[], index: number) => {
    const el = editor.getElement(list[index]?.elementId ?? '')
    return el?.type === 'image' && el.video ? videoOutputUrl(el.video) : null
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
    if (!node) return
    if (!url) {
      live.current.playing = false
      setPlaying(false)
      setVideoError(false)
      pendingSeek.current = null
      node.pause()
      node.removeAttribute('src')
      node.load()
      return
    }
    if (node.getAttribute('src') !== url) {
      setVideoError(false)
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

  // 主结果切换或源删除时同步预览；节点 ID 不变也不能继续播旧地址。
  const previewUrl = urlOf(clips, playIndex)
  useEffect(() => {
    seek(time)
  }, [previewUrl])

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

  const syncHistory = () =>
    setHistoryState({ undo: undoStack.current.length, redo: redoStack.current.length })

  const pushHistory = () => {
    undoStack.current.push(live.current.clips)
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
    syncHistory()
  }

  /** 改了片段表：停下，播放头留在原处（超出新总长就到末尾），预览按新表重新定位。 */
  const update = (
    next: TimelineClip[],
    change?: Parameters<typeof followSelection>[1],
    record = true,
  ) => {
    stop()
    if (record) pushHistory()
    setClips(next)
    live.current.clips = next
    if (change) setSelected((current) => followSelection(current, change))
    seek(time, next)
  }

  const undo = () => {
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(live.current.clips)
    syncHistory()
    setSelected((current) =>
      current !== null && current >= previous.length
        ? previous.length > 0
          ? previous.length - 1
          : null
        : current,
    )
    update(previous, undefined, false)
  }

  const redo = () => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(live.current.clips)
    syncHistory()
    setSelected((current) =>
      current !== null && current >= next.length
        ? next.length > 0
          ? next.length - 1
          : null
        : current,
    )
    update(next, undefined, false)
  }

  const retryVideo = () => {
    const node = video.current
    const url = urlOf(live.current.clips, live.current.playIndex)
    if (!node || !url) return
    setVideoError(false)
    node.removeAttribute('src')
    seek(time)
  }

  const close = () => {
    const current = editor.getElement(timeline.id)
    if (current?.type === 'timeline' && !sameClips(clips, baseline, sourceOf)) {
      if (!session && !sameClips(current.clips, baseline, sourceOf))
        useStore.getState().showToast(t('timeline.changedElsewhere'), 'info')
      if (session) session.save(clips)
      else if (onSave) onSave(timeline.id, clips)
      else
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
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (key === 'y') {
        event.preventDefault()
        redo()
        return
      }
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
    <Overlay onClose={close} tier="raised" layout="fill" backdrop="none" role="none">
      <div
        ref={root}
        className="flex h-full w-full flex-col bg-background text-foreground outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={t('timeline.editorTitle')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {clips.length > PROJECT_TIMELINE_MAX_CLIPS && (
          <p role="alert" className="px-3 text-xs text-destructive">
            {t('timeline.overflow', { max: PROJECT_TIMELINE_MAX_CLIPS })}
          </p>
        )}
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h2 className="text-sm font-medium">
            {t('timeline.editorTitle')} · {clips.length} · {clock(total)}
          </h2>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={historyState.undo === 0}
              onClick={undo}
              aria-label={t('toolbar.undo')}
              title={t('toolbar.undo')}
            >
              <Icon name="undo" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={historyState.redo === 0}
              onClick={redo}
              aria-label={t('toolbar.redo')}
              title={t('toolbar.redo')}
            >
              <Icon name="redo" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={close}
              aria-label={t('timeline.done')}
            >
              <Icon name="close" />
              {t('timeline.done')}
            </Button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
          <video
            ref={video}
            className="max-h-full max-w-full"
            playsInline
            crossOrigin="use-credentials"
            onLoadedMetadata={() => {
              setVideoError(false)
              const node = video.current
              if (!node || pendingSeek.current === null) return
              node.currentTime = pendingSeek.current
              pendingSeek.current = null
              if (live.current.playing) void node.play().catch(() => stop())
            }}
            onError={() => {
              if (!video.current?.getAttribute('src')) return
              stop()
              setVideoError(true)
            }}
            onEnded={() => {
              if (live.current.playing) advance(live.current.playIndex)
            }}
          >
            <track kind="captions" />
          </video>
          {videoError && !missingNow && clips.length > 0 && (
            <div
              role="alert"
              className="absolute flex flex-col items-center gap-2 rounded-xl border border-border bg-card/95 px-4 py-3 text-center shadow-lg"
            >
              <p className="text-sm text-destructive">{t('nodes.trimLoadFailed')}</p>
              <Button type="button" variant="outline" size="sm" onClick={retryVideo}>
                <Icon name="refresh" />
                {t('assetsPanel.retry')}
              </Button>
            </div>
          )}
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
            {playing ? <Icon name="pause" /> : <Icon name="play" />}
          </Button>
          <span className="w-24 text-xs tabular-nums text-muted-foreground">
            {clock(time)} / {clock(total)}
          </span>
          <Slider
            className="flex-1"
            min={0}
            max={Math.max(total, 0.1)}
            step={0.1}
            value={[time]}
            aria-label={t('timeline.playhead')}
            aria-valuetext={clock(time)}
            onValueChange={([value]) => {
              if (value !== undefined) seek(value)
            }}
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
          onTrimStart={pushHistory}
          onTrim={(index, edge, seconds, record = true) => {
            const current = live.current.clips
            const next = [...current]
            next[index] = trimClip(
              current[index]!,
              edge,
              seconds,
              sourceOf(current[index]!.elementId),
            )
            update(next, undefined, record)
          }}
          onRemove={(index) => update(removeClip(clips, index), { kind: 'remove', index })}
          onLocate={
            onLocate
              ? (index) => {
                  close()
                  onLocate(clips[index]!.elementId)
                }
              : undefined
          }
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
  const unknownKey = JSON.stringify(
    [
      ...new Set(
        clips.flatMap((clip) => {
          const el = editor.getElement(clip.elementId)
          return el?.type === 'image' && el.video && sourceSeconds(el) === undefined
            ? [videoOutputUrl(el.video)]
            : []
        }),
      ),
    ].sort(),
  )
  useEffect(() => {
    const probes: HTMLVideoElement[] = []
    const urls: string[] = JSON.parse(unknownKey)
    for (const url of urls) {
      if (tried.current.has(url)) continue
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.crossOrigin = 'use-credentials'
      probe.onloadedmetadata = () => {
        tried.current.add(url)
        if (Number.isFinite(probe.duration))
          setMeasured((current) => ({ ...current, [url]: probe.duration }))
      }
      probe.onerror = () => {
        tried.current.add(url)
      }
      probe.src = url
      probes.push(probe)
    }
    return () => {
      for (const probe of probes) {
        probe.onloadedmetadata = null
        probe.onerror = null
        probe.removeAttribute('src')
        probe.load()
      }
    }
  }, [unknownKey, setMeasured])
}

function ClipTrack({
  editor,
  clips,
  sourceOf,
  selected,
  onSelect,
  onMove,
  onTrimStart,
  onTrim,
  onRemove,
  onLocate,
}: {
  editor: CanvasEditor
  clips: TimelineClip[]
  sourceOf: (id: string) => number | undefined
  selected: number | null
  onSelect: (index: number) => void
  onMove: (from: number, to: number) => void
  onTrimStart: () => void
  onTrim: (index: number, edge: 'in' | 'out', seconds: number, record?: boolean) => void
  onRemove: (index: number) => void
  onLocate?: (index: number) => void
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
          onTrimStart={onTrimStart}
          onTrim={(edge, seconds, record) => onTrim(index, edge, seconds, record)}
          onRemove={() => onRemove(index)}
          onLocate={onLocate ? () => onLocate(index) : undefined}
          onMoveLeft={index > 0 ? () => onMove(index, index - 1) : undefined}
          onMoveRight={index < clips.length - 1 ? () => onMove(index, index + 1) : undefined}
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
  onTrimStart,
  onTrim,
  onRemove,
  onLocate,
  onMoveLeft,
  onMoveRight,
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
  onTrimStart: () => void
  onTrim: (edge: 'in' | 'out', seconds: number, record?: boolean) => void
  onRemove: () => void
  onLocate?: () => void
  onMoveLeft?: () => void
  onMoveRight?: () => void
}) {
  const { t } = useTranslation('canvas')
  const [trimming, setTrimming] = useState(false)
  const element = editor.getElement(clip.elementId)
  const missing = !isTimelineSource(element)
  const posterMedia = useNodeMedia(
    element?.type === 'image' ? editor.doc.files[element.fileId] : undefined,
  )
  const poster = posterMedia.status === 'ready' ? posterMedia.url : undefined
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
    let recorded = false
    const move = (moveEvent: PointerEvent) => {
      if (!recorded) {
        onTrimStart()
        recorded = true
      }
      onTrim(edge, origin + (moveEvent.clientX - startX) / TRACK_PX_PER_SECOND, false)
    }
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
        className={`absolute top-0 h-20 w-3 cursor-ew-resize touch-none bg-primary/70 ${
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
      <Button
        type="button"
        variant="ghost"
        className="block h-20 w-full rounded-none bg-black p-0 text-left hover:bg-black"
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
      </Button>
      <div className="flex items-center justify-between gap-1 px-1 py-0.5 text-label-sm tabular-nums">
        <span>{clock(duration)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('timeline.removeClip', { index: index + 1 })}
          onClick={onRemove}
        >
          <Icon name="delete" />
        </Button>
      </div>
      <div className="flex justify-center gap-1 px-3">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('timeline.moveEarlier', { index: index + 1 })}
          disabled={!onMoveLeft}
          onClick={onMoveLeft}
        >
          <Icon name="chevronLeft" />
        </Button>
        {onLocate && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t('timeline.locate', { index: index + 1 })}
            disabled={!element}
            onClick={onLocate}
          >
            <Icon name="focus" />
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('timeline.moveLater', { index: index + 1 })}
          disabled={!onMoveRight}
          onClick={onMoveRight}
        >
          <Icon name="chevronRight" />
        </Button>
      </div>
      {!missing && handle('in')}
      {!missing && outKnown && handle('out')}
    </li>
  )
}
