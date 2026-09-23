import type { AgentSkillSummary } from '@image-playground/shared'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AgentSkillBadge from '../features/agent/components/AgentSkillBadge'
import { getLeadingAgentSkill } from '../features/agent/lib/agentSkillMentions'
import { startCanvasFromComposer } from '../features/agent/lib/heroHandoff'
import { useAgentSkills } from '../features/agent/lib/useAgentSkills'
import AssetHint from '../features/library/components/AssetHint'
import { applyLookToComposer, useActiveLook } from '../features/library/lib/activeLook'
import {
  type AtMentionValue,
  buildAtMentionGroups,
  getAssetNamesByImageId,
} from '../features/library/lib/assetMentions'
import { checkLookSubmission, submitWithLook } from '../features/library/lib/lookSubmit'
import { buildTemplateMenuGroups, getSlashTemplateQuery } from '../features/library/lib/templates'
import { useLibraryStore } from '../features/library/store'
import { useImageInputScope } from '../hooks/useImageInputScope'
import { usePasteImageFiles } from '../hooks/usePasteImageFiles'
import { describeError, useTranslation } from '../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../lib/apiProfiles'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { getSafeBoundingClientRect } from '../lib/domRect'
import { downloadImagesByIds } from '../lib/downloadImages'
import { API_MAX_IMAGES, MAX_IMAGE_MB } from '../lib/inputImageLimit'
import { createLongPress } from '../lib/longPress'
import { getChangedParams, normalizeParamsForSettings } from '../lib/paramCompatibility'
import { usePrivateSubmissionGuard } from '../lib/privateOverlay'
import { referenceAdmission, referenceRefusalMessage } from '../lib/referenceDraft'
import {
  getContentEditableCursor,
  getContentEditablePlainText,
  getContentEditableSelection,
  setContentEditableCursor,
  setContentEditableSelection,
  syncMentionTagSelection,
} from '../lib/promptEditorDom'
import { buildPromptEditorHtml } from '../lib/promptEditorHtml'
import { computePromptHeight } from '../lib/promptHeight'
import {
  createMentionLabels,
  getAtImageQuery,
  getPromptIndexFromVisibleIndex,
  getPromptMentionParts,
  getVisiblePrompt,
  insertImageMentionAtVisibleRange,
  isCursorInSelectedImageMention,
  type MentionLabelResolver,
} from '../lib/promptImageMentions'
import { getPromptSlotNames, getSubmissionImageCount } from '../lib/promptSlots'
import {
  removeMultipleTasks,
  storeImageFromFile,
  submitTask,
  updateTaskInStore,
  useStore,
} from '../store'
import type { InputImage } from '../types'
import ContextMenu, { ContextMenuItem } from './ContextMenu'
import { ChipIcons } from './chipIcons'
import { BookmarkIcon, CloseIcon, LibraryIcon, LinkIcon, MaskBrushIcon } from './icons'
import LookChips, { LookCapsule } from './LookChips'
import ParamControls from './ParamControls'
import SlotValuePopover from './SlotValuePopover'
import SubmissionBillingAction from './SubmissionBillingAction'
import SuggestionMenu, { useSuggestionMenu } from './SuggestionMenu'
import ViewportTooltip from './ViewportTooltip'

const TEXTAREA_CLASS =
  'min-h-[42px] w-full whitespace-pre-wrap break-words bg-transparent px-1 py-1 pr-9 text-sm leading-relaxed outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] text-foreground'

/** 通用悬浮气泡提示 */
function ButtonTooltip({ visible, text }: { visible: boolean; text: ReactNode }) {
  if (!visible) return null

  return (
    <ViewportTooltip visible className="z-10 whitespace-nowrap">
      {text}
    </ViewportTooltip>
  )
}

const SAVE_TEMPLATE_BUTTON_CLASS =
  'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border/80 bg-card/70 text-muted-foreground transition-colors duration-150 hover:border-border/80 hover:bg-card disabled:cursor-not-allowed disabled:border-border/60 disabled:bg-muted/60 disabled:text-foreground dark:hover:border-white/[0.20] dark:disabled:border-white/[0.08]'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

