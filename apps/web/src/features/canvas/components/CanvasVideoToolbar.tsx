import type { VideoDeriveMode } from '@image-playground/shared'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Download,
  FastForward,
  Film,
  FolderDown,
  Pencil,
  RotateCcw,
  WandSparkles,
} from 'lucide-react'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import DeriveVideoPopover from '../../video/components/DeriveVideoPopover'
import { videoDeriveLabel } from '../../video/lib/labels'
import { useFilmExport } from '../filmExportStore'
import {
  type CanvasVideoNode,
  canvasDeriveCheck,
  canvasRegenerateRefusal,
  canvasVideoNode,
  downloadCanvasVideo,
  placeCanvasVideoFrame,
  selectedCanvasVideo,
  submitCanvasDerive,
} from '../lib/canvasVideoActions'
import type { CanvasEditor } from '../lib/editor'
import { filmExportSupported } from '../lib/exportFilm'
import { type FilmRefusal, planFilm } from '../lib/filmPlan'
import { Box } from '../lib/geometry'
import { addSelectionToTimeline, isTimelineSource } from '../lib/timeline'
import { useTimelineEditor } from '../timelineEditorStore'
import RegenerateVideoPopover from './RegenerateVideoPopover'

/** 工具条浮在视频上沿之上这么高；贴到视口顶时改放在视频下沿之下，不压住视频本身。 */
const TOOLBAR_OFFSET = 44

/**
 * 只选中一段视频时浮在它上方的工具条：下载、重新生成、续写 / 改视频、截首尾帧。
 * 画布拖动、缩放时跟着元素走；工具条自己收指针，不把点击漏给画布。
 */
