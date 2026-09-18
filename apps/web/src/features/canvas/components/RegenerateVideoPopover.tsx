import { videoRateMultiplier } from '@image-playground/shared'
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
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import VideoPresetRows from '../../video/components/VideoPresetRows'
import { useVideoStore } from '../../video/store'
import {
  type CanvasVideoNode,
  loadGenerationIntoDraft,
  regenerateCanvasVideo,
  regenerateFrameRefusal,
  regenerateFrames,
} from '../lib/canvasVideoActions'
import type { CanvasEditor } from '../lib/editor'

/**
 * 改参数重新生成一段视频：打开时把它当时的模型、档位载进视频草稿，描述预填当时的提示词，
 * 改完直接提交，结果放在原视频旁边。不经过画布生成栏——开了智能体的部署里没有它。
 */
export default function RegenerateVideoPopover({
  editor,
  node,
  onClose,
}: {
  editor: CanvasEditor
  node: CanvasVideoNode
  onClose: () => void
}) {
  const { t } = useTranslation(['canvas', 'video'])
  const [prompt, setPrompt] = useState(node.userPrompt ?? '')
  const [notes, setNotes] = useState<string[]>([])
  const [keepFrames, setKeepFrames] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const draft = useVideoStore((state) => state.draft)
  const options = videoModelOptions()
  const option = options.find((one) => one.modelId === draft.model)
  const frames = regenerateFrames(editor, node)
  const frameCount = keepFrames ? frames.present.length : 0
  const frameRefusal = regenerateFrameRefusal(frameCount, draft.model)
  // 关掉弹窗就作废还没发出的提交；草稿也还原成打开前的样子（它和导演台共用）。
  const open = useRef(true)
  const submitted = useRef(false)

  // 只在打开时载入一次（按视频身份），之后草稿由用户改。
  useEffect(() => {
    const before = useVideoStore.getState().draft
    useVideoStore.getState().syncModelOptions()
    const found: string[] = []
    const generation = node.video.generation
    if (!generation && node.userPrompt === null) found.push(t('videoToolbar.nothingRecorded'))
    else if (!generation) found.push(t('videoToolbar.noSettingsRecorded'))
    else if (!loadGenerationIntoDraft(generation)) found.push(t('videoToolbar.modelUnavailable'))
    if (generation && node.userPrompt === null) found.push(t('videoToolbar.noPromptRecorded'))
    setNotes(found)
    return () => {
      open.current = false
      if (!submitted.current) useVideoStore.setState({ draft: before })
    }
  }, [node.id])

  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: draft.duration,
    unitMultiplier: videoRateMultiplier(draft.model, draft.resolution),
  })

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      const accepted = await regenerateCanvasVideo(editor, node, prompt, {
        keepFrames,
        isCurrent: () => open.current,
      })
      if (!accepted) return
      submitted.current = true
      useStore.getState().showToast(t('videoToolbar.regenerateSubmitted'), 'success')
      onClose()
    } finally {
      if (open.current) setSubmitting(false)
    }
  }

  return (
    <Overlay onClose={onClose} tier="raised">
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10">
        <h3 className={`${PANEL_TITLE} mb-3`}>{t('videoToolbar.regenerateTitle')}</h3>
        {notes.map((note) => (
          <p key={note} className="mb-2 text-xs text-muted-foreground">
            {note}
          </p>
        ))}
        {frames.recorded.length > 0 && !frames.complete && (
          <p className="mb-2 text-xs text-warning">{t('videoToolbar.framesGoneTextOnly')}</p>
        )}
        {frames.present.length > 0 && (
          <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={keepFrames}
              onChange={(event) => setKeepFrames(event.target.checked)}
            />
            {t('videoToolbar.keepsFrames', { count: frames.present.length })}
          </label>
        )}

        <div className={`${LABEL} mb-1.5`}>{t('video:field.description')}</div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          aria-label={t('video:field.description')}
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
                      {one.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <VideoPresetRows
                support={option.support}
                draft={draft}
                aspectFollowsFirstFrame={frameCount > 0}
              />
            </>
          )}
        </div>

        <div className={`${PANEL_SECTION} mt-4`}>
          {frameRefusal && <p className="mb-1.5 text-[11px] text-destructive">{frameRefusal}</p>}
          {guard.blocked && guard.disabledReason && (
            <p className="mb-1.5 text-[11px] text-destructive">{guard.disabledReason}</p>
          )}
          <SubmissionBillingAction
            blockedAction={guard.blockedAction}
            className="mb-1.5 text-[11px]"
          />
          <button
            type="button"
            disabled={
              guard.blocked || !prompt.trim() || !option || Boolean(frameRefusal) || submitting
            }
            title={guard.disabledReason}
            onClick={() => void submit()}
            className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
          >
            {guard.estimatedCredits === undefined ? (
              t('videoToolbar.regenerate')
            ) : (
              <>
                {t('videoToolbar.regenerate')} · <Credits credits={guard.estimatedCredits} />
              </>
            )}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
