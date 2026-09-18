import { videoRateMultiplier } from '@image-playground/shared'
import { ArrowUp, GripVertical } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Credits from '../../../components/Credits'
import Overlay from '../../../components/Overlay'
import {
  FIELD,
  LABEL,
  PANEL_SECTION,
  PANEL_TITLE,
  PRIMARY_BUTTON,
} from '../../../components/panelStyles'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import VideoPresetRows from '../../video/components/VideoPresetRows'
import { useVideoStore } from '../../video/store'
import type { CanvasEditor } from '../lib/editor'
import type { CanvasInputEntry } from '../lib/rasterizeSelection'
import { referenceVideoRefusal, submitReferenceVideo } from '../lib/submitVideoFromCanvas'
import {
  defaultInputItems,
  moveInputItem,
  setInputRole,
  type VideoInputRole,
} from '../lib/videoInputs'

/**
 * 选中即参考：选中的几张图按画布从左到右列出，可拖动排序，每张标成首帧、尾帧或参考图，
 * 填描述、选参数、看报价后生成。占位落在这些图右侧。草稿与生成栏共用，关掉没提交就还原。
 */
export default function ReferenceVideoPopover({
  editor,
  entries,
  onClose,
}: {
  editor: CanvasEditor
  entries: readonly CanvasInputEntry[]
  onClose: () => void
}) {
  const { t } = useTranslation(['canvas', 'video'])
  const [items, setItems] = useState(() => defaultInputItems(entries))
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const draft = useVideoStore((state) => state.draft)
  const options = videoModelOptions()
  const option = options.find((one) => one.modelId === draft.model)
  const refusal = referenceVideoRefusal(items, draft)
  const open = useRef(true)
  const submitted = useRef(false)

  // 打开时对齐可用模型；当前模型不接参考图就换到第一个接的，关掉没提交就把草稿还原。
  useEffect(() => {
    const before = useVideoStore.getState().draft
    const video = useVideoStore.getState()
    video.syncModelOptions()
    const current = videoModelOptions().find((one) => one.modelId === video.draft.model)
    const withReferences = videoModelOptions().find((one) => one.support.referenceImages)
    if (!current?.support.referenceImages && withReferences)
      useVideoStore.getState().setModel(withReferences.modelId)
    return () => {
      open.current = false
      if (!submitted.current) useVideoStore.setState({ draft: before })
    }
  }, [])

  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: draft.duration,
    unitMultiplier: videoRateMultiplier(draft.model, draft.resolution),
  })

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      if (!(await submitReferenceVideo(editor, items, prompt))) return
      submitted.current = true
      useStore.getState().showToast(t('referenceVideo.submitted'), 'success')
      onClose()
    } finally {
      if (open.current) setSubmitting(false)
    }
  }

  const roleLabel = (role: VideoInputRole) => t(`referenceVideo.role.${role}`)
  const hasFrames = items.some((item) => item.role !== 'reference')

  return (
    <Overlay onClose={onClose} tier="raised">
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10">
        <h3 className={`${PANEL_TITLE} mb-1`}>
          {t('referenceVideo.title', { count: items.length })}
        </h3>
        <p className="mb-3 text-xs text-muted-foreground">{t('referenceVideo.hint')}</p>

        <ol aria-label={t('referenceVideo.listAria')} className="mb-3 flex flex-col gap-1.5">
          {items.map((item, index) => (
            <li
              key={item.entry.imageId}
              draggable
              data-input-id={item.entry.imageId}
              onDragStart={() => setDragging(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null && dragging !== index)
                  setItems((current) => moveInputItem(current, dragging, index))
                setDragging(null)
              }}
              onDragEnd={() => setDragging(null)}
              className={`flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 ${dragging === index ? 'opacity-50' : ''}`}
            >
              <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />
              <span className="w-10 shrink-0 text-xs text-muted-foreground">
                {t('referenceVideo.imageLabel', { no: index + 1 })}
              </span>
              <InputThumb editor={editor} imageId={item.entry.imageId} />
              {/* 拖动之外给键盘一条路：往前挪一位。 */}
              <button
                type="button"
                aria-label={t('referenceVideo.moveUp', { no: index + 1 })}
                disabled={index === 0}
                onClick={() => setItems((current) => moveInputItem(current, index, index - 1))}
                className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <Select
                value={item.role}
                onValueChange={(role) =>
                  setItems((current) => setInputRole(current, index, role as VideoInputRole))
                }
              >
                <SelectTrigger
                  aria-label={t('referenceVideo.roleAria', { no: index + 1 })}
                  className="h-8 w-auto gap-1.5 rounded-full border-0 bg-muted px-2.5 text-xs"
                >
                  <SelectValue>{roleLabel(item.role)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reference">{roleLabel('reference')}</SelectItem>
                  <SelectItem value="first">{roleLabel('first')}</SelectItem>
                  <SelectItem value="last">{roleLabel('last')}</SelectItem>
                </SelectContent>
              </Select>
            </li>
          ))}
        </ol>

        <div className={`${LABEL} mb-1.5`}>{t('video:field.description')}</div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          aria-label={t('video:field.description')}
          placeholder={t('referenceVideo.placeholder')}
          className={`${FIELD} resize-none`}
        />

        <div className="mt-3 flex flex-col gap-2">
          {option && (
            <>
              <Select
                value={draft.model}
                onValueChange={(model) => useVideoStore.getState().setModel(model)}
              >
                <SelectTrigger
                  aria-label={t('video:field.model')}
                  className="h-8 w-auto gap-1.5 self-start rounded-full border-0 bg-muted px-2.5 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((one) => (
                    <SelectItem key={one.modelId} value={one.modelId}>
                      {one.support.referenceImages
                        ? one.label
                        : t('referenceVideo.modelWithoutReferences', { label: one.label })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <VideoPresetRows
                support={option.support}
                draft={draft}
                aspectFollowsFirstFrame={hasFrames}
              />
            </>
          )}
        </div>

        <div className={`${PANEL_SECTION} mt-4`}>
          {refusal && (
            <p role="alert" className="mb-1.5 text-[11px] text-destructive">
              {refusal}
            </p>
          )}
          {guard.blocked && guard.disabledReason && (
            <p className="mb-1.5 text-[11px] text-destructive">{guard.disabledReason}</p>
          )}
          <SubmissionBillingAction
            blockedAction={guard.blockedAction}
            className="mb-1.5 text-[11px]"
          />
          <button
            type="button"
            disabled={guard.blocked || !prompt.trim() || Boolean(refusal) || submitting}
            title={guard.disabledReason}
            onClick={() => void submit()}
            className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
          >
            {guard.estimatedCredits === undefined ? (
              t('referenceVideo.submit')
            ) : (
              <>
                {t('referenceVideo.submit')} · <Credits credits={guard.estimatedCredits} />
              </>
            )}
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/** 面板里的缩略图。云端项目的图存的是媒体标识，要先换成可读地址。 */
function InputThumb({ editor, imageId }: { editor: CanvasEditor; imageId: string }) {
  const element = editor.getElement(imageId)
  const source = element?.type === 'image' ? editor.doc.files[element.fileId] : undefined
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!source) return
    let cancelled = false
    void resolveMediaSource(source, 'preview')
      .then((resolved) => {
        if (!cancelled) setSrc(resolved)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [source])
  return src ? (
    <img src={src} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
  ) : (
    <span className="h-10 w-10 shrink-0 rounded-md bg-muted" />
  )
}