/** `inline`：首屏那一版——不吸底，跟着 hero 排在流里，卡面换成带发光描边的大卡。 */
export default function InputBar({ inline = false }: { inline?: boolean } = {}) {
  const { t, i18n } = useTranslation(['composer', 'common'])
  const prompt = useStore((s) => s.prompt)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const settings = useStore((s) => s.settings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setAppMode = useStore((s) => s.setAppMode)
  const startNamingAsset = useLibraryStore((s) => s.startNaming)
  const startNamingTemplate = useLibraryStore((s) => s.startNamingTemplate)
  const assets = useLibraryStore((s) => s.assets)
  const loadAssets = useLibraryStore((s) => s.loadAssets)
  const attachAsset = useLibraryStore((s) => s.attachAsset)
  const templates = useLibraryStore((s) => s.templates)
  const loadTemplates = useLibraryStore((s) => s.loadTemplates)
  const applyTemplate = useLibraryStore((s) => s.applyTemplate)
  const slotValues = useStore((s) => s.slotValues)
  const setSlotValues = useStore((s) => s.setSlotValues)
  const maskDraft = useStore((s) => s.maskDraft)
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const moveInputImage = useStore((s) => s.moveInputImage)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const imagesRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(42)

  const [isDragging, setIsDragging] = useState(false)
  const [submitHover, setSubmitHover] = useState(false)
  const [attachHover, setAttachHover] = useState(false)
  const [compressionHintVisible, setCompressionHintVisible] = useState(false)
  const [sizeHintVisible, setSizeHintVisible] = useState(false)
  const [qualityHintVisible, setQualityHintVisible] = useState(false)
  const [imageHintId, setImageHintId] = useState<string | null>(null)
  const [mobileCollapsed, setMobileCollapsed] = useState(false)
  // 整张输入卡片折叠：折叠后只剩 mini bar（prompt 摘要 + 生成 + 展开按钮），让背景任务卡片露出来。
  const [barCollapsed, setBarCollapsed] = useState(false)
  const [maskPreviewUrl, setMaskPreviewUrl] = useState('')
  const [thumbMenu, setThumbMenu] = useState<{
    index: number
    imageId: string
    x: number
    y: number
  } | null>(null)
  const [imageDragIndex, setImageDragIndex] = useState<number | null>(null)
  const [imageDragOverIndex, setImageDragOverIndex] = useState<number | null>(null)
  const [touchDragPreview, setTouchDragPreview] = useState<{
    src: string
    x: number
    y: number
  } | null>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const dragTouchRef = useRef({ startY: 0, moved: false })
  const imageDragIndexRef = useRef<number | null>(null)
  const imageTouchDragRef = useRef({
    index: null as number | null,
    startX: 0,
    startY: 0,
    moved: false,
  })
  const imageDragOverIndexRef = useRef<number | null>(null)
  const imageDragPreviewRef = useRef<HTMLElement | null>(null)
  const suppressImageClickRef = useRef(false)
  const thumbLongPressTargetRef = useRef<{ index: number; imageId: string } | null>(null)
  const thumbLongPress = useMemo(
    () =>
      createLongPress(({ x, y }) => {
        const target = thumbLongPressTargetRef.current
        if (!target) return
        suppressImageClickRef.current = true
        setThumbMenu({ index: target.index, imageId: target.imageId, x, y })
      }),
    [],
  )
  useEffect(() => () => thumbLongPress.cancel(), [thumbLongPress])
  const lastTypedRef = useRef<string | null>(null)
  const imageHintLockedRef = useRef(false)
  const imageHintReleaseRef = useRef<(() => void) | null>(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [openSlot, setOpenSlot] = useState<{ name: string; left: number } | null>(null)
  const [menuLeft, setMenuLeft] = useState(0)
  const maskConflictNoticeShownRef = useRef(false)
  const compressionHintTimerRef = useRef<number | null>(null)
  const sizeHintTimerRef = useRef<number | null>(null)
  const qualityHintTimerRef = useRef<number | null>(null)
  const imageHintTimerRef = useRef<number | null>(null)
  const dragCounter = useRef(0)
  const isMobile = useIsMobile()

  const activeProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeView = clientProfileToApiProfile(activeProfile)
  const hasSubmitApiConfig = activeProfile.source === 'builtin-edge' || Boolean(activeView.apiKey)
  const submitImageCount = getSubmissionImageCount(prompt, slotValues, params.n)
  const generateLabel =
    submitImageCount > 1
      ? t('submit.generateCount', { count: submitImageCount })
      : t('common:action.generate')
  const submissionInput = { model: activeView.model, quantity: submitImageCount }
  const submissionGuard = usePrivateSubmissionGuard(submissionInput)
  // 生成模式挂着模板胶囊时：素材条数要与素材位对上，提交走模板组装。画布档不管它（那是智能体的事）。
  const activeLook = useActiveLook((s) => s.look)
  const libraryAssets = useLibraryStore((s) => s.assets)
  const lookCheck = useMemo(
    () => (activeLook ? checkLookSubmission(activeLook, inputImages, libraryAssets) : null),
    [activeLook, inputImages, libraryAssets],
  )
  const lookBody = activeLook?.record?.body ?? activeLook?.skill?.template?.body ?? ''
  const canSubmit = Boolean(
    (prompt.trim() || activeLook) &&
      hasSubmitApiConfig &&
      !submissionGuard.blocked &&
      (lookCheck?.ok ?? true),
  )
  // 首屏「画布」档：这句话不直接出图，交给一个新建的画布项目当第一轮。走智能体，不看出图的 API 配置。
  const createTarget = useStore((s) => s.createTarget)
  const toCanvas = inline && createTarget === 'canvas'
  const apiReady = toCanvas || hasSubmitApiConfig
  const submitReady = toCanvas ? Boolean(prompt.trim()) : canSubmit
  const submit = () => {
    if (toCanvas) void startCanvasFromComposer()
    else if (activeLook) void submitWithLook(activeLook, lookBody)
    else submitTask()
  }
  const submitLabel = toCanvas ? t('submit.startCanvas') : generateLabel
  // 参考图入口按附图那条准入规则显隐：同一个模型认不认参考图、条还放不放得下，
  // 由 `lib/referenceDraft` 判一次，附图与禁用态不会各说各话。
  const admission = useMemo(() => referenceAdmission(activeProfile), [activeProfile])
  const supportsEdit = admission.supportsEdit
  const atImageLimit = inputImages.length >= admission.limit
  const attachDisabled = atImageLimit || !supportsEdit
  const attachDisabledReason = referenceRefusalMessage(supportsEdit ? 'overflow' : 'noEdit')
  const maskTargetImage = maskDraft
    ? (inputImages.find((img) => img.id === maskDraft.targetImageId) ?? null)
    : null
  const referenceImages = maskTargetImage
    ? inputImages.filter((img) => img.id !== maskTargetImage.id)
    : inputImages
  const cursorPosition = cursorPos
  // 序号胶囊的显示标签随界面语言变；编辑器 HTML 与光标换算都按这份解析器缓存，语言也是入参。
  const mentionLabels = useMemo(
    () => createMentionLabels(inputImages, getAssetNamesByImageId(assets)),
    [inputImages, assets, i18n.language],
  )
  const visiblePrompt = getVisiblePrompt(prompt, mentionLabels)
  const atImageQuery = isCursorInSelectedImageMention(prompt, cursorPosition, mentionLabels)
    ? null
    : getAtImageQuery(visiblePrompt, cursorPosition)
  const atMentionGroups = atImageQuery
    ? buildAtMentionGroups({
        query: atImageQuery.query,
        inputImages,
        assets,
        canAttachAssets: supportsEdit,
      })
    : []
  const slashQuery = isCursorInSelectedImageMention(prompt, cursorPosition, mentionLabels)
    ? null
    : getSlashTemplateQuery(visiblePrompt, cursorPosition)
  const templateMenuGroups =
    slashQuery && atMentionGroups.length === 0
      ? buildTemplateMenuGroups({ query: slashQuery.query, templates })
      : []
  const blurPrompt = useCallback(() => textareaRef.current?.blur(), [])
  const replaceRangeWithImageMention = useCallback(
    (start: number, end: number, imageIndex: number, nextLabelFor?: MentionLabelResolver) => {
      const next = insertImageMentionAtVisibleRange(
        prompt,
        start,
        end,
        imageIndex,
        mentionLabels,
        nextLabelFor,
      )
      setPrompt(next.prompt)
      window.setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          setContentEditableCursor(textareaRef.current, next.cursor)
        }
      }, 0)
    },
    [mentionLabels, prompt, setPrompt],
  )
  const insertImageMentionAtCursor = useCallback(
    (imageIndex: number) => {
      const el = textareaRef.current
      const cursor = el ? getContentEditableCursor(el) : prompt.length
      replaceRangeWithImageMention(cursor, cursor, imageIndex)
    },
    [prompt, replaceRangeWithImageMention],
  )
  const selectAtMentionOption = useCallback(
    async (value: AtMentionValue) => {
      const el = textareaRef.current
      const cursor = el ? getContentEditableCursor(el) : prompt.length
      const query = getAtImageQuery(getVisiblePrompt(prompt, mentionLabels), cursor)
      if (!query) return

      if (value.type === 'image') {
        replaceRangeWithImageMention(query.start, cursor, value.index)
        return
      }

      const imageIndex = await attachAsset(value.id)
      if (imageIndex == null) return
      // 附加后参考图与素材的最近使用都变了，胶囊标签得按新状态算，否则光标落错位置。
      const nextLabels = createMentionLabels(
        useStore.getState().inputImages,
        getAssetNamesByImageId(useLibraryStore.getState().assets),
      )
      replaceRangeWithImageMention(query.start, cursor, imageIndex, nextLabels)
    },
    [attachAsset, mentionLabels, prompt, replaceRangeWithImageMention],
  )

  const atImageMenu = useSuggestionMenu({
    groups: atMentionGroups,
    onSelect: (value: AtMentionValue) => void selectAtMentionOption(value),
    onClose: blurPrompt,
  })

  const selectTemplateOption = useCallback(
    (id: string) => {
      const el = textareaRef.current
      const cursor = el ? getContentEditableCursor(el) : prompt.length
      const query = getSlashTemplateQuery(getVisiblePrompt(prompt, mentionLabels), cursor)
      if (!query) return

      // 先抹掉 `/关键词`，否则套用会把它当成未保存的输入而弹覆盖确认框。
      const promptStart = getPromptIndexFromVisibleIndex(prompt, query.start, mentionLabels)
      const promptEnd = getPromptIndexFromVisibleIndex(prompt, cursor, mentionLabels)
      setPrompt(`${prompt.slice(0, promptStart)}${prompt.slice(promptEnd)}`)
      void applyTemplate(id)
    },
    [applyTemplate, mentionLabels, prompt, setPrompt],
  )

  const templateMenu = useSuggestionMenu({
    groups: templateMenuGroups,
    onSelect: selectTemplateOption,
    onClose: blurPrompt,
  })

  const insertPromptTextAtSelection = useCallback(
    (text: string) => {
      const el = textareaRef.current
      const selection = el
        ? getContentEditableSelection(el)
        : { start: prompt.length, end: prompt.length }
      const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start, mentionLabels)
      const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end, mentionLabels)
      const nextPrompt = `${prompt.slice(0, promptStart)}${text}${prompt.slice(promptEnd)}`
      const nextCursor = selection.start + text.length
      setPrompt(nextPrompt)
      window.setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          setContentEditableCursor(textareaRef.current, nextCursor)
        }
      }, 0)
    },
    [prompt, setPrompt],
  )

  const handleClearPrompt = useCallback(() => {
    setPrompt('')
    setCursorPos(0)
    atImageMenu.dismiss()
    templateMenu.dismiss()

    window.setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.innerHTML = ''
      el.focus()
      setContentEditableCursor(el, 0)
      syncMentionTagSelection(el)
    }, 0)
  }, [atImageMenu.dismiss, templateMenu.dismiss, setPrompt])

  useEffect(() => {
    const normalizedParams = normalizeParamsForSettings(params, settings, {
      hasInputImages: inputImages.length > 0,
    })
    const patch = getChangedParams(params, normalizedParams)
    if (Object.keys(patch).length) {
      setParams(patch)
    }
  }, [inputImages.length, params, settings, setParams])

  useEffect(
    () => () => {
      if (compressionHintTimerRef.current != null) {
        window.clearTimeout(compressionHintTimerRef.current)
      }
      if (qualityHintTimerRef.current != null) {
        window.clearTimeout(qualityHintTimerRef.current)
      }
      if (sizeHintTimerRef.current != null) {
        window.clearTimeout(sizeHintTimerRef.current)
      }
      if (imageHintTimerRef.current != null) {
        window.clearTimeout(imageHintTimerRef.current)
      }
      imageHintReleaseRef.current?.()
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    if (!maskDraft || !maskTargetImage) {
      setMaskPreviewUrl('')
      return
    }

    createMaskPreviewDataUrl(maskTargetImage.dataUrl, maskDraft.maskDataUrl)
      .then((url) => {
        if (!cancelled) setMaskPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewUrl('')
      })

    return () => {
      cancelled = true
    }
  }, [maskDraft, maskTargetImage?.id, maskTargetImage?.dataUrl])

  const showCompressionHint = () => setCompressionHintVisible(true)

  const hideCompressionHint = () => {
    setCompressionHintVisible(false)
    clearCompressionHintTimer()
  }

  const clearCompressionHintTimer = () => {
    if (compressionHintTimerRef.current != null) {
      window.clearTimeout(compressionHintTimerRef.current)
      compressionHintTimerRef.current = null
    }
  }

  const startCompressionHintTouch = () => {
    compressionHintTimerRef.current = window.setTimeout(() => {
      setCompressionHintVisible(true)
      compressionHintTimerRef.current = null
    }, 450)
  }

  const showQualityHint = () => {
    if (activeView.codexCli) setQualityHintVisible(true)
  }

  const showSizeHint = () => {
    /* no-op */
  }

  const hideSizeHint = () => {
    setSizeHintVisible(false)
    clearSizeHintTimer()
  }

  const clearSizeHintTimer = () => {
    if (sizeHintTimerRef.current != null) {
      window.clearTimeout(sizeHintTimerRef.current)
      sizeHintTimerRef.current = null
    }
  }

  const startSizeHintTouch = () => {
    /* no-op */
  }

  const hideQualityHint = () => {
    setQualityHintVisible(false)
    clearQualityHintTimer()
  }

  const clearQualityHintTimer = () => {
    if (qualityHintTimerRef.current != null) {
      window.clearTimeout(qualityHintTimerRef.current)
      qualityHintTimerRef.current = null
    }
  }

  const startQualityHintTouch = () => {
    if (!activeView.codexCli) return
    qualityHintTimerRef.current = window.setTimeout(() => {
      setQualityHintVisible(true)
      qualityHintTimerRef.current = null
    }, 450)
  }

  const clearImageHintTimer = () => {
    if (imageHintTimerRef.current != null) {
      window.clearTimeout(imageHintTimerRef.current)
      imageHintTimerRef.current = null
    }
  }

  const showImageHint = (id: string) => setImageHintId(id)

  const hideImageHint = () => {
    if (imageHintLockedRef.current) return
    setImageHintId(null)
    clearImageHintTimer()
  }

  const hideLockedImageHint = () => {
    imageHintLockedRef.current = false
    imageHintReleaseRef.current?.()
    imageHintReleaseRef.current = null
    setImageHintId(null)
    clearImageHintTimer()
  }

  const showImageHintUntilRelease = (id: string) => {
    if (imageHintLockedRef.current) {
      setImageHintId(id)
      return
    }
    imageHintLockedRef.current = true
    setImageHintId(id)
    const release = () => {
      window.removeEventListener('mouseup', release)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('dragend', release)
      if (imageHintReleaseRef.current === release) {
        imageHintReleaseRef.current = null
        imageHintLockedRef.current = false
        setImageHintId(null)
        clearImageHintTimer()
      }
    }
    imageHintReleaseRef.current = release
    window.addEventListener('mouseup', release)
    window.addEventListener('pointerup', release)
    window.addEventListener('dragend', release)
  }

  const handleFiles = async (files: FileList | File[]) => {
    const accepted = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (accepted.length === 0) return
    try {
      const images: InputImage[] = []
      for (const file of accepted) images.push(await storeImageFromFile(file))
      // 这一把文件是一组：先全部落进 image store，再整组过准入——放不下就一张都不落，
      // 免得用户拖进去十张只见前几张、还得自己数少了哪几张。
      useStore.getState().attachInputImages(images)
    } catch (err) {
      useStore.getState().showToast(t('image.addFailed', { reason: describeError(err) }), 'error')
    }
  }

  const handleFilesRef = useRef(handleFiles)
  handleFilesRef.current = handleFiles

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFilesRef.current(e.target.files || [])
    e.target.value = ''
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (atImageMenu.handleKeyDown(e) || templateMenu.handleKeyDown(e)) return

    // 阻止 contentEditable 默认换行
    if (e.key === 'Enter') {
      e.preventDefault()

      const isModifier = e.ctrlKey || e.metaKey

      if (settings.enterSubmit) {
        if (e.shiftKey) {
          insertPromptTextAtSelection('\n')
        } else if (!isModifier) {
          if (submitReady) submit()
        }
      } else {
        if (isModifier) {
          if (submitReady) submit()
        } else {
          insertPromptTextAtSelection('\n')
        }
      }
      return
    }
  }

  const handlePromptPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    if (Array.from(e.clipboardData.items).some((item) => item.type.startsWith('image/'))) return

    e.preventDefault()
    insertPromptTextAtSelection(text.replace(/\r\n?/g, '\n'))
  }

  const handlePromptCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = textareaRef.current
    if (!el) return

    const selection = getContentEditableSelection(el)
    if (selection.start === selection.end) return

    const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start, mentionLabels)
    const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end, mentionLabels)
    const text = getVisiblePrompt(prompt.slice(promptStart, promptEnd), mentionLabels)
    // 只选中一个胶囊时复制胶囊本身，别把它两边的空白也带走
    const parts = getPromptMentionParts(prompt.slice(promptStart, promptEnd), mentionLabels).filter(
      (part) => part.type === 'mention' || part.text.trim(),
    )
    const copyText = parts.length === 1 && parts[0].type === 'mention' ? parts[0].text : text

    e.preventDefault()
    e.clipboardData.setData('text/plain', copyText)
  }

  const dragActive = useImageInputScope() === 'image'
  usePasteImageFiles('image', (files) => void handleFilesRef.current(files))

  // 拖拽图片 - 监听整个页面
  useEffect(() => {
    // 素材面板自己是落点，它开着时全屏遮罩既抢不到 drop，也等不到熄灭它的 dragleave。
    if (!dragActive) {
      dragCounter.current = 0
      setIsDragging(false)
      return
    }

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        handleFilesRef.current(files)
      }
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [dragActive])

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    // 卡片内除 textarea 外的固定占用（图片 thumbs + 参数行 + padding 等），用于把
    // textarea 上限限制到「视口 40% 减开销」。
    const imagesHeight = imagesRef.current?.offsetHeight ?? 0
    const fixedOverhead = imagesHeight + 140

    // 1. 关闭过渡动画，设高度为 0 以获取真实的文本内容高度
    el.style.transition = 'none'
    el.style.height = '0'
    el.style.overflowY = 'hidden'
    const { targetH, scroll } = computePromptHeight({
      scrollH: el.scrollHeight,
      innerHeight: window.innerHeight,
      fixedOverhead,
    })

    // 2. 将高度设回上一次的实际高度，强制重绘，准备开始动画
    el.style.height = prevHeightRef.current + 'px'
    void el.offsetHeight

    // 3. 恢复平滑过渡，并设置目标高度
    el.style.transition = 'height 150ms ease, border-color 200ms, box-shadow 200ms'
    el.style.height = targetH + 'px'
    el.style.overflowY = scroll ? 'auto' : 'hidden'

    prevHeightRef.current = targetH
  }, [])

  // 将 prompt 同步渲染到 contentEditable（含胶囊 tag）。开头的 `/技能` 命令要变成带图标的胶囊，
  // 与画布输入框同一种呈现——用户从资产页「用智能体创建」跳过来看到的不该是一行裸文本。
  const skills = useAgentSkills('image')
  const [skillChip, setSkillChip] = useState<{
    element: HTMLElement
    skill: AgentSkillSummary
  } | null>(null)
  useEffect(() => {
    // 只跳过用户刚打进去的那个值，避免光标跳动；粘性布尔会把外部设置的 prompt 一起吞掉。
    const typed = lastTypedRef.current
    lastTypedRef.current = null
    const el = textareaRef.current
    if (!el) return
    const invocation = getLeadingAgentSkill(prompt, skills)
    const chipMissing = Boolean(invocation) && !el.querySelector('[data-skill-command]')
    if (prompt === typed && !chipMissing) return
    const html = buildPromptEditorHtml(prompt, mentionLabels, slotValues)
    const selection = document.activeElement === el ? getContentEditableSelection(el) : null
    if (el.innerHTML !== html) el.innerHTML = html
    const first = el.firstChild
    if (invocation && first instanceof Text && first.data.startsWith(invocation.command)) {
      first.splitText(invocation.command.length)
      const element = document.createElement('span')
      element.contentEditable = 'false'
      element.className = 'mention-tag agent-skill-mention'
      element.dataset.mentionText = invocation.command
      element.dataset.mentionLabel = invocation.command
      element.dataset.skillCommand = invocation.skill.name
      element.setAttribute('aria-label', invocation.skill.title)
      first.replaceWith(element)
      setSkillChip({ element, skill: invocation.skill })
      if (selection) setContentEditableSelection(el, selection)
    } else {
      setSkillChip(null)
    }
  }, [prompt, mentionLabels, slotValues, skills])

  useEffect(() => {
    adjustTextareaHeight()
  }, [prompt, inputImages, adjustTextareaHeight])

  useEffect(() => {
    setOpenSlot((slot) => (slot && !getPromptSlotNames(prompt).includes(slot.name) ? null : slot))
  }, [prompt])

  // 素材名要参与 `@` 候选与胶囊标签、模板名要参与 `/` 候选，不能等到用户打开面板才读。
  useEffect(() => {
    void loadAssets()
    void loadTemplates()
  }, [loadAssets, loadTemplates])

  // 监听 selectionchange 以在光标移动时更新位置（contentEditable 的 onSelect 不可靠）
  useEffect(() => {
    const handleSelectionChange = () => {
      const el = textareaRef.current
      if (!el) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return

      const domRange = sel.getRangeAt(0)
      try {
        if (!domRange.intersectsNode(el)) {
          syncMentionTagSelection(el)
          return
        }
      } catch {
        return
      }

      const range = getContentEditableSelection(el)
      setCursorPos(range.start)
      syncMentionTagSelection(el)

      const rangeRect = domRange.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      if (rangeRect.width === 0 && rangeRect.height === 0) return
      setMenuLeft(rangeRect.left - elRect.left)
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])
  useEffect(() => {
    adjustTextareaHeight()
  }, [inputImages.length, Boolean(maskDraft), maskPreviewUrl, adjustTextareaHeight])

  useEffect(() => {
    window.addEventListener('resize', adjustTextareaHeight)
    return () => window.removeEventListener('resize', adjustTextareaHeight)
  }, [adjustTextareaHeight])

  // 移动端拖动条手势
  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    const onTouchStart = (e: TouchEvent) => {
      dragTouchRef.current = { startY: e.touches[0].clientY, moved: false }
    }
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - dragTouchRef.current.startY
      if (Math.abs(dy) > 10) dragTouchRef.current.moved = true
      if (dy > 30) setMobileCollapsed(true)
      if (dy < -30) setMobileCollapsed(false)
    }
    const onTouchEnd = () => {
      if (!dragTouchRef.current.moved) {
        setMobileCollapsed((v) => !v)
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [])

  const getTouchDropIndex = (touch: React.Touch) => {
    const target = document
      .elementFromPoint(touch.clientX, touch.clientY)
      ?.closest<HTMLElement>('[data-input-image-index]')
    if (!target) return null
    const idx = Number(target.dataset.inputImageIndex)
    if (!Number.isInteger(idx)) return null
    const rect = getSafeBoundingClientRect(target)
    if (!rect) return null
    return touch.clientX < rect.left + rect.width / 2 ? idx : idx + 1
  }

  const normalizeImageDropIndex = (idx: number) => {
    const minIdx = maskTargetImage ? 1 : 0
    return Math.max(minIdx, Math.min(inputImages.length, idx))
  }

  const isBeforeMaskDropArea = (clientX: number) => {
    if (!maskTargetImage) return false
    const maskEl = document.querySelector<HTMLElement>('[data-input-image-index="0"]')
    if (!maskEl) return false
    const rect = getSafeBoundingClientRect(maskEl)
    if (!rect) return false
    return clientX < rect.left + rect.width / 2
  }

  const resetImageDrag = () => {
    setImageDragIndex(null)
    setImageDragOverIndex(null)
    imageDragIndexRef.current = null
    imageDragOverIndexRef.current = null
    imageTouchDragRef.current = { index: null, startX: 0, startY: 0, moved: false }
    setTouchDragPreview(null)
    imageDragPreviewRef.current?.remove()
    imageDragPreviewRef.current = null
    hideImageHint()
  }

  useEffect(() => {
    if (!touchDragPreview) return
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
    }
  }, [touchDragPreview])

  const getDataTransferDragIndex = (e: React.DragEvent) => {
    const value = e.dataTransfer.getData('text/plain')
    const idx = Number(value)
    return Number.isInteger(idx) ? idx : null
  }

  const setImageDragTarget = (idx: number | null, clientX?: number) => {
    const fromIdx = imageDragIndexRef.current
    if (
      fromIdx !== null &&
      maskTargetImage &&
      (idx === 0 || (clientX != null && isBeforeMaskDropArea(clientX)))
    ) {
      showImageHint(maskTargetImage.id)
      imageDragOverIndexRef.current = null
      setImageDragOverIndex(null)
      return
    }

    if (fromIdx !== null) hideImageHint()
    const normalizedIdx = idx == null ? null : normalizeImageDropIndex(idx)
    const isNoopTarget =
      fromIdx !== null &&
      normalizedIdx !== null &&
      (normalizedIdx === fromIdx || normalizedIdx === fromIdx + 1)
    const nextIdx = isNoopTarget ? null : normalizedIdx
    imageDragOverIndexRef.current = nextIdx
    setImageDragOverIndex(nextIdx)
  }

  const renderImageThumb = (img: (typeof inputImages)[number], idx: number) => {
    const isMaskTarget = maskDraft?.targetImageId === img.id
    const canEdit = !maskTargetImage || isMaskTarget
    const imageHintText = isMaskTarget ? t('image.maskFirstHint') : ''
    const displaySrc = isMaskTarget && maskPreviewUrl ? maskPreviewUrl : img.dataUrl
    const isImageDragging = imageDragIndex === idx
    const isLast = idx === inputImages.length - 1
    const showDropBefore = imageDragOverIndex === idx && imageDragIndex !== idx
    const showDropAfter =
      imageDragOverIndex === inputImages.length && isLast && imageDragIndex !== idx

    const handleDragStart = (e: React.DragEvent) => {
      if (isMaskTarget) {
        showImageHintUntilRelease(img.id)
        e.preventDefault()
        return
      }
      hideImageHint()
      imageDragIndexRef.current = idx
      setImageDragIndex(idx)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(idx))
      const preview = document.createElement('div')
      preview.style.cssText =
        'position:fixed;left:-1000px;top:-1000px;width:52px;height:52px;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.25);'
      const previewImg = document.createElement('img')
      previewImg.src = displaySrc
      previewImg.style.cssText = 'width:52px;height:52px;object-fit:cover;display:block;'
      preview.appendChild(previewImg)
      document.body.appendChild(preview)
      imageDragPreviewRef.current = preview
      e.dataTransfer.setDragImage(preview, 26, 26)
    }

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const fromIdx = imageDragIndexRef.current
      if (fromIdx === null || fromIdx === idx) return
      const rect = getSafeBoundingClientRect(e.currentTarget)
      if (!rect) return
      setImageDragTarget(e.clientX < rect.left + rect.width / 2 ? idx : idx + 1, e.clientX)
    }

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault()
      const fromIdx = imageDragIndexRef.current ?? getDataTransferDragIndex(e)
      const toIdx = imageDragOverIndexRef.current
      if (fromIdx !== null && toIdx !== null) {
        moveInputImage(fromIdx, toIdx)
      }
      resetImageDrag()
    }

    const handleTouchStart = (e: React.TouchEvent) => {
      const touch = e.touches[0]
      thumbLongPressTargetRef.current = { index: idx, imageId: img.id }
      thumbLongPress.start({ x: touch.clientX, y: touch.clientY })
      imageTouchDragRef.current = {
        index: idx,
        startX: touch.clientX,
        startY: touch.clientY,
        moved: false,
      }
      if (isMaskTarget) return
      imageDragIndexRef.current = idx
      setTouchDragPreview(null)
    }

    const handleTouchMove = (e: React.TouchEvent) => {
      const touch = e.touches[0]
      thumbLongPress.move({ x: touch.clientX, y: touch.clientY })
      const touchDrag = imageTouchDragRef.current
      if (touchDrag.index === null) return

      if (isMaskTarget) {
        if (
          Math.abs(touch.clientX - touchDrag.startX) > 6 ||
          Math.abs(touch.clientY - touchDrag.startY) > 6
        ) {
          e.preventDefault()
          showImageHintUntilRelease(img.id)
        }
        return
      }

      touchDrag.moved = true
      clearImageHintTimer()
      setImageHintId(null)
      suppressImageClickRef.current = true
      e.preventDefault()
      setImageDragIndex(touchDrag.index)
      setTouchDragPreview({ src: displaySrc, x: touch.clientX, y: touch.clientY })
      const dropIndex = getTouchDropIndex(touch)
      setImageDragTarget(dropIndex, touch.clientX)
    }

    const handleTouchEnd = (e: React.TouchEvent) => {
      const touchDrag = imageTouchDragRef.current
      thumbLongPress.cancel()
      clearImageHintTimer()
      if (touchDrag.index !== null && imageDragOverIndexRef.current !== null) {
        e.preventDefault()
        moveInputImage(touchDrag.index, imageDragOverIndexRef.current)
      }
      // 抬手后紧跟的 click 要被吞掉（拖拽落位、长按开菜单都不该再开灯箱），下一轮宏任务才复位。
      window.setTimeout(() => {
        suppressImageClickRef.current = false
      }, 0)
      resetImageDrag()
      hideLockedImageHint()
    }

    const handleTouchCancel = () => {
      thumbLongPress.cancel()
      suppressImageClickRef.current = false
      hideLockedImageHint()
      resetImageDrag()
    }

    return (
      <div
        key={img.id}
        data-input-image-index={idx}
        className={`relative group inline-block h-[52px] w-[52px] shrink-0 self-start transition-opacity ${isImageDragging ? 'opacity-40' : ''}`}
        style={{ touchAction: isMaskTarget ? 'auto' : 'none' }}
        draggable={!isMobile}
        onMouseLeave={hideImageHint}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={resetImageDrag}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          setThumbMenu({ index: idx, imageId: img.id, x: e.clientX, y: e.clientY })
        }}
      >
        <ButtonTooltip
          visible={imageHintId === img.id && Boolean(imageHintText) && (!isMobile || isMaskTarget)}
          text={imageHintText}
        />
        {showDropBefore && (
          <div className="absolute -left-[5px] top-0 bottom-0 w-[2px] bg-primary rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        {showDropAfter && (
          <div className="absolute -right-[5px] top-0 bottom-0 w-[2px] bg-primary rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        <div
          className={`relative w-[52px] h-[52px] rounded-xl overflow-hidden shadow-sm cursor-grab active:cursor-grabbing select-none ${
            isMaskTarget ? 'border-2 border-primary' : 'border border-border'
          }`}
          onClick={() => {
            if (suppressImageClickRef.current) return
            if (isMaskTarget) {
              setMaskEditorImageId(img.id)
              return
            }
            if (maskTargetImage && !maskConflictNoticeShownRef.current) {
              maskConflictNoticeShownRef.current = true
              showToast(t('image.onlyOneMask'), 'info')
            }
            setLightboxImageId(
              img.id,
              inputImages.map((i) => i.id),
            )
          }}
        >
          {displaySrc && (
            <div className="h-full w-full overflow-hidden rounded-xl">
              <img
                src={displaySrc}
                className="w-full h-full object-cover hover:opacity-90 transition-opacity pointer-events-none"
                alt=""
              />
            </div>
          )}
          {isMaskTarget && (
            <span className="absolute left-1 top-1 rounded bg-primary/90 px-1.5 py-0.5 text-[8px] leading-none text-primary-foreground font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
              MASK
            </span>
          )}
          <span className="absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/55 text-[9px] font-semibold text-white backdrop-blur-sm z-10 pointer-events-none">
            {idx + 1}
          </span>
          {/* 遮罩入口对所有支持 edit（图生图）的模型开放：声明原生 mask 的模型走
              images/edits inpaint；其余模型在 callImageApi 降级为「原图+高亮标注图」软遮罩 */}
          {canEdit && supportsEdit && (
            <button
              className="absolute inset-0 w-full h-full bg-black/40 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity flex items-center justify-center cursor-pointer z-20 focus:outline-none border-none"
              onClick={(e) => {
                e.stopPropagation()
                setMaskEditorImageId(img.id)
              }}
              title={isMaskTarget ? t('mask.title') : t('image.addMask')}
            >
              <MaskBrushIcon className="w-5 h-5 text-white" />
            </button>
          )}
        </div>
        {!isMaskTarget && (
          <span
            className="absolute right-0 top-0 flex h-5 w-5 translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-destructive text-white opacity-0 shadow-md transition-opacity hover:bg-destructive/90 group-hover:opacity-100 [@media(hover:none)]:opacity-100 z-30"
            onClick={(e) => {
              e.stopPropagation()
              removeInputImage(idx)
            }}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </span>
        )}
      </div>
    )
  }

  const renderClearAllButton = () => (
    <button
      onClick={() =>
        setConfirmDialog({
          title: maskTargetImage ? t('image.clearAllTitle') : t('image.clearReferencesTitle'),
          message: maskTargetImage
            ? t('image.clearWithMaskMessage', { count: referenceImages.length })
            : t('image.clearReferencesMessage', { count: inputImages.length }),
          action: () => clearInputImages(),
        })
      }
      className="w-[52px] h-[52px] rounded-xl border border-dashed border-border flex flex-col items-center justify-center gap-0.5 text-muted-foreground hover:text-destructive hover:border-destructive hover:bg-destructive/50 dark:hover:bg-destructive/30 transition-all cursor-pointer flex-shrink-0"
      title={maskTargetImage ? t('image.clearAllTooltip') : t('image.clearReferencesTooltip')}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
        />
      </svg>
      <span className="text-[8px] leading-none">
        {maskTargetImage ? t('image.clearAllLabel') : t('common:action.clear')}
      </span>
    </button>
  )

  const renderImageThumbs = () => {
    return (
      <div ref={imagesRef}>
        <AssetHint />
        <div className="grid grid-cols-[repeat(auto-fill,52px)] justify-between gap-x-2 gap-y-3 mb-3">
          {inputImages.map((img, idx) => renderImageThumb(img, idx))}
          {renderClearAllButton()}
        </div>
        {touchDragPreview?.src &&
          createPortal(
            <div
              className="fixed z-[140] h-[52px] w-[52px] overflow-hidden rounded-xl shadow-xl pointer-events-none opacity-90"
              style={{
                left: touchDragPreview.x,
                top: touchDragPreview.y,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <img src={touchDragPreview.src} className="h-full w-full object-cover" alt="" />
            </div>,
            document.body,
          )}
        {thumbMenu && (
          <ContextMenu x={thumbMenu.x} y={thumbMenu.y} onClose={() => setThumbMenu(null)}>
            <ContextMenuItem
              icon={<LinkIcon className="h-4 w-4 flex-shrink-0" />}
              label={t('image.insertMention')}
              onClick={() => {
                insertImageMentionAtCursor(thumbMenu.index)
                setThumbMenu(null)
              }}
            />
            <ContextMenuItem
              icon={<LibraryIcon className="h-4 w-4 flex-shrink-0" />}
              label={t('image.saveAsAsset')}
              onClick={() => {
                startNamingAsset(thumbMenu.imageId)
                setThumbMenu(null)
              }}
            />
          </ContextMenu>
        )}
      </div>
    )
  }

  return (
    <>
      {skillChip && createPortal(<AgentSkillBadge skill={skillChip.skill} />, skillChip.element)}
      {/* 全屏拖拽遮罩 */}
      {isDragging && (
        <div className="fixed inset-0 z-[100] bg-card/60 backdrop-blur-md flex flex-col items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 rounded-3xl">
            <div
              className={`w-20 h-20 rounded-full border-2 border-dashed flex items-center justify-center ${
                atImageLimit
                  ? 'bg-destructive/10 dark:bg-destructive/10 border-destructive'
                  : 'bg-primary/10 border-primary'
              }`}
            >
              {atImageLimit ? (
                <svg
                  className="w-10 h-10 text-destructive"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                  />
                </svg>
              ) : (
                <svg
                  className="w-10 h-10 text-primary"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              )}
            </div>
            <div className="text-center">
              {atImageLimit ? (
                <>
                  <p className="text-lg font-semibold text-destructive">
                    {t('image.limitReached', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">{t('image.limitHint')}</p>
                </>
              ) : (
                <>
                  <p className="text-lg font-semibold text-foreground">{t('image.dropToAdd')}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('image.dropFormats', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        data-input-bar
        className={
          inline
            ? 'studio-history-composer relative z-10 mx-auto w-full max-w-4xl'
            : 'studio-history-composer fixed bottom-4 z-30 max-w-4xl -translate-x-1/2 px-3 transition-all duration-300 sm:bottom-6 sm:px-4'
        }
        style={
          inline
            ? undefined
            : {
                left: 'calc(50% + var(--app-sidebar-width) / 2)',
                width: 'calc(100% - var(--app-sidebar-width))',
              }
        }
      >
        <div
          ref={cardRef}
          className={`relative rounded-2xl border border-border bg-card text-card-foreground ring-1 ring-black/5 backdrop-blur-2xl sm:rounded-3xl dark:ring-white/10 ${
            inline
              ? 'studio-hero-composer'
              : 'shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)]'
          } ${barCollapsed ? 'p-2' : 'p-3 sm:p-4'}`}
        >
          {barCollapsed ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBarCollapsed(false)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted/80"
                title={t('bar.expand')}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setBarCollapsed(false)}
                className="min-w-0 flex-1 truncate rounded-xl bg-muted/60 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
                title={t('bar.expandHint')}
              >
                {prompt.trim() ? visiblePrompt : t('bar.emptyPromptHint')}
              </button>
              <div
                className="relative flex items-center gap-2"
                onMouseEnter={() => setSubmitHover(true)}
                onMouseLeave={() => setSubmitHover(false)}
              >
                <SubmissionBillingAction
                  blockedAction={submissionGuard.blockedAction}
                  className="text-[11px]"
                />
                <ButtonTooltip
                  visible={
                    !toCanvas && (!hasSubmitApiConfig || submissionGuard.blocked) && submitHover
                  }
                  text={submissionGuard.disabledReason ?? t('submit.apiNotConfigured')}
                />
                <button
                  type="button"
                  onClick={() => (apiReady ? submit() : setShowSettings(true))}
                  disabled={apiReady ? !submitReady : false}
                  className={`inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-medium shadow-sm transition-all duration-150 active:scale-[0.97] ${
                    !apiReady
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:active:scale-100'
                  }`}
                  title={
                    submissionGuard.disabledReason ??
                    (toCanvas
                      ? t('submit.startCanvas')
                      : hasSubmitApiConfig
                        ? maskDraft
                          ? t('submit.maskEditShortcut')
                          : t('submit.generateShortcut')
                        : t('submit.configureApiFirst'))
                  }
                >
                  {ChipIcons.sparkles}
                  <span>{maskDraft ? t('submit.maskEdit') : submitLabel}</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setBarCollapsed(true)}
                className="absolute right-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-md bg-card/60 text-muted-foreground backdrop-blur-sm hover:bg-muted/80 hover:text-muted-foreground"
                title={t('bar.collapse')}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {/* 移动端拖动条 */}
              <div
                ref={handleRef}
                className="sm:hidden flex justify-center pt-0.5 pb-2 -mt-1 cursor-pointer touch-none"
                onClick={() => setMobileCollapsed((v) => !v)}
              >
                <div
                  className={`w-10 h-1 rounded-full bg-muted transition-transform duration-200 ${mobileCollapsed ? 'scale-x-75' : ''}`}
                />
              </div>

              {/* 输入图片行（移动端可折叠） */}
              {inputImages.length > 0 &&
                (isMobile ? (
                  <>
                    <div className={`collapse-section${mobileCollapsed ? ' collapsed' : ''}`}>
                      <div className="collapse-inner">{renderImageThumbs()}</div>
                    </div>
                    {mobileCollapsed && (
                      <div className="text-xs text-muted-foreground mb-2 ml-1">
                        {maskDraft
                          ? t('image.summaryWithMask', { count: referenceImages.length })
                          : t('image.summary', { count: inputImages.length })}
                      </div>
                    )}
                  </>
                ) : (
                  renderImageThumbs()
                ))}

              {/* 输入框 */}
              {activeLook && !toCanvas && (
                <LookCapsule
                  look={activeLook}
                  issue={lookCheck && !lookCheck.ok ? lookCheck : null}
                  onRemove={() => useActiveLook.getState().set(null)}
                />
              )}
              <div className="relative">
                {openSlot && (
                  <SlotValuePopover
                    key={openSlot.name}
                    name={openSlot.name}
                    values={slotValues[openSlot.name] ?? []}
                    offsetLeft={openSlot.left}
                    onChange={(values) => setSlotValues(openSlot.name, values)}
                    onClose={() => setOpenSlot(null)}
                  />
                )}
                {atImageMenu.visible && (
                  <SuggestionMenu
                    groups={atMentionGroups}
                    activeIndex={atImageMenu.activeIndex}
                    offsetLeft={menuLeft}
                    onActiveIndexChange={atImageMenu.setActiveIndex}
                    onSelect={atImageMenu.select}
                  />
                )}
                {templateMenu.visible && (
                  <SuggestionMenu
                    groups={templateMenuGroups}
                    activeIndex={templateMenu.activeIndex}
                    offsetLeft={menuLeft}
                    onActiveIndexChange={templateMenu.setActiveIndex}
                    onSelect={templateMenu.select}
                  />
                )}
                <div
                  ref={textareaRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(e) => {
                    const el = e.currentTarget
                    // contentEditable 删除最后一个字符后浏览器常留 <br> 或空 span，让
                    // :empty 不再匹配 → placeholder 消失。textContent 真为空就把残留 DOM 清干净。
                    if (!el.textContent && el.innerHTML) {
                      el.innerHTML = ''
                    }
                    const range = getContentEditableSelection(el)
                    setCursorPos(range.start)
                    syncMentionTagSelection(el)
                    const text = getContentEditablePlainText(el)
                    // 手打出一个完整槽位时必须让渲染 effect 跑一次，否则它永远不会变成 chip。
                    const slotsChanged =
                      JSON.stringify(getPromptSlotNames(text)) !==
                      JSON.stringify(getPromptSlotNames(prompt))
                    lastTypedRef.current = slotsChanged ? null : text
                    setPrompt(text)
                    if (slotsChanged) {
                      window.setTimeout(() => {
                        if (textareaRef.current) {
                          setContentEditableCursor(textareaRef.current, range.start)
                        }
                      }, 0)
                    }
                    atImageMenu.open()
                    templateMenu.open()
                  }}
                  onSelect={(e) => {
                    const el = e.currentTarget
                    const range = getContentEditableSelection(el)
                    setCursorPos(range.start)
                    syncMentionTagSelection(el)
                    atImageMenu.open()
                    templateMenu.open()
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePromptPaste}
                  onCopy={handlePromptCopy}
                  onClick={(e) => {
                    const el = textareaRef.current
                    if (!el) return
                    const target = e.target as HTMLElement
                    const slotTag = target.closest<HTMLElement>('.slot-tag')
                    if (slotTag?.dataset.slotName) {
                      const name = slotTag.dataset.slotName
                      const chipRect = getSafeBoundingClientRect(slotTag)
                      const editorRect = getSafeBoundingClientRect(el)
                      setOpenSlot(
                        openSlot?.name === name || !chipRect || !editorRect
                          ? null
                          : { name, left: chipRect.left - editorRect.left },
                      )
                      return
                    }
                    if (target.classList.contains('mention-tag')) {
                      const sel = window.getSelection()
                      if (sel) {
                        const range = document.createRange()
                        range.selectNode(target)
                        sel.removeAllRanges()
                        sel.addRange(range)
                        syncMentionTagSelection(el)
                      }
                      return
                    }

                    syncMentionTagSelection(el)
                  }}
                  data-placeholder={t('editor.placeholder')}
                  className={TEXTAREA_CLASS}
                />
                {prompt.length > 0 && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleClearPrompt}
                    className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground"
                    title={t('editor.clearPrompt')}
                    aria-label={t('editor.clearPrompt')}
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* 参数 + 按钮 */}
              <div className="mt-3">
                {/* 桌面端布局 */}
                <div className="hidden sm:flex flex-wrap items-center gap-2">
                  <div
                    className="relative flex-shrink-0"
                    onMouseEnter={() => setAttachHover(true)}
                    onMouseLeave={() => setAttachHover(false)}
                  >
                    <ButtonTooltip
                      visible={attachDisabled && attachHover}
                      text={attachDisabledReason}
                    />
                    <button
                      onClick={() => !attachDisabled && fileInputRef.current?.click()}
                      className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors duration-150 ${
                        attachDisabled
                          ? 'border-border/60 bg-muted/60 text-foreground cursor-not-allowed'
                          : 'border-border/80 bg-card/70 text-muted-foreground hover:border-border/80 hover:bg-card dark:hover:border-white/[0.20]'
                      }`}
                      title={
                        attachDisabled
                          ? attachDisabledReason
                          : t('image.attach', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })
                      }
                    >
                      {ChipIcons.imageAttach}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      useLibraryStore.getState().setTab('assets')
                      setAppMode('library')
                    }}
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border/80 bg-card/70 text-muted-foreground transition-colors duration-150 hover:border-border/80 hover:bg-card dark:hover:border-white/[0.20]"
                    title={t('bar.library')}
                  >
                    <LibraryIcon className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={startNamingTemplate}
                    disabled={!prompt.trim()}
                    className={SAVE_TEMPLATE_BUTTON_CLASS}
                    title={t('bar.saveTemplate')}
                  >
                    <BookmarkIcon className="h-5 w-5" />
                  </button>
                  <ParamControls showCount collapsible agentManaged={toCanvas} />
                  {/* ml-auto 让 Generate 永远贴当前行右端，chips 偶尔挤到 row 2 时大按钮也能撑住空白。 */}
                  <div
                    className="relative ml-auto flex flex-shrink-0 items-center gap-2"
                    onMouseEnter={() => setSubmitHover(true)}
                    onMouseLeave={() => setSubmitHover(false)}
                  >
                    <SubmissionBillingAction
                      blockedAction={submissionGuard.blockedAction}
                      className="text-xs"
                    />
                    <ButtonTooltip
                      visible={
                        !toCanvas && (!hasSubmitApiConfig || submissionGuard.blocked) && submitHover
                      }
                      text={submissionGuard.disabledReason ?? t('submit.apiNotConfigured')}
                    />
                    <button
                      onClick={() => (apiReady ? submit() : setShowSettings(true))}
                      disabled={apiReady ? !submitReady : false}
                      className={`group/gen relative inline-flex h-12 items-center justify-center gap-1.5 overflow-hidden rounded-full pl-4 pr-6 text-sm font-semibold leading-none transition-all duration-200 active:scale-[0.97] ${
                        !apiReady
                          ? 'bg-muted text-muted-foreground'
                          : 'studio-generate-button disabled:cursor-not-allowed disabled:bg-muted disabled:bg-none disabled:text-muted-foreground disabled:shadow-none disabled:ring-0 disabled:active:scale-100'
                      }`}
                      title={
                        submissionGuard.disabledReason ??
                        (toCanvas
                          ? t('submit.startCanvas')
                          : hasSubmitApiConfig
                            ? maskDraft
                              ? t('submit.maskEditShortcut')
                              : t('submit.generateShortcut')
                            : t('submit.configureApiFirst'))
                      }
                    >
                      {apiReady && submitReady && (
                        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
                      )}
                      <svg
                        className="h-[18px] w-[18px] drop-shadow-[0_0_4px_rgba(255,255,255,0.4)]"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 14l.7 2.1L22 17l-2.3.9L19 20l-.7-2.1L16 17l2.3-.9L19 14z"
                        />
                      </svg>
                      <span>{maskDraft ? t('submit.maskEdit') : submitLabel}</span>
                    </button>
                  </div>
                </div>

                {/* 移动端布局 */}
                <div className="sm:hidden flex flex-col gap-2">
                  {/* 参数 chip 列：套 collapse-section 让顶部拖动条还能上下拖收起。
                  attach + 生成按钮保持可见，方便折叠后还能立刻发请求。 */}
                  <div className={`collapse-section${mobileCollapsed ? ' collapsed' : ''}`}>
                    <div className="collapse-inner">
                      <div className="flex flex-wrap items-center gap-2">
                        <ParamControls showCount collapsible agentManaged={toCanvas} />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div
                      className="relative"
                      onMouseEnter={() => setAttachHover(true)}
                      onMouseLeave={() => setAttachHover(false)}
                    >
                      <ButtonTooltip
                        visible={attachDisabled && attachHover}
                        text={attachDisabledReason}
                      />
                      <button
                        onClick={() => !attachDisabled && fileInputRef.current?.click()}
                        className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors duration-150 flex-shrink-0 ${
                          attachDisabled
                            ? 'border-border/60 bg-muted/60 text-foreground cursor-not-allowed'
                            : 'border-border/80 bg-card/70 text-muted-foreground hover:border-border/80 hover:bg-card dark:hover:border-white/[0.20]'
                        }`}
                        title={
                          attachDisabled
                            ? attachDisabledReason
                            : t('image.attach', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })
                        }
                      >
                        {ChipIcons.imageAttach}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        useLibraryStore.getState().setTab('assets')
                        setAppMode('library')
                      }}
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border/80 bg-card/70 text-muted-foreground transition-colors duration-150"
                      title={t('bar.library')}
                    >
                      <LibraryIcon className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={startNamingTemplate}
                      disabled={!prompt.trim()}
                      className={SAVE_TEMPLATE_BUTTON_CLASS}
                      title={t('bar.saveTemplate')}
                    >
                      <BookmarkIcon className="h-5 w-5" />
                    </button>
                    <div
                      className="relative flex flex-1 items-center gap-2"
                      onMouseEnter={() => setSubmitHover(true)}
                      onMouseLeave={() => setSubmitHover(false)}
                    >
                      <SubmissionBillingAction
                        blockedAction={submissionGuard.blockedAction}
                        className="text-[11px]"
                      />
                      <ButtonTooltip
                        visible={
                          !toCanvas &&
                          (!hasSubmitApiConfig || submissionGuard.blocked) &&
                          submitHover
                        }
                        text={submissionGuard.disabledReason ?? t('submit.apiNotConfigured')}
                      />
                      <button
                        onClick={() => (apiReady ? submit() : setShowSettings(true))}
                        disabled={apiReady ? !submitReady : false}
                        className={`w-full inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-3.5 text-xs font-medium shadow-sm transition-all duration-150 active:scale-[0.97] ${
                          !apiReady
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:active:scale-100'
                        }`}
                      >
                        {ChipIcons.sparkles}
                        <span>
                          {toCanvas
                            ? submitLabel
                            : maskDraft
                              ? t('submit.maskEdit')
                              : submitImageCount > 1
                                ? generateLabel
                                : t('submit.generateImage')}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {!toCanvas && <LookChips onPick={applyLookToComposer} />}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileUpload}
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}
