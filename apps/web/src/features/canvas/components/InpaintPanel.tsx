import { Brush, Eraser, Undo2, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import Credits from '../../../components/Credits'
import {
  ACTIVE_SEGMENT,
  FIELD,
  IDLE_SEGMENT,
  LABEL,
  OUTLINE_BUTTON,
  PANEL_TITLE,
  PRIMARY_BUTTON,
  SEGMENT,
} from '../../../components/panelStyles'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { compressInputImageDataUrls } from '../../../lib/compressInputImage'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { MAX_BRUSH_PX, MIN_BRUSH_PX, useInpaintSession } from '../inpaintStore'
import type { CanvasEditor } from '../lib/editor'
import { fileToDataUrl } from '../lib/importImages'
import { submitCanvasInpaint } from '../lib/submitInpaint'

/**
 * 局部重绘的操作面板。**不是模态**（不走 Overlay）：用户要一边看着画布涂抹一边写描述，
 * 罩住画布就没法用了。它只占画布底部一条，左侧工具条与右下小地图各有自己的列，互不压。
 */
export default function InpaintPanel({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation(['canvas', 'common'])
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
      aria-label={t('inpaint.title')}
      className="absolute bottom-4 left-1/2 z-[430] w-[min(30rem,calc(100%-6rem))] -translate-x-1/2 rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className={PANEL_TITLE}>{t(erasing ? 'erase.title' : 'inpaint.title')}</h3>
        <button
          type="button"
          aria-label={t('common:action.close')}
          className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={session.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <div
          role="radiogroup"
          aria-label={t('inpaint.toolAria')}
          className="flex gap-1 rounded-lg bg-muted p-1"
        >
          {(['brush', 'eraser'] as const).map((tool) => (
            <button
              key={tool}
              type="button"
              role="radio"
              aria-checked={session.tool === tool}
              className={`${SEGMENT} inline-flex items-center gap-1 ${session.tool === tool ? ACTIVE_SEGMENT : IDLE_SEGMENT}`}
              onClick={() => session.setTool(tool)}
            >
              {tool === 'brush' ? (
                <Brush className="h-3.5 w-3.5" />
              ) : (
                <Eraser className="h-3.5 w-3.5" />
              )}
              {t(`inpaint.tool.${tool}`)}
            </button>
          ))}
        </div>
        <label className="flex flex-1 items-center gap-2">
          <span className={LABEL}>{t('inpaint.brushSize')}</span>
          <input
            type="range"
            min={MIN_BRUSH_PX}
            max={MAX_BRUSH_PX}
            value={session.brushPx}
            className="w-full accent-primary"
            onChange={(event) => session.setBrushPx(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={!painted}
          aria-label={t('inpaint.undo')}
          title={t('inpaint.undo')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          onClick={session.undo}
        >
          <Undo2 className="h-4 w-4" />
        </button>
      </div>

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
            className={`${FIELD} flex-1 resize-none`}
            onChange={(event) => session.setPrompt(event.target.value)}
          />
        </div>
      )}

      <p className="mb-2 text-[11px] text-muted-foreground">
        {painted
          ? erasing
            ? t('erase.continueHint')
            : ''
          : t(erasing ? 'erase.paintFirst' : 'inpaint.paintFirst')}
      </p>
      {guard.blocked && guard.disabledReason && (
        <p className="mb-1.5 text-[11px] text-destructive">{guard.disabledReason}</p>
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
            disabled={pending || !painted || guard.blocked || (!erasing && !session.prompt.trim())}
            title={guard.disabledReason}
            className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
            onClick={() => void submit()}
          >
            {guard.estimatedCredits === undefined ? (
              t(erasing ? 'erase.submit' : 'inpaint.submit')
            ) : (
              <>
                {t(erasing ? 'erase.submit' : 'inpaint.submit')} ·{' '}
                <Credits credits={guard.estimatedCredits} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
