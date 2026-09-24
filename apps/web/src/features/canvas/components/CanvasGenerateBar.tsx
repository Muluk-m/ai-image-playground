import { videoRateMultiplier } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { ChipIcons } from '../../../components/chipIcons'
import ParamControls from '../../../components/ParamControls'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { isVideoModeAvailable, videoModelOptions } from '../../../lib/channels/videoChannels'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { API_MAX_IMAGES, MAX_IMAGE_MB } from '../../../lib/inputImageLimit'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { setAgentComposerFill } from '../../agent/lib/composerFill'
import { useVideoStore } from '../../video/store'
import { useCanvasComposer } from '../composerStore'
import type { CanvasEditor } from '../lib/editor'
import { importImageFiles } from '../lib/importImages'
import { analyzeSelection, rasterizeEntry } from '../lib/rasterizeSelection'
import { submitFromCanvas } from '../lib/submitFromCanvas'
import {
  canvasVideoPromptRefusal,
  canvasVideoSelectionRefusal,
  imageSelection,
  referenceVideoRefusal,
  submitReferenceVideo,
  submitVideoFromCanvas,
} from '../lib/submitVideoFromCanvas'
import { defaultInputItems } from '../lib/videoInputs'
import CanvasVideoParams from './CanvasVideoParams'

/** 部署关了视频（或没有视频 channel）就只剩图片档，记住的选择不作数。 */
function useGenerateMode() {
  const mode = useCanvasComposer((state) => state.mode)
  return isVideoModeAvailable() ? mode : 'image'
}

/** 预览缩略图的栅格化比例：低成本、48px 展示足够清晰。 */
const PREVIEW_SCALE = 0.25
/** 选区变化后延迟生成预览，避免拖选过程中频繁栅格化。 */
const PREVIEW_DEBOUNCE_MS = 250

interface SelectionInfo {
  imageCount: number
  annotated: boolean
  annotationText: string
  /** 条目构成签名：驱动预览重算（图/标注构成不变时不重复栅格化）。 */
  signature: string
}

const EMPTY_SELECTION: SelectionInfo = {
  imageCount: 0,
  annotated: false,
  annotationText: '',
  signature: '',
}

/** 订阅画布变更、维护当前选区分析结果（替代原 tldraw useValue 的响应式选择器）。 */
function useSelectionInfo(editor: CanvasEditor): SelectionInfo {
  const [info, setInfo] = useState(EMPTY_SELECTION)
  useEffect(() => {
    const update = () => {
      const plan = analyzeSelection(editor)
      const next = plan
        ? {
            imageCount: plan.entries.length,
            annotated: plan.annotated,
            annotationText: plan.annotationText,
            signature: plan.entries.map((e) => `${e.imageId}:${e.graphicIds.join('+')}`).join('|'),
          }
        : EMPTY_SELECTION
      // onChange 高频触发：内容不变时保留旧引用，跳过重渲染。
      setInfo((prev) =>
        prev.signature === next.signature &&
        prev.annotationText === next.annotationText &&
        prev.annotated === next.annotated &&
        prev.imageCount === next.imageCount
          ? prev
          : next,
      )
    }
    update()
    return editor.onChange(update)
  }, [editor])
  return info
}

/**
 * 画布底部浮动的生成输入条：统一文生图 / 多图迭代 / 标注迭代入口。
 * - 无选区 → 文生图；选中 N 张图 → 各自栅格化为独立参考图迭代
 * - 画在图上的标注（圈 / 箭头 / 文字）自动跟随被标注的图，无需精确框选
 * - 输入预览：每个将喂给模型的条目一张缩略图（含合成后的标注）+ 提取的文字标注，
 *   与提交共用同一套 analyzeSelection/rasterizeEntry，所见即所得
 * 发起即返回（无全局 busy 锁），任务由画布上的占位框反馈状态，支持并发。
 */
