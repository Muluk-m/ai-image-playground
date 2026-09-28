import { Brush, Eraser, Scan, Undo2, Upload, Wand2, X } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { LABEL, OUTLINE_BUTTON, PANEL_TITLE, PRIMARY_BUTTON } from '../../../components/panelStyles'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { compressInputImageDataUrls } from '../../../lib/compressInputImage'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { MAX_BRUSH_PX, MIN_BRUSH_PX, useInpaintSession } from '../inpaintStore'
import type { CanvasEditor } from '../lib/editor'
import { canvasImageDimensions } from '../lib/imageInfo'
import { fileToDataUrl } from '../lib/importImages'
import { inpaintRefusal, submitCanvasInpaint } from '../lib/submitInpaint'
import { CANVAS_PANEL_FIELD } from './canvasPanelStyles'

/** 智能改图浮层保持画布可操作；所有编号区域共同组成一次原生遮罩提交。 */
export default function InpaintPanel({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation(['canvas', 'common'])
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const session = useInpaintSession()
  const settings = useStore((state) => state.settings)
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: 1,
  })

  if (!session.imageId) return null
  const painted = session.strokes.length > 0
  // 擦除没有「改成什么」：描述与参考图由固定指令代替，面板只剩画笔与完成。
  const erasing = session.kind === 'erase'
  const element = editor.getElement(session.imageId)
  const refusal =
    element?.type === 'image'
      ? inpaintRefusal(element, canvasImageDimensions(element, editor.doc), settings)
      : t('inpaint.sourceGone')

  const submit = async () => {
    if (pending || !session.imageId) return
    setPending(true)
    try {
      const started = await submitCanvasInpaint(editor, {
        imageId: session.imageId,
        strokes: session.strokes,
        kind: session.kind,
        prompt: session.prompt,
        ...(session.reference ? { referenceDataUrl: session.reference.dataUrl } : {}),
      })
      if (started) session.close()
    } finally {
      setPending(false)
    }
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
    <div
      role="dialog"
      aria-label={t(erasing ? 'erase.title' : 'inpaint.title')}
      className="absolute bottom-4 left-1/2 z-[430] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className={`${PANEL_TITLE} inline-flex items-center gap-1.5`}>
          {!erasing && <Wand2 className="h-4 w-4 text-[#159cf6]" />}
          {t(erasing ? 'erase.title' : 'inpaint.title')}
        </h3>
        <button
          type="button"
          aria-label={t('common:action.close')}
          className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={session.close}
        >
          <X className="h-4 w-4" />
        </button>
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
      {(refusal || (guard.blocked && guard.disabledReason)) && (
        <p className="mb-1.5 text-xs text-destructive">{refusal || guard.disabledReason}</p>
      )}
      <SubmissionBillingAction blockedAction={guard.blockedAction} className="mb-1.5 text-[11px]" />

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
          <button type="button" className={OUTLINE_BUTTON} onClick={session.close}>
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            disabled={
              pending ||
              !painted ||
              Boolean(refusal) ||
              guard.blocked ||
              (!erasing && !session.prompt.trim())
            }
            title={refusal || guard.disabledReason}
            className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
            onClick={() => void submit()}
          >
            {t(erasing ? 'erase.submit' : 'inpaint.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
