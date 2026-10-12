import { useRef, useState, useSyncExternalStore } from 'react'
import { LABEL, PANEL_TITLE } from '../../../components/panelStyles'
import RegionPromptEditor, { useRegionPrompt } from '../../../components/RegionPromptEditor'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { compressInputImageDataUrls } from '../../../lib/compressInputImage'
import { MAX_BRUSH_PX, MIN_BRUSH_PX, useInpaintSession } from '../inpaintStore'
import type { CanvasEditor } from '../lib/editor'
import { fileToDataUrl } from '../lib/importImages'
import { maskStrokeRegion } from '../lib/inpaintMask'
import { sendImageEditToAgent } from '../lib/sendImageEditToAgent'

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

  const regionPrompt = useRegionPrompt({
    ids: session.kind === 'inpaint' ? session.strokeIds : [],
    value: session.prompt,
    onChange: session.setPrompt,
    onRemove: (id) => session.removeStroke(session.strokeIds.indexOf(id)),
  })
  if (!session.imageId) return null
  const painted = session.strokes.length > 0
  // 擦除没有「改成什么」：描述与参考图由固定指令代替，面板只剩画笔与完成。
  const erasing = session.kind === 'erase'
  const element = editor.getElement(session.imageId)
  const image = element?.type === 'image' ? element : null

  const submit = async () => {
    if (
      pendingRef.current ||
      !image ||
      !painted ||
      regionPrompt.hasMissing ||
      (!erasing && !regionPrompt.hasProse)
    )
      return
    pendingRef.current = true
    onSendingChange(true)
    setPending(true)
    let sent = false
    try {
      const instruction = erasing
        ? '请移除 [image 1] 中标记区域内的内容，用周围背景自然填补；未标记区域保持不变。'
        : `请只修改 [image 1] 中标记的区域：${regionPrompt.serialize().trim()}。未标记区域保持不变。`
      sent = await sendImageEditToAgent(editor, image, instruction, {
        strokes: session.strokes,
        ...(!erasing
          ? {
              regions: session.strokes.map((stroke, index) =>
                maskStrokeRegion(image, stroke, regionPrompt.numberFor(session.strokeIds[index]!)),
              ),
            }
          : {}),
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
          {!erasing && <Icon name="wand" className="text-primary" />}
          {t(erasing ? 'erase.title' : 'inpaint.title')}
        </h3>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t('inpaint.toolAria')} className="flex gap-1">
          {(erasing ? (['brush', 'eraser'] as const) : (['rect', 'brush'] as const)).map((tool) => (
            <Button
              key={tool}
              type="button"
              size="sm"
              variant={session.tool === tool ? 'default' : 'outline'}
              role="radio"
              aria-checked={session.tool === tool}
              onClick={() => session.setTool(tool)}
            >
              <Icon name={tool === 'rect' ? 'shape' : tool === 'brush' ? 'brush' : 'erase'} />
              {t(`inpaint.tool.${tool}`)}
            </Button>
          ))}
        </div>
        {session.tool !== 'rect' && (
          <label className="flex min-w-24 flex-1 items-center gap-2">
            <span className={`${LABEL} shrink-0 whitespace-nowrap`}>{t('inpaint.brushSize')}</span>
            <Slider
              min={MIN_BRUSH_PX}
              max={MAX_BRUSH_PX}
              value={[session.brushPx]}
              aria-label={t('inpaint.brushSize')}
              className="w-full"
              onValueChange={([value]) => {
                if (value !== undefined) session.setBrushPx(value)
              }}
            />
          </label>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!painted}
          aria-label={t('inpaint.undo')}
          title={t('inpaint.undo')}
          className="ml-auto shrink-0 text-muted-foreground"
          onClick={session.undo}
        >
          <Icon name="undo" />
        </Button>
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
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                aria-label={t('inpaint.removeReference')}
                className="absolute -right-1.5 -top-1.5"
                onClick={() => session.setReference(null)}
              >
                <Icon name="close" />
              </Button>
            </div>
          )}
          <RegionPromptEditor
            prompt={regionPrompt}
            label={t('inpaint.promptAria')}
            placeholder={t('inpaint.promptPlaceholder')}
            disabled={pending}
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload" />
            {t('inpaint.uploadReference')}
          </Button>
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
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onDone}>
            {t('common:action.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={
              pending ||
              !painted ||
              !image ||
              regionPrompt.hasMissing ||
              (!erasing && !regionPrompt.hasProse)
            }
            onClick={() => void submit()}
          >
            {t('imageToolbar.sendToAgent')}
          </Button>
        </div>
      </div>
    </div>
  )
}