export default function CanvasVideoToolbar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const [derive, setDerive] = useState<{
    node: CanvasVideoNode
    mode: VideoDeriveMode
    modelId: string
    sourceSeconds: number
    initialPrompt?: string
    initialSeconds?: number
  } | null>(null)
  // 忙的是哪一段：截 A 的帧时选中 B，B 的按钮不该跟着灰。
  const [regenerating, setRegenerating] = useState<CanvasVideoNode | null>(null)
  const [busy, setBusy] = useState<{ id: string; kind: 'first' | 'last' | 'download' } | null>(null)

  const node = editor.doc.tool === 'select' ? selectedCanvasVideo(editor) : null
  const bounds = node ? editor.getElementPageBounds(node.id) : undefined

  const openDerive = (
    source: CanvasVideoNode,
    mode: VideoDeriveMode,
    initial: { prompt?: string; seconds?: number } = {},
  ) => {
    const check = canvasDeriveCheck(source, mode)
    if (!check.ok) {
      useStore.getState().showToast(check.reason, 'error')
      return
    }
    setDerive({
      node: source,
      mode,
      modelId: check.option.modelId,
      sourceSeconds: check.sourceSeconds,
      ...(initial.prompt ? { initialPrompt: initial.prompt } : {}),
      ...(initial.seconds !== undefined ? { initialSeconds: initial.seconds } : {}),
    })
  }

  // 派生出来的片子「重新生成」就是对同一段源片再派生一次；普通生成载回生成栏改参数再发。
  const regenerate = (current: CanvasVideoNode) => {
    const derived = current.video.generation?.derivedFrom
    if (!derived) {
      setRegenerating(current)
      return
    }
    const source = canvasVideoNode(editor, derived.id)
    if (!source) {
      useStore.getState().showToast(t('videoToolbar.sourceGone'), 'error')
      return
    }
    // 原样再来一次：弹窗带着上次的描述和续写秒数，用户改一处就能发。
    openDerive(source, derived.mode, {
      prompt: current.userPrompt ?? undefined,
      seconds: current.video.generation?.duration,
    })
  }

  const run = async (kind: 'first' | 'last' | 'download', current: CanvasVideoNode) => {
    setBusy({ id: current.id, kind })
    try {
      if (kind === 'download') await downloadCanvasVideo(current)
      else await placeCanvasVideoFrame(editor, current, kind)
    } finally {
      setBusy(null)
    }
  }

  const popover = (derive || regenerating) && (
    <>
      {regenerating && (
        <RegenerateVideoPopover
          editor={editor}
          node={regenerating}
          onClose={() => setRegenerating(null)}
        />
      )}
      {derive && (
        <DeriveVideoPopover
          sourceSeconds={derive.sourceSeconds}
          mode={derive.mode}
          modelId={derive.modelId}
          initialPrompt={derive.initialPrompt}
          initialSeconds={derive.initialSeconds}
          onSubmit={(input) => submitCanvasDerive(editor, derive.node, input)}
          onClose={() => setDerive(null)}
        />
      )}
    </>
  )

  const addToTimeline = () => {
    addSelectionToTimeline(editor)
  }

  // 多选几段视频（可以连同一条时间线）：只给「加入时间线」一个动作，其余动作都只对单段有意义。
  if (!node) {
    const selected = editor.getSelectedIds().map((id) => editor.getElement(id))
    const videos = selected.filter(isTimelineSource)
    const timelines = selected.filter((el) => el?.type === 'timeline')
    const onlyVideos = selected.every((el) => isTimelineSource(el) || el?.type === 'timeline')
    // 单选一条时间线：给一个「编辑」入口，双击在触屏上不好找。
    const lone = selected.length === 1 && selected[0]?.type === 'timeline' ? selected[0] : null
    if (lone && editor.doc.tool === 'select') {
      const box = editor.getElementPageBounds(lone.id)
      if (!box) return popover || null
      const { camera } = editor.doc
      const loneTop = (box.y - camera.y) * camera.zoom
      return (
        <>
          <div
            role="toolbar"
            aria-label={t('timeline.title')}
            className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-md"
            style={{
              left: Math.max(8, (box.x - camera.x) * camera.zoom),
              top:
                loneTop - TOOLBAR_OFFSET >= 8
                  ? loneTop - TOOLBAR_OFFSET
                  : (box.maxY - camera.y) * camera.zoom + 8,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <ToolbarButton
              icon={<Pencil />}
              label={t('timeline.edit')}
              onClick={() => useTimelineEditor.getState().open(lone.id)}
            />
            <FilmExportButtons editor={editor} timelineId={lone.id} />
          </div>
          {popover}
        </>
      )
    }
    if (editor.doc.tool !== 'select' || videos.length === 0 || timelines.length > 1 || !onlyVideos)
      return popover || null
    const boxes = editor
      .getSelectedIds()
      .map((id) => editor.getElementPageBounds(id))
      .filter((box) => box !== undefined)
    const group = Box.Common(boxes)
    const { camera } = editor.doc
    const groupTop = (group.y - camera.y) * camera.zoom
    return (
      <>
        <div
          role="toolbar"
          aria-label={t('videoToolbar.aria')}
          className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-md"
          style={{
            left: Math.max(8, (group.x - camera.x) * camera.zoom),
            top:
              groupTop - TOOLBAR_OFFSET >= 8
                ? groupTop - TOOLBAR_OFFSET
                : (group.maxY - camera.y) * camera.zoom + 8,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ToolbarButton
            icon={<Film />}
            label={
              timelines.length
                ? t('timeline.appendCount', { count: videos.length })
                : t('timeline.addCount', { count: videos.length })
            }
            onClick={addToTimeline}
          />
        </div>
        {popover}
      </>
    )
  }
  if (!bounds) return popover || null

  const { camera } = editor.doc
  const left = (bounds.x - camera.x) * camera.zoom
  const top = (bounds.y - camera.y) * camera.zoom
  const bottom = (bounds.y + bounds.h - camera.y) * camera.zoom
  const checks = {
    extend: canvasDeriveCheck(node, 'extend'),
    edit: canvasDeriveCheck(node, 'edit'),
  }
  const regenerateRefusal = canvasRegenerateRefusal()
  const busyHere = busy?.id === node.id

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('videoToolbar.aria')}
        className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-md"
        style={{
          left: Math.max(8, left),
          top: top - TOOLBAR_OFFSET >= 8 ? top - TOOLBAR_OFFSET : bottom + 8,
        }}
        onPointerDown={(event) => event.stopPropagation()}
        // 空格、方向键在画布上是平移 / 移动的快捷键，按在工具条按钮上不该漏过去。
        onKeyDown={(event) => event.stopPropagation()}
      >
        <ToolbarButton
          icon={<Download />}
          label={t('videoToolbar.download')}
          disabled={busyHere}
          onClick={() => void run('download', node)}
        />
        <ToolbarButton
          icon={<RotateCcw />}
          label={t('videoToolbar.regenerate')}
          reason={regenerateRefusal ?? undefined}
          onClick={() => regenerate(node)}
        />
        {(['extend', 'edit'] as const).map((mode) => {
          const check = checks[mode]
          return (
            <ToolbarButton
              key={mode}
              icon={mode === 'extend' ? <FastForward /> : <WandSparkles />}
              label={videoDeriveLabel(mode)}
              reason={check.ok ? undefined : check.reason}
              onClick={() => openDerive(node, mode)}
            />
          )
        })}
        <ToolbarButton icon={<Film />} label={t('timeline.add')} onClick={addToTimeline} />
        <ToolbarButton
          icon={<ArrowLeftToLine />}
          label={t('videoToolbar.firstFrame')}
          disabled={busyHere}
          onClick={() => void run('first', node)}
        />
        <ToolbarButton
          icon={<ArrowRightToLine />}
          label={t('videoToolbar.lastFrame')}
          disabled={busyHere}
          onClick={() => void run('last', node)}
        />
      </div>
      {popover}
    </>
  )
}

/**
 * 工具条按钮。做不了的动作不用原生 disabled：那样按钮拿不到焦点，键盘和读屏用户
 * 永远看不到原因。改成 aria-disabled，按下去说明为什么不行。
 */
function ToolbarButton({
  icon,
  label,
  disabled,
  reason,
  onClick,
}: {
  icon: ReactNode
  label: string
  /** 正在进行中，暂时不可点。 */
  disabled?: boolean
  /** 做不了的原因；有它就是不可用。 */
  reason?: string
  onClick: () => void
}) {
  const unavailable = reason !== undefined
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`h-8 gap-1 px-2 text-xs ${unavailable ? 'opacity-50' : ''}`}
      aria-label={label}
      aria-disabled={unavailable || undefined}
      title={reason ?? label}
      disabled={disabled}
      onClick={() => {
        if (unavailable) useStore.getState().showToast(reason, 'error')
        else onClick()
      }}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
}