export default function CanvasGenerateBar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation(['canvas', 'common', 'composer', 'agent'])
  const prompt = useCanvasComposer((state) => state.prompt)
  const { setPrompt, setMode } = useCanvasComposer.getState()
  // 输入是这一块画布的：切到别的项目 / 会话（组件随之重建）不能把写了一半的描述带过去。
  useEffect(() => () => useCanvasComposer.getState().setPrompt(''), [])
  const [previews, setPreviews] = useState<string[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const params = useStore((state) => state.params)
  const settings = useStore((state) => state.settings)
  const mode = useGenerateMode()
  const videoDraft = useVideoStore((state) => state.draft)

  // 与提交同一套选区分析：标注自动跟随被标注的图，提示与实际提交一致。
  const { imageCount, annotated, annotationText, signature } = useSelectionInfo(editor)

  // 输入预览缩略图：防抖 + 过期丢弃。
  useEffect(() => {
    if (!signature) {
      setPreviews([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const plan = analyzeSelection(editor)
      if (!plan || cancelled) return
      const thumbs = await Promise.all(
        plan.entries.map((entry) => rasterizeEntry(editor, entry, PREVIEW_SCALE)),
      )
      if (!cancelled) setPreviews(thumbs.filter((url): url is string => url !== null))
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [signature, editor])

  const activeProfile = getActiveApiProfile(settings)
  const video = mode === 'video'
  const submissionInput = video
    ? {
        model: videoDraft.model,
        quantity: videoDraft.duration,
        unitMultiplier: videoRateMultiplier(videoDraft.model, videoDraft.resolution),
      }
    : {
        model: clientProfileToApiProfile(activeProfile).model,
        quantity: Math.max(1, params.n),
      }
  const submissionGuard = usePrivateSubmissionGuard(submissionInput)
  // 选了两张以上、模型又带得了参考图时，选中的图都当参考图（与「选中即参考」同一个门槛、
  // 规则与上限）；一张图或模型带不了时按老规则读成首帧 / 首尾帧。
  const referenceItems =
    video &&
    imageCount >= 2 &&
    videoModelOptions().find((one) => one.modelId === videoDraft.model)?.support.referenceImages
      ? defaultInputItems(imageSelection(editor) ?? [])
      : null
  // 视频档的选区规则（几张图、模型接不接得住）在这里先判，按钮与提示同一个结论。
  const videoRefusal = video
    ? ((referenceItems
        ? referenceVideoRefusal(referenceItems, videoDraft)
        : canvasVideoSelectionRefusal(editor, videoDraft.model)) ??
      canvasVideoPromptRefusal(
        videoDraft.model,
        [annotationText, prompt.trim()].filter(Boolean).join('\n'),
      ))
    : null
  const canSubmit = video
    ? (prompt.trim().length > 0 || annotationText.length > 0) &&
      !videoRefusal &&
      !submissionGuard.blocked
    : (prompt.trim().length > 0 || imageCount > 0) && !submissionGuard.blocked

  // 没选中任何图片时不提示：空选就是文生图 / 文生视频，说出来只是在讲机制。
  const hint = video
    ? (videoRefusal ??
      (referenceItems
        ? t('video.hintReferences', { count: referenceItems.length })
        : imageCount === 0
          ? null
          : imageCount === 1
            ? t('video.hintFirst')
            : t('video.hintFirstLast')))
    : annotated
      ? t('generate.hintAnnotated', { count: imageCount })
      : imageCount > 0
        ? t('generate.hintSelected', { count: imageCount })
        : null

  const run = async () => {
    if (!canSubmit) return
    if (video) {
      // 视频要先过校验与门禁才受理；被拒时保留输入，用户改一下就能再发。
      const submitted = prompt
      const accepted = referenceItems
        ? await submitReferenceVideo(editor, referenceItems, submitted)
        : await submitVideoFromCanvas(editor, submitted)
      if (!accepted) return
      if (useCanvasComposer.getState().prompt === submitted) setPrompt('')
    } else {
      // 发起即返回：不 await，输入条立即恢复可交互（并发语义）。
      void submitFromCanvas(editor, prompt)
      setPrompt('')
    }
    // 焦点还给画布：输入框聚焦时画布快捷键被 isTyping 守卫禁用，
    // 生成发出后用户的下一步通常是画布操作（选图 / 删除 / 复制粘贴）。
    textareaRef.current?.blur()
  }

  // 空状态的示例提示词点一下填进来（没有智能体的部署里，这条输入框就是「那个输入框」）。
  // 只换掉空草稿或上一条原样未动的建议：用户自己写的话一个字都不动。
  const suggestedRef = useRef<string | null>(null)
  useEffect(() =>
    setAgentComposerFill((text) => {
      const current = useCanvasComposer.getState().prompt
      if (current.trim() !== '' && current !== suggestedRef.current) {
        useStore.getState().showToast(t('agent:suggestions.draftKeptToast'), 'info')
        return
      }
      suggestedRef.current = text
      setPrompt(text)
      // 光标放到句末等用户接着写：受控 textarea 这一帧还是旧值，等渲染完再挪。
      window.setTimeout(() => {
        const area = textareaRef.current
        if (!area) return
        area.focus()
        area.setSelectionRange(area.value.length, area.value.length)
      }, 0)
    }),
  )

  // 附件即「放到画布上的参考图」：导入后自动选中，选区随即被当作本次生成的输入。
  const attach = (files: File[]) => {
    // 先按导入本身的准入规则筛一遍（非图片本来就会被丢掉），确认框里的张数才是真会进画布的张数。
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) {
      useStore.getState().showToast(t('import.noneImported'), 'error')
      return
    }
    confirmImageBatch(images.length, () => {
      const bounds = editor.getViewportPageBounds()
      void importImageFiles(editor, images, { x: bounds.midX, y: bounds.midY })
        .then((count) => {
          if (!count) useStore.getState().showToast(t('import.noneImported'), 'error')
        })
        .catch(() => useStore.getState().showToast(t('import.failed'), 'error'))
    })
  }

  return (
    <div className="studio-direct-composer" onPointerDown={(e) => e.stopPropagation()}>
      {video && (
        <div className="pb-3">
          <CanvasVideoParams
            hasFirstFrame={
              !referenceItems &&
              imageCount > 0 &&
              !canvasVideoSelectionRefusal(editor, videoDraft.model)
            }
          />
        </div>
      )}
      {hint && <p className="px-1 pb-2 text-[11px] text-muted-foreground">{hint}</p>}
      <SubmissionBillingAction
        blockedAction={submissionGuard.blockedAction}
        className="px-1 pb-2 text-[11px]"
      />
      {submissionGuard.blocked && submissionGuard.disabledReason ? (
        <p className="px-1 pb-2 text-[11px] text-destructive dark:text-destructive">
          {submissionGuard.disabledReason}
        </p>
      ) : null}
      <div className="studio-direct-card">
        {/* 输入预览：模型将收到的每个参考图条目（含合成后的标注）+ 提取的文字标注。 */}
        {imageCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-1">
            {previews.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={t('generate.inputAlt', { index: i + 1 })}
                className="h-12 w-12 rounded-md border border-border object-cover"
              />
            ))}
            {previews.length === 0 && (
              <span className="text-[11px] text-muted-foreground">
                {t('generate.previewPending')}
              </span>
            )}
            {annotationText && (
              <span className="max-w-[50%] truncate text-[11px] text-warning dark:text-warning">
                {t('generate.annotationHint', { text: annotationText })}
              </span>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void run()
            } else if (e.key === 'Escape') {
              // Esc 退出输入框、焦点还给画布（恢复画布快捷键）。
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          placeholder={video ? t('video.promptPlaceholder') : t('generate.promptPlaceholder')}
          aria-label={t('generate.promptAria')}
          rows={3}
          className="max-h-40 min-h-[4.5rem] w-full resize-none text-sm outline-none"
        />
        {/* 附件 + 参数 chip + 发送同属这张卡：参数跟着输入走，不散在卡外面。
            参数与工作台共用同一份全局 params/settings，数量 n>1 时 fan-out 成 n 个并行任务。 */}
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t('composer:image.attach', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
              aria-label={t('composer:image.attach', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
              className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl border border-input bg-background text-muted-foreground transition-colors duration-150 hover:border-ring/40 hover:bg-accent hover:text-foreground"
            >
              {ChipIcons.imageAttach}
            </button>
            {isVideoModeAvailable() && (
              <Select
                value={mode}
                onValueChange={(value) => setMode(value === 'video' ? 'video' : 'image')}
              >
                <SelectTrigger
                  aria-label={t('generate.modeAria')}
                  className="h-10 w-auto gap-1.5 rounded-xl border-input bg-background px-3 text-xs font-medium"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">{t('generate.modeImage')}</SelectItem>
                  <SelectItem value="video">{t('generate.modeVideo')}</SelectItem>
                </SelectContent>
              </Select>
            )}
            {!video && <ParamControls showCount collapsible />}
          </div>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!canSubmit}
            title={submissionGuard.disabledReason ?? t('common:action.generate')}
            aria-label={t('common:action.generate')}
            className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {ChipIcons.sparkles}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          aria-label={t('composer:image.attach', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])]
            event.currentTarget.value = ''
            attach(files)
          }}
        />
      </div>
    </div>
  )
}
