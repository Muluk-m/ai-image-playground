import {
  Crop,
  Eraser,
  Expand,
  MoreHorizontal,
  Pencil,
  Ratio,
  Scissors,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { OUTLINE_BUTTON, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useTranslation } from '../../../i18n'
import { loadImage } from '../../../lib/canvasImage'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { calculateMaskWorkingSize } from '../../../lib/maskPreprocess'
import { useStore } from '../../../store'
import { useInpaintSession } from '../inpaintStore'
import { canvasImageSource } from '../lib/canvasImageActions'
import { outpaintRefusal } from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'
import { rectPixelSize } from '../lib/imageRectEdit'
import { maskedEditSizeRefusal } from '../lib/maskedEditLimits'
import { sendImageEditToAgent } from '../lib/sendImageEditToAgent'
import { inpaintRefusal } from '../lib/submitInpaint'
import { useRectEdit } from '../rectEditStore'
import CanvasImageMenu, { type CanvasImageMenuState } from './CanvasImageMenu'
import CanvasToolbarButton from './CanvasToolbarButton'
import { CANVAS_PANEL_FIELD } from './canvasPanelStyles'
import InpaintPanel from './InpaintPanel'

type EditAction = 'inpaint' | 'erase' | 'cutout' | 'edit' | 'crop' | 'outpaint' | 'resize'
const PANEL_WIDTH = 576
const TOOLBAR_GAP = 10
const TOOLBAR_HEIGHT = 40
const RATIOS = ['1:1', '3:4', '9:16', '4:3', '16:9'] as const

/** 图片下方的快捷菜单；编辑动作将它就地展开，要求统一发给 Agent 对话。 */
export default function CanvasImageToolbar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation(['canvas', 'common'])
  const settings = useStore((state) => state.settings)
  const version = useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const inpaintImageId = useInpaintSession((state) => state.imageId)
  const openInpaint = useInpaintSession((state) => state.open)
  const closeInpaint = useInpaintSession((state) => state.close)
  const rectSession = useRectEdit()
  const [menu, setMenu] = useState<CanvasImageMenuState | null>(null)
  const [active, setActive] = useState<{ imageId: string; action: EditAction } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]>('1:1')
  const [pending, setPending] = useState(false)
  const [naturalSize, setNaturalSize] = useState<{
    source: string
    width: number
    height: number
  } | null>(null)
  const sessionEpoch = useRef(0)
  const busyRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const doc = editor.doc
  const selectedId = doc.selection.size === 1 ? [...doc.selection][0] : null
  const selectedElement = selectedId ? doc.getElement(selectedId) : undefined
  const selectedSource =
    selectedElement?.type === 'image' ? doc.files[selectedElement.fileId] : undefined

  useEffect(() => {
    let live = true
    if (selectedSource) {
      void resolveMediaSource(selectedSource, 'original')
        .then(loadImage)
        .then((image) => {
          if (live)
            setNaturalSize({
              source: selectedSource,
              width: image.naturalWidth,
              height: image.naturalHeight,
            })
        })
        .catch(() => {
          if (live) setNaturalSize(null)
        })
    }
    return () => {
      live = false
    }
  }, [selectedSource])

  useEffect(
    () => () => {
      sessionEpoch.current += 1
      const imageId = activeRef.current?.imageId
      if (imageId && useInpaintSession.getState().imageId === imageId) closeInpaint()
      if (imageId && useRectEdit.getState().imageId === imageId) rectSession.close()
    },
    [closeInpaint, rectSession.close],
  )

  useEffect(() => {
    const item = active ? doc.getElement(active.imageId) : undefined
    const visible =
      doc.tool === 'select' &&
      active?.imageId === selectedId &&
      item?.type === 'image' &&
      !item.video &&
      !editor.getPlaceholders().some((one) => one.meta.editSourceId === active.imageId)
    if (active && !visible) {
      sessionEpoch.current += 1
      setActive(null)
      setPending(false)
      closeInpaint()
      rectSession.close()
    }
  }, [active, selectedId, version, doc, editor, closeInpaint, rectSession.close])

  if (doc.tool !== 'select' || !selectedId) return null
  const element = doc.getElement(selectedId)
  if (element?.type !== 'image' || element.video) return null
  if (editor.getPlaceholders().some((one) => one.meta.editSourceId === element.id)) return null
  const bounds = editor.getElementPageBounds(element.id)
  if (!bounds) return null
  const sourceMissing = canvasImageSource(doc, element.id)
    ? undefined
    : t('imageToolbar.sourceMissing')
  const dimensions = naturalSize?.source === selectedSource ? naturalSize : null
  const paintReason =
    sourceMissing ??
    inpaintRefusal(
      element,
      dimensions ? { width: dimensions.width, height: dimensions.height } : null,
      settings,
    ) ??
    undefined
  const outpaintReason = sourceMissing ?? outpaintRefusal(element, settings) ?? undefined
  const actionTitle: Record<EditAction, string> = {
    inpaint: t('inpaint.title'),
    erase: t('erase.title'),
    cutout: t('cutout.action'),
    edit: t('imageEdit.title'),
    crop: t('crop.title'),
    outpaint: t('outpaint.title'),
    resize: t('resize.action'),
  }
  const expanded = active?.imageId === element.id ? active.action : null
  const painting = expanded === 'inpaint' || expanded === 'erase'
  const frameMode = expanded === 'crop' || expanded === 'outpaint' ? expanded : null
  const framing = frameMode !== null
  const frame = rectSession.rect
  const frameChanged =
    frame.x !== 0 || frame.y !== 0 || frame.w !== element.width || frame.h !== element.height
  const { camera, viewport } = doc
  const imageLeft = (bounds.x - camera.x) * camera.zoom
  const imageTop = (bounds.y - camera.y) * camera.zoom
  const imageBottom = (bounds.y + bounds.h - camera.y) * camera.zoom
  const width = Math.min(PANEL_WIDTH, viewport.width - 16)
  const left = expanded
    ? Math.max(
        8,
        Math.min(viewport.width - width - 8, imageLeft + (bounds.w * camera.zoom - width) / 2),
      )
    : Math.max(8, imageLeft)
  const expandedHeight = painting ? 300 : 205
  const preferredTop = imageBottom + TOOLBAR_GAP
  const expandedTop =
    preferredTop + expandedHeight <= viewport.height - 8
      ? preferredTop
      : imageTop - TOOLBAR_GAP - expandedHeight >= 8
        ? imageTop - TOOLBAR_GAP - expandedHeight
        : Math.max(8, viewport.height - expandedHeight - 8)
  const top = expanded
    ? expandedTop
    : imageBottom + TOOLBAR_GAP + TOOLBAR_HEIGHT <= viewport.height
      ? imageBottom + TOOLBAR_GAP
      : Math.max(8, imageTop - TOOLBAR_GAP - TOOLBAR_HEIGHT)
  const panelEpoch = sessionEpoch.current
  const setBusy = (value: boolean) => {
    busyRef.current = value
    setPending(value)
  }

  const close = () => {
    if (busyRef.current) return
    sessionEpoch.current += 1
    setActive(null)
    setPending(false)
    closeInpaint()
    rectSession.close()
  }
  const open = (action: EditAction) => {
    if (busyRef.current) return
    sessionEpoch.current += 1
    setMenu(null)
    if (inpaintImageId) closeInpaint()
    if (rectSession.mode) rectSession.close()
    setActive({ imageId: element.id, action })
    setPrompt('')
    setRatio('1:1')
    if (action === 'inpaint' || action === 'erase') openInpaint(element.id, action)
    if (action === 'crop' || action === 'outpaint')
      rectSession.open(action, element.id, { x: 0, y: 0, w: element.width, h: element.height })
    editor.focusImageForEdit(element.id, action === 'inpaint' || action === 'erase' ? 390 : 225)
  }
  const send = async () => {
    if (busyRef.current || !expanded || painting) return
    const requirement = prompt.trim()
    if (expanded === 'edit' && !requirement) return
    if (framing && !frameChanged) return
    if (expanded === 'outpaint' && dimensions) {
      const desired = rectPixelSize(frame, element, dimensions)
      const working = calculateMaskWorkingSize(desired.width, desired.height)
      const refusal = maskedEditSizeRefusal(working.width, working.height)
      if (refusal) {
        useStore.getState().showToast(refusal, 'error')
        return
      }
    }
    // 发给模型的业务指令是数据，按 apps/web/AGENTS.md 不随界面语言翻译。
    const instructions: Record<Exclude<EditAction, 'inpaint' | 'erase'>, string> = {
      cutout: '请把 [image 1] 的主体精细抠出，背景透明，保留边缘细节。',
      edit: '请编辑 [image 1]：' + requirement,
      crop: '请裁切 [image 1]，保留主体和关键内容。',
      outpaint: '请扩展 [image 1] 的画面，延续原有风格与环境。',
      resize: '请把 [image 1] 调整为 ' + ratio + ' 构图，保留完整主体。',
    }
    const frameDescription = framing
      ? ` 目标画框相对原图的左上角为 (${Math.round((frame.x / element.width) * 100)}%, ${Math.round((frame.y / element.height) * 100)}%)，宽 ${Math.round((frame.w / element.width) * 100)}%，高 ${Math.round((frame.h / element.height) * 100)}%。`
      : ''
    const instruction =
      instructions[expanded] +
      frameDescription +
      (expanded !== 'edit' && requirement ? ' ' + requirement : '')
    const epoch = sessionEpoch.current
    setBusy(true)
    let sent = false
    try {
      sent = await sendImageEditToAgent(editor, element, instruction, {
        ...(frameMode ? { frame: { mode: frameMode, rect: frame } } : {}),
      })
    } finally {
      if (epoch === sessionEpoch.current) setBusy(false)
    }
    if (sent && epoch === sessionEpoch.current) close()
  }

  return (
    <>
      <div
        role={expanded ? 'dialog' : undefined}
        aria-label={expanded ? t('imageToolbar.aria') : undefined}
        className={
          'absolute z-[430] rounded-xl border border-border bg-card shadow-xl ' +
          (expanded ? 'overflow-y-auto' : '')
        }
        style={{
          left,
          top,
          ...(expanded ? { width, maxHeight: Math.max(80, viewport.height - top - 8) } : {}),
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && expanded) close()
        }}
      >
        <div
          role="toolbar"
          aria-label={t('imageToolbar.aria')}
          className={
            'flex items-center gap-0.5 p-0.5 ' + (expanded ? 'border-b border-border' : '')
          }
        >
          <CanvasToolbarButton
            compact
            icon={<Wand2 />}
            label={t('inpaint.action')}
            reason={paintReason}
            disabled={pending}
            onClick={() => open('inpaint')}
          />
          <CanvasToolbarButton
            compact
            icon={<Eraser />}
            label={t('erase.action')}
            reason={paintReason}
            disabled={pending}
            onClick={() => open('erase')}
          />
          <CanvasToolbarButton
            compact
            icon={<Scissors />}
            label={t('cutout.action')}
            reason={sourceMissing}
            disabled={pending}
            onClick={() => open('cutout')}
          />
          <CanvasToolbarButton
            compact
            icon={<Pencil />}
            label={t('imageEdit.singleAction')}
            reason={sourceMissing}
            disabled={pending}
            onClick={() => open('edit')}
          />
          <CanvasToolbarButton
            compact
            icon={<Crop />}
            label={t('crop.action')}
            reason={sourceMissing}
            disabled={pending}
            onClick={() => open('crop')}
          />
          <CanvasToolbarButton
            compact
            icon={<Expand />}
            label={t('outpaint.action')}
            reason={outpaintReason}
            disabled={pending}
            onClick={() => open('outpaint')}
          />
          <CanvasToolbarButton
            compact
            icon={<Ratio />}
            label={t('resize.action')}
            reason={sourceMissing}
            disabled={pending}
            onClick={() => open('resize')}
          />
          <CanvasToolbarButton
            compact
            icon={<MoreHorizontal />}
            label={t('imageToolbar.more')}
            disabled={pending}
            onClick={(button) => {
              const rect = button.getBoundingClientRect()
              setMenu({ id: element.id, x: rect.left, y: rect.bottom + 4 })
            }}
          />
          {expanded && (
            <button
              type="button"
              aria-label={t('common:action.close')}
              className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
              disabled={pending}
              onClick={close}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {painting && (
          <InpaintPanel
            editor={editor}
            onSendingChange={setBusy}
            onDone={() => {
              if (sessionEpoch.current === panelEpoch) close()
            }}
          />
        )}
        {expanded && !painting && (
          <div className="space-y-3 p-3">
            <h3 className="text-sm font-semibold">{actionTitle[expanded]}</h3>
            {expanded === 'resize' && (
              <div className="flex flex-wrap gap-1.5" aria-label={t('resize.action')}>
                {RATIOS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={ratio === value}
                    className={
                      'rounded-lg border px-2.5 py-1 text-xs ' +
                      (ratio === value
                        ? 'border-primary text-primary'
                        : 'border-border text-muted-foreground')
                    }
                    onClick={() => setRatio(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            )}
            {framing && (
              <p className="text-xs text-muted-foreground">{t('imageToolbar.dragFrame')}</p>
            )}
            <textarea
              autoFocus
              rows={3}
              value={prompt}
              aria-label={t('inpaint.promptAria')}
              placeholder={t('imageToolbar.promptPlaceholder')}
              className={CANVAS_PANEL_FIELD + ' w-full resize-none'}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className={OUTLINE_BUTTON} disabled={pending} onClick={close}>
                {t('common:action.cancel')}
              </button>
              <button
                type="button"
                disabled={
                  pending || (expanded === 'edit' && !prompt.trim()) || (framing && !frameChanged)
                }
                className={PRIMARY_BUTTON}
                onClick={() => void send()}
              >
                {t('imageToolbar.sendToAgent')}
              </button>
            </div>
          </div>
        )}
      </div>
      <CanvasImageMenu menu={menu} doc={doc} onClose={() => setMenu(null)} />
    </>
  )
}
