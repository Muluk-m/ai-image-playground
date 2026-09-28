import { Brush, Eraser, Scan, Undo2, Upload, Wand2, X } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { LABEL, OUTLINE_BUTTON, PANEL_TITLE, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useTranslation } from '../../../i18n'
import { compressInputImageDataUrls } from '../../../lib/compressInputImage'
import { MAX_BRUSH_PX, MIN_BRUSH_PX, useInpaintSession } from '../inpaintStore'
import type { CanvasEditor } from '../lib/editor'
import { fileToDataUrl } from '../lib/importImages'
import { sendImageEditToAgent } from '../lib/sendImageEditToAgent'
import { CANVAS_PANEL_FIELD } from './canvasPanelStyles'

/** 图片快捷菜单展开后的区域标记与要求输入。 */
export default function InpaintPanel({
  editor,
  onDone,
  onSendingChange,
}: {
  editor: CanvasEditor
  onDone: () => void
  onSendingChange: (sending: boolean) => void
}) {
  const { t } = useTranslation(['canvas', 'common'])
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const session = useInpaintSession()
  const fileRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)

  if (!session.imageId) return null
  const painted = session.strokes.length > 0
  // 擦除没有「改成什么」：描述与参考图由固定指令代替，面板只剩画笔与完成。
  const erasing = session.kind === 'erase'
  const element = editor.getElement(session.imageId)
  const image = element?.type === 'image' ? element : null

  const submit = async () => {
    if (pendingRef.current || !image) return
    pendingRef.current = true
    onSendingChange(true)
    setPending(true)
    let sent = false
    try {
      const instruction = erasing
        ? '请移除 [image 1] 中标记区域内的内容，用周围背景自然填补；未标记区域保持不变。'
        : `请只修改 [image 1] 中标记的区域：${session.prompt.trim()}。未标记区域保持不变。`
      sent = await sendImageEditToAgent(editor, image, instruction, {
        strokes: session.strokes,
        ...(session.reference ? { referenceDataUrl: session.reference.dataUrl } : {}),
      })
    } finally {
      pendingRef.current = false
      onSendingChange(false)
      setPending(false)
    }
    if (sent) onDone()
  }

  const pickReference = async (file: File | undefined) => {
    if (!file) return
    const dataUrl = await fileToDataUrl(file)
    // 带遮罩的请求在分发层刻意跳过输入图压缩（遮罩要与主图同尺寸），
    // 所以参考图得自己压一次，别把一张 20MB 的原图整个推上去。
    const [compressed] = await compressInputImageDataUrls([dataUrl])
    session.setReference({ dataUrl: compressed ?? dataUrl, name: file.name })
  }

  return (
    <div className="p-3">
      <div className="mb-2">
        <h3 className={`${PANEL_TITLE} inline-flex items-center gap-1.5`}>
          {!erasing && <Wand2 className="h-4 w-4 text-[#159cf6]" />}
          {t(erasing ? 'erase.title' : 'inpaint.title')}
        </h3>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t('inpaint.toolAria')} className="flex gap-1">
          {(erasing ? (['brush', 'eraser'] as const) : (['rect', 'brush'] as const)).map((tool) => (
            <button
              key={tool}
              type="button"
              role="radio"
              aria-checked={session.tool === tool}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition ${session.tool === tool && !erasing ? 'border-[#159cf6] bg-[#159cf6]/10 text-[#159cf6]' : session.tool === tool ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              onClick={() => session.setTool(tool)}
            >
              {tool === 'rect' ? (
                <Scan className="h-3.5 w-3.5" />
              ) : tool === 'brush' ? (
                <Brush className="h-3.5 w-3.5" />
              ) : (
                <Eraser className="h-3.5 w-3.5" />
              )}
              {t(`inpaint.tool.${tool}`)}
            </button>
          ))}
        </div>
        {session.tool !== 'rect' && (
          <label className="flex min-w-24 flex-1 items-center gap-2">
            <span className={`${LABEL} shrink-0 whitespace-nowrap`}>{t('inpaint.brushSize')}</span>
            <input
              type="range"
              min={MIN_BRUSH_PX}
              max={MAX_BRUSH_PX}
              value={session.brushPx}
              className="w-full accent-primary"
              onChange={(event) => session.setBrushPx(Number(event.target.value))}
            />
          </label>
        )}
        <button
          type="button"
          disabled={!painted}
          aria-label={t('inpaint.undo')}
          title={t('inpaint.undo')}
          className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          onClick={session.undo}
        >
          <Undo2 className="h-4 w-4" />
        </button>
      </div>

      {!erasing && (
        <div
          className="mb-2 flex min-h-7 flex-wrap items-center gap-1.5"
          aria-label={t('inpaint.regions')}
        >
          {session.strokes.map((stroke, index) => (
            <div
              key={`${index}-${stroke.points[0]?.x}`}
              className={`inline-flex items-center rounded-full border text-xs ${session.selectedStroke === index ? 'border-[#159cf6] bg-[#159cf6]/15 text-[#8bd1ff]' : 'border-border bg-muted/60 text-muted-foreground'}`}
            >
              <button
                type="button"
                aria-pressed={session.selectedStroke === index}
                className="min-h-7 rounded-l-full pl-2.5 pr-1"
                onClick={() => session.selectStroke(index)}
              >
                {stroke.shape === 'rect' ? '▧' : '✎'} {t('inpaint.regionName', { no: index + 1 })}
              </button>
              <button
                type="button"
                aria-label={t('inpaint.removeRegion', { no: index + 1 })}
                className="grid h-7 w-7 place-items-center rounded-r-full hover:bg-[#159cf6]/10"
                onClick={() => session.removeStroke(index)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {!painted && (
            <span className="text-xs text-muted-foreground">{t('inpaint.paintFirst')}</span>
          )}
        </div>
      )}

      {!erasing && (
        <div className="mb-2 flex items-start gap-2">
          {session.reference && (
            <div className="relative shrink-0">
              <img
                src={session.reference.dataUrl}
                alt={session.reference.name}
                className="h-16 w-16 rounded-lg object-cover"
              />
              <button
                type="button"
                aria-label={t('inpaint.removeReference')}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-foreground text-background"
                onClick={() => session.setReference(null)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <textarea
            rows={2}
            value={session.prompt}
            aria-label={t('inpaint.promptAria')}
            placeholder={t('inpaint.promptPlaceholder')}
            className={`${CANVAS_PANEL_FIELD} flex-1 resize-none`}
            onChange={(event) => session.setPrompt(event.target.value)}
          />
        </div>
      )}

      {erasing && (
        <p className="mb-2 text-xs text-muted-foreground">
          {t(painted ? 'erase.continueHint' : 'erase.paintFirst')}
        </p>
      )}
      {!image && <p className="mb-1.5 text-xs text-destructive">{t('inpaint.sourceGone')}</p>}

      <div className="flex items-center justify-between gap-2">
        {erasing ? (
          <span />
        ) : (
          <button type="button" className={OUTLINE_BUTTON} onClick={() => fileRef.current?.click()}>
            <span className="inline-flex items-center gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              {t('inpaint.uploadReference')}
            </span>
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            void pickReference(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <div className="flex items-center gap-2">
          <button type="button" className={OUTLINE_BUTTON} disabled={pending} onClick={onDone}>
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            disabled={pending || !painted || !image || (!erasing && !session.prompt.trim())}
            className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
            onClick={() => void submit()}
          >
            {t('imageToolbar.sendToAgent')}
          </button>
        </div>
      </div>
    </div>
  )
}
