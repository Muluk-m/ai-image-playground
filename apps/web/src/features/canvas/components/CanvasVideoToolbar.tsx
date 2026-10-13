import type { VideoDeriveMode } from '@image-playground/shared'
import { useState, useSyncExternalStore } from 'react'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { isVideoModeAvailable, videoModelOptions } from '../../../lib/channels/videoChannels'
import { useStore } from '../../../store'
import DeriveVideoPopover from '../../video/components/DeriveVideoPopover'
import { videoDeriveLabel } from '../../video/lib/labels'
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
import { Box } from '../lib/geometry'
import type { CanvasInputEntry } from '../lib/rasterizeSelection'
import { referenceSelection } from '../lib/submitVideoFromCanvas'
import { addSelectionToTimeline, isTimelineSource } from '../lib/timeline'
import { useCanvasProjectStore } from '../projectStore'
import { useTimelineEditor } from '../timelineEditorStore'
import CanvasToolbarButton from './CanvasToolbarButton'
import FilmExportButtons from './FilmExportButtons'
import ReferenceVideoPopover from './ReferenceVideoPopover'
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
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
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
  // 选中即参考：打开那一刻的选区，之后改选区不影响面板。
  const [referencing, setReferencing] = useState<CanvasInputEntry[] | null>(null)
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

  const popover = (derive || regenerating || referencing) && (
    <>
      {referencing && (
        <ReferenceVideoPopover
          editor={editor}
          entries={referencing}
          onClose={() => setReferencing(null)}
        />
      )}
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
            <CanvasToolbarButton
              icon={<Icon name="edit" />}
              label={t('timeline.edit')}
              onClick={() => useTimelineEditor.getState().open(lone.id)}
            />
            <FilmExportButtons editor={editor} timelineId={lone.id} />
          </div>
          {popover}
        </>
      )
    }
    // 多选了几张图（没有视频）且有模型带得了参考图：给「用 N 张图生成视频」，打开选中即参考的面板。
    // 只在视频画布里：图片画布多选几张图是要改图、对齐，冒出「生成视频」是答非所问。
    const images =
      editor.doc.tool === 'select' &&
      project?.kind === 'video' &&
      isVideoModeAvailable() &&
      videoModelOptions().some((one) => one.support.referenceImages)
        ? referenceSelection(editor)
        : null
    if (images && !popover) {
      const boxes = images.map((entry) => entry.box)
      const group = Box.Common(boxes)
      const { camera } = editor.doc
      const groupTop = (group.y - camera.y) * camera.zoom
      return (
        <div
          role="toolbar"
          aria-label={t('referenceVideo.toolbarAria')}
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
          <CanvasToolbarButton
            icon={<Icon name="images" />}
            label={t('referenceVideo.open', { count: images.length })}
            onClick={() => setReferencing(images)}
          />
        </div>
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
          <CanvasToolbarButton
            icon={<Icon name="video" />}
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
        <CanvasToolbarButton
          icon={<Icon name="download" />}
          label={t('videoToolbar.download')}
          disabled={busyHere}
          onClick={() => void run('download', node)}
        />
        <CanvasToolbarButton
          icon={<Icon name="refresh" />}
          label={t('videoToolbar.regenerate')}
          reason={regenerateRefusal ?? undefined}
          onClick={() => regenerate(node)}
        />
        {(['extend', 'edit'] as const).map((mode) => {
          const check = checks[mode]
          return (
            <CanvasToolbarButton
              key={mode}
              icon={mode === 'extend' ? <Icon name="arrowRight" /> : <Icon name="wand" />}
              label={videoDeriveLabel(mode)}
              reason={check.ok ? undefined : check.reason}
              onClick={() => openDerive(node, mode)}
            />
          )
        })}
        <CanvasToolbarButton
          icon={<Icon name="video" />}
          label={t('timeline.add')}
          onClick={addToTimeline}
        />
        <CanvasToolbarButton
          icon={<Icon name="chevronLeft" />}
          label={t('videoToolbar.firstFrame')}
          disabled={busyHere}
          onClick={() => void run('first', node)}
        />
        <CanvasToolbarButton
          icon={<Icon name="chevronRight" />}
          label={t('videoToolbar.lastFrame')}
          disabled={busyHere}
          onClick={() => void run('last', node)}
        />
      </div>
      {popover}
    </>
  )
}
