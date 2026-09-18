import type { VideoDeriveMode } from '@image-playground/shared'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Download,
  FastForward,
  Film,
  RotateCcw,
  WandSparkles,
} from 'lucide-react'
import { type ReactNode, useState, useSyncExternalStore } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import DeriveVideoPopover from '../../video/components/DeriveVideoPopover'
import { videoDeriveLabel } from '../../video/lib/labels'
import {
  type CanvasVideoNode,
  canvasDeriveCheck,
  canvasRegenerateRefusal,
  canvasVideoNode,
  downloadCanvasVideo,
  loadCanvasVideoIntoComposer,
  placeCanvasVideoFrame,
  selectedCanvasVideo,
  submitCanvasDerive,
} from '../lib/canvasVideoActions'
import type { CanvasEditor } from '../lib/editor'
import { Box } from '../lib/geometry'
import { addSelectionToTimeline, isTimelineSource } from '../lib/timeline'

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
      loadCanvasVideoIntoComposer(editor, current)
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

  const popover = derive && (
    <DeriveVideoPopover
      sourceSeconds={derive.sourceSeconds}
      mode={derive.mode}
      modelId={derive.modelId}
      initialPrompt={derive.initialPrompt}
      initialSeconds={derive.initialSeconds}
      onSubmit={(input) => submitCanvasDerive(editor, derive.node, input)}
      onClose={() => setDerive(null)}
    />
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
