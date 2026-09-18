import type { VideoDeriveMode } from '@image-playground/shared'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Download,
  FastForward,
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
  canvasVideoNode,
  downloadCanvasVideo,
  loadCanvasVideoIntoComposer,
  placeCanvasVideoFrame,
  selectedCanvasVideo,
  submitCanvasDerive,
} from '../lib/canvasVideoActions'
import type { CanvasEditor } from '../lib/editor'

/** 工具条浮在视频上沿之上这么高；贴到视口顶时改放在视频内侧。 */
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
  } | null>(null)
  const [busy, setBusy] = useState<'first' | 'last' | 'download' | null>(null)

  const node = editor.doc.tool === 'select' ? selectedCanvasVideo(editor) : null
  const bounds = node ? editor.getElementPageBounds(node.id) : undefined

  const openDerive = (source: CanvasVideoNode, mode: VideoDeriveMode) => {
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
    openDerive(source, derived.mode)
  }

  const run = async (kind: 'first' | 'last' | 'download', current: CanvasVideoNode) => {
    setBusy(kind)
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
      onSubmit={(input) => submitCanvasDerive(editor, derive.node, input)}
      onClose={() => setDerive(null)}
    />
  )

  if (!node || !bounds) return popover || null

  const { camera } = editor.doc
  const left = (bounds.x - camera.x) * camera.zoom
  const top = (bounds.y - camera.y) * camera.zoom
  const checks = {
    extend: canvasDeriveCheck(node, 'extend'),
    edit: canvasDeriveCheck(node, 'edit'),
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('videoToolbar.aria')}
        className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-md"
        style={{
          left: Math.max(8, left),
          top: top - TOOLBAR_OFFSET >= 8 ? top - TOOLBAR_OFFSET : top + 8,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ToolbarButton
          icon={<Download />}
          label={t('videoToolbar.download')}
          disabled={busy !== null}
          onClick={() => void run('download', node)}
        />
        <ToolbarButton
          icon={<RotateCcw />}
          label={t('videoToolbar.regenerate')}
          onClick={() => regenerate(node)}
        />
        {(['extend', 'edit'] as const).map((mode) => {
          const check = checks[mode]
          return (
            <ToolbarButton
              key={mode}
              icon={mode === 'extend' ? <FastForward /> : <WandSparkles />}
              label={videoDeriveLabel(mode)}
              disabled={!check.ok}
              reason={check.ok ? undefined : check.reason}
              onClick={() => openDerive(node, mode)}
            />
          )
        })}
        <ToolbarButton
          icon={<ArrowLeftToLine />}
          label={t('videoToolbar.firstFrame')}
          disabled={busy !== null}
          onClick={() => void run('first', node)}
        />
        <ToolbarButton
          icon={<ArrowRightToLine />}
          label={t('videoToolbar.lastFrame')}
          disabled={busy !== null}
          onClick={() => void run('last', node)}
        />
      </div>
      {popover}
    </>
  )
}

function ToolbarButton({
  icon,
  label,
  disabled,
  reason,
  onClick,
}: {
  icon: ReactNode
  label: string
  disabled?: boolean
  /** 禁用原因。按钮禁用时收不到悬停，所以原因挂在外层。 */
  reason?: string
  onClick: () => void
}) {
  return (
    <span title={reason ?? label}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1 px-2 text-xs"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
        <span className="hidden sm:inline">{label}</span>
      </Button>
    </span>
  )
}