/** 这个浏览器能不能导出成片；探测完成前是 undefined。 */
function useFilmSupport(): boolean | undefined {
  const [supported, setSupported] = useState<boolean>()
  useEffect(() => {
    let live = true
    void filmExportSupported()
      .catch(() => false)
      .then((value) => {
        if (live) setSupported(value)
      })
    return () => {
      live = false
    }
  }, [])
  return supported
}

/** 时间线工具条上的「导出成片」；浏览器编不了 H.264 时换成「下载全部片段」。 */
function FilmExportButtons({ editor, timelineId }: { editor: CanvasEditor; timelineId: string }) {
  const { t } = useTranslation('canvas')
  const supported = useFilmSupport()
  const run = useFilmExport((state) => state.run)
  const timeline = editor.getElement(timelineId)
  if (timeline?.type !== 'timeline') return null
  const plan = planFilm(timeline.clips, (id) => editor.getElement(id))
  const refusalText = (refusal: FilmRefusal) => {
    switch (refusal.kind) {
      case 'empty':
        return t('timeline.empty')
      case 'missing':
        return t('film.missing', { position: refusal.position })
      case 'tooMany':
        return t('film.tooMany', { max: refusal.max })
      case 'tooLong':
        return t('film.tooLong', { minutes: refusal.maxSeconds / 60 })
    }
  }
  const busy = run !== null
  const exporting = run?.timelineId === timelineId
  const percent = exporting ? Math.round(run.fraction * 100) : 0

  if (supported === false) {
    const zipPlan = planFilm(timeline.clips, (id) => editor.getElement(id), { limits: false })
    return (
      <>
        <ToolbarButton
          icon={<Download />}
          label={t('film.export')}
          reason={t('film.unsupported')}
          onClick={() => {}}
        />
        <ToolbarButton
          icon={<FolderDown />}
          label={exporting ? t('film.zipping') : t('film.downloadClips')}
          disabled={busy}
          reason={zipPlan.ok ? undefined : refusalText(zipPlan.refusal)}
          onClick={() => {
            if (zipPlan.ok) useFilmExport.getState().start(timelineId, zipPlan.clips, 'zip')
          }}
        />
      </>
    )
  }
  return (
    <ToolbarButton
      icon={<Download />}
      label={exporting ? t('film.progress', { percent }) : t('film.export')}
      disabled={busy || supported === undefined}
      reason={plan.ok ? undefined : refusalText(plan.refusal)}
      onClick={() => {
        if (plan.ok) useFilmExport.getState().start(timelineId, plan.clips, 'film')
      }}
    />
  )
}
