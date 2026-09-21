import { formatImageRatio } from '@image-playground/shared'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useImagePreview } from '../hooks/useImagePreview'
import { useTooltip } from '../hooks/useTooltip'
import { useTranslation } from '../i18n'
import { formatDateTime } from '../i18n/format'
import { getActiveApiProfile, getApiProviderLabel } from '../lib/apiProfiles'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import {
  copyBlobToClipboard,
  copyTextToClipboard,
  getClipboardFailureMessage,
} from '../lib/clipboard'
import { loadImageOriginal } from '../lib/imageSource'
import { ActualValueBadge, DetailParamValue } from '../lib/paramDisplay'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import {
  editOutputImage,
  getCodexCliPromptKey,
  removeTask,
  retryTask,
  reuseConfig,
  sendTaskToCanvas,
  showCodexCliPrompt,
  updateTaskInStore,
  useStore,
} from '../store'
import { CloseIcon, CodeIcon, CopyIcon, EditIcon, LinkIcon, TrashIcon } from './icons'
import Overlay from './Overlay'

import ViewportTooltip from './ViewportTooltip'

export default function DetailModal() {
  const { t } = useTranslation(['task', 'common'])
  const tasks = useStore((s) => s.tasks)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const settings = useStore((s) => s.settings)
  const dismissedCodexCliPrompts = useStore((s) => s.dismissedCodexCliPrompts)

  const [imageIndex, setImageIndex] = useState(0)
  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})
  const [outputPreviewSrcs, setOutputPreviewSrcs] = useState<Record<string, string>>({})
  const [imageRatios, setImageRatios] = useState<Record<string, string>>({})
  const [imageSizes, setImageSizes] = useState<Record<string, string>>({})
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')
  const [now, setNow] = useState(Date.now())
  const [showRawUrlsModal, setShowRawUrlsModal] = useState(false)
  const [showRawResponseModal, setShowRawResponseModal] = useState(false)
  // 长提示词默认折叠（保证弹窗一屏展示不出滚动条），点击可展开。
  const [promptExpanded, setPromptExpanded] = useState(false)
  const imagePanelRef = useRef<HTMLDivElement>(null)
  const mainImageRef = useRef<HTMLImageElement>(null)
  const [imageLabelLeft, setImageLabelLeft] = useState(8)

  const copyErrorTooltip = useTooltip()
  const copyRawUrlsTooltip = useTooltip()
  const viewRawResponseTooltip = useTooltip()
  const retryTooltip = useTooltip()

  const clearTextSelection = () => {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
  }

  const task = useMemo(
    () => tasks.find((t) => t.id === detailTaskId) ?? null,
    [tasks, detailTaskId],
  )

  // Reset index when task changes
  useEffect(() => {
    setImageIndex(0)
    setPromptExpanded(false)
  }, [detailTaskId])

  useEffect(() => {
    if (task?.status !== 'running' && !(task?.status === 'error' && task.customRecoverable)) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => window.clearInterval(id)
  }, [task?.customRecoverable, task?.status])

  // 加载所有相关图片
  useEffect(() => {
    if (!task) {
      setImageSrcs({})
      setOutputPreviewSrcs({})
      setImageRatios({})
      setImageSizes({})
      return
    }

    let cancelled = false
    const ids = [
      ...new Set([...(task.inputImageIds || []), ...(task.maskImageId ? [task.maskImageId] : [])]),
    ]
    // 按图片 id 存，读的时候只认当前任务的 id，所以不清空上一条任务的条目：
    // task 对象每次 store 更新都会换引用，清空会让已经显示的参考图闪一下。
    for (const id of ids) {
      void loadImageOriginal(id).then((url) => {
        if (!cancelled && url) setImageSrcs((prev) => ({ ...prev, [id]: url }))
      })
    }

    return () => {
      cancelled = true
    }
  }, [task])

  const currentOutputImageId = task?.outputImages?.[imageIndex] || ''
  const currentOutputPreviewSrc = currentOutputImageId
    ? outputPreviewSrcs[currentOutputImageId] || ''
    : ''
  const maskTargetId = task?.maskTargetImageId || null
  const maskTargetSrc = maskTargetId ? imageSrcs[maskTargetId] || '' : ''
  const maskSrc = task?.maskImageId ? imageSrcs[task.maskImageId] || '' : ''
  const allInputImageIds = task?.inputImageIds ?? []
  // 大图读原图要几秒（本机图是几 MB 的 dataURL，平台图还要下载再转 base64）。
  // 缩略图先铺上去，面板就不会黑着等；原图到了再换，尺寸角标只认原图或缩略图记的原始宽高。
  const outputThumbnail = useImagePreview(currentOutputImageId || undefined)
  const outputDisplaySrc = currentOutputPreviewSrc || outputThumbnail?.url || ''
  const outputOriginalPending = Boolean(currentOutputImageId) && !currentOutputPreviewSrc

  useEffect(() => {
    if (!currentOutputImageId) {
      setOutputPreviewSrcs({})
      return
    }

    let cancelled = false
    void loadImageOriginal(currentOutputImageId).then((url) => {
      if (!cancelled) setOutputPreviewSrcs(url ? { [currentOutputImageId]: url } : {})
    })

    return () => {
      cancelled = true
    }
  }, [currentOutputImageId])

  // 缩略图记的是原图宽高，角标不用等原图读完。
  useEffect(() => {
    const width = outputThumbnail?.width
    const height = outputThumbnail?.height
    if (!currentOutputImageId || !width || !height) return
    setImageRatios((prev) => ({ ...prev, [currentOutputImageId]: formatImageRatio(width, height) }))
    setImageSizes((prev) => ({ ...prev, [currentOutputImageId]: `${width}×${height}` }))
  }, [currentOutputImageId, outputThumbnail?.width, outputThumbnail?.height])

  useEffect(() => {
    const updateImageLabelLeft = () => {
      const panel = imagePanelRef.current
      const image = mainImageRef.current
      if (!panel || !image) return

      const panelRect = panel.getBoundingClientRect()
      const imageRect = image.getBoundingClientRect()
      setImageLabelLeft(Math.max(8, imageRect.left - panelRect.left))
    }

    updateImageLabelLeft()
    window.addEventListener('resize', updateImageLabelLeft)
    return () => window.removeEventListener('resize', updateImageLabelLeft)
  }, [outputDisplaySrc])

  useEffect(() => {
    let cancelled = false
    setMaskPreviewSrc('')
    if (!maskTargetSrc || !maskSrc) return

    createMaskPreviewDataUrl(maskTargetSrc, maskSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [maskTargetSrc, maskSrc])

  if (!task) return null

  const outputLen = task.outputImages?.length || 0
  const currentImageRatio = currentOutputImageId ? imageRatios[currentOutputImageId] : ''
  const currentImageSize = currentOutputImageId ? imageSizes[currentOutputImageId] : ''
  const currentActualParams = currentOutputImageId
    ? task.actualParamsByImage?.[currentOutputImageId]
    : undefined
  const currentRevisedPrompt = currentOutputImageId
    ? task.revisedPromptByImage?.[currentOutputImageId]?.trim()
    : ''
  const showRevisedPrompt = Boolean(
    currentRevisedPrompt && currentRevisedPrompt !== task.prompt.trim(),
  )
  const codexCliPromptKey = getCodexCliPromptKey(settings)
  const activeProfileForCheck = getActiveApiProfile(settings)
  const activeCodexCli =
    activeProfileForCheck.source === 'user-byok' && activeProfileForCheck.preferences.codexCli
  const hasHandledPromptWarning =
    activeCodexCli || dismissedCodexCliPrompts.includes(codexCliPromptKey)
  const taskProvider = task.apiProvider
  const isOpenAiTask = (taskProvider ?? 'openai') === 'openai'
  const showPromptWarning = Boolean(
    isOpenAiTask &&
      currentOutputImageId &&
      (!currentRevisedPrompt || showRevisedPrompt) &&
      !hasHandledPromptWarning,
  )
  const taskProviderName = taskProvider
    ? getApiProviderLabel(settings, taskProvider)
    : t('common:state.unknown')
  const taskProfileName = task.apiProfileName || t('common:state.unknown')
  const taskModel = task.apiModel || t('common:state.unknown')
  const showSourceInfo = Boolean(task.apiProvider || task.apiProfileName || task.apiModel)
  const isCustomReconnecting = task.status === 'error' && task.customRecoverable
  const rawImageUrls = task.rawImageUrls ?? []

  const formatTime = (ts: number | null) => {
    if (!ts) return ''
    return formatDateTime(ts)
  }

  const formatDuration = () => {
    if (task.status === 'running' || isCustomReconnecting) {
      const seconds = Math.max(0, Math.floor((now - task.createdAt) / 1000))
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      return `${mm}:${ss}`
    }
    if (task.elapsed == null) return null
    const seconds = Math.floor(task.elapsed / 1000)
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const handleReuse = () => {
    reuseConfig(task)
    setDetailTaskId(null)
  }

  const handleEdit = () => {
    void editOutputImage(task, task.outputImages?.[imageIndex])
    setDetailTaskId(null)
  }

  const handleSendToCanvas = () => {
    // 送当前正在查看的这张输出图进创作模式画布（会切换 appMode，需关闭本弹窗）。
    void sendTaskToCanvas(task, task.outputImages?.[imageIndex])
    setDetailTaskId(null)
  }

  const handleDelete = () => {
    setDetailTaskId(null)
    setConfirmDialog({
      title: t('action.deleteRecord'),
      message: t('confirm.deleteMessage'),
      action: () => removeTask(task),
    })
  }

  const handleToggleFavorite = () => {
    updateTaskInStore(task.id, { isFavorite: !task.isFavorite })
  }

  const handleCopyError = async () => {
    const errorText = task.error || t('detail.generateFailed')
    try {
      await copyTextToClipboard(errorText)
      showToast(t('detail.errorCopied'), 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(t('detail.copyErrorFailed'), err), 'error')
    }
  }

  const handleCopyPrompt = async () => {
    if (!task.prompt) return
    try {
      await copyTextToClipboard(task.prompt)
      showToast(t('detail.promptCopied'), 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(t('detail.copyPromptFailed'), err), 'error')
    }
  }

  const handleShowPromptWarning = () => {
    showCodexCliPrompt(
      t(currentRevisedPrompt ? 'detail.promptRevisedReason' : 'detail.promptMissingReason'),
    )
  }

  const handleCopyInputImage = async () => {
    const imgId = allInputImageIds[0]
    const src = imgId ? imageSrcs[imgId] : ''
    if (!src) return
    try {
      const res = await fetch(src)
      const blob = await res.blob()
      await copyBlobToClipboard(blob)
      showToast(t('detail.referenceCopied'), 'success')
    } catch (err) {
      console.error(err)
      showToast(getClipboardFailureMessage(t('detail.copyReferenceFailed'), err), 'error')
    }
  }

  const handleRetry = () => {
    retryTask(task)
    setDetailTaskId(null)
  }

  return (
    <>
      <Overlay onClose={() => setDetailTaskId(null)} tier="modal">
        <div className="relative bg-card/90 backdrop-blur-xl border border-white/50 border-border rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row z-10 ring-1 ring-black/5 dark:ring-white/10 animate-modal-in">
          <div className="flex h-14 items-center justify-end px-4 md:hidden">
            <button
              onClick={() => setDetailTaskId(null)}
              className="p-1 rounded-full hover:bg-muted transition text-muted-foreground"
              aria-label={t('common:action.close')}
            >
              <CloseIcon className="w-6 h-6" />
            </button>
          </div>

          {/* 左侧：图片 */}
          <div
            ref={imagePanelRef}
            className="md:w-1/2 w-full h-64 md:h-auto bg-muted dark:bg-black/20 relative flex items-center justify-center flex-shrink-0 min-h-[16rem]"
          >
            {task.status === 'done' && outputLen > 0 && outputDisplaySrc && (
              <>
                <img
                  ref={mainImageRef}
                  src={outputDisplaySrc}
                  data-image-id={currentOutputImageId}
                  decoding="async"
                  className="saveable-image max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] object-contain cursor-pointer"
                  onLoad={() => {
                    const panel = imagePanelRef.current
                    const image = mainImageRef.current
                    if (!panel || !image) return

                    if (
                      currentOutputImageId &&
                      !outputOriginalPending &&
                      image.naturalWidth > 0 &&
                      image.naturalHeight > 0
                    ) {
                      setImageRatios((prev) => ({
                        ...prev,
                        [currentOutputImageId]: formatImageRatio(
                          image.naturalWidth,
                          image.naturalHeight,
                        ),
                      }))
                      setImageSizes((prev) => ({
                        ...prev,
                        [currentOutputImageId]: `${image.naturalWidth}×${image.naturalHeight}`,
                      }))
                    }

                    const panelRect = panel.getBoundingClientRect()
                    const imageRect = image.getBoundingClientRect()
                    setImageLabelLeft(Math.max(8, imageRect.left - panelRect.left))
                  }}
                  onClick={() =>
                    setLightboxImageId(task.outputImages[imageIndex], task.outputImages)
                  }
                  alt=""
                />
                {outputOriginalPending && (
                  <span
                    className="absolute bottom-3 right-3 flex items-center gap-1 rounded bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur-sm"
                    aria-live="polite"
                  >
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                    {t('detail.loadingOriginal')}
                  </span>
                )}
                <div
                  data-selectable-text
                  className="absolute top-[15px] flex items-center gap-1.5"
                  style={{ left: imageLabelLeft }}
                >
                  {currentImageRatio && currentImageSize ? (
                    <>
                      <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                        {currentImageRatio}
                      </span>
                      <span className="bg-black/50 text-white/90 text-xs px-2 py-0.5 rounded backdrop-blur-sm font-medium">
                        {currentImageSize}
                      </span>
                    </>
                  ) : (
                    formatDuration() && (
                      <span className="flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        {formatDuration()}
                      </span>
                    )
                  )}
                </div>
                {outputLen > 1 && (
                  <>
                    <button
                      onClick={() => setImageIndex((imageIndex - 1 + outputLen) % outputLen)}
                      className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 19l-7-7 7-7"
                        />
                      </svg>
                    </button>
                    <button
                      onClick={() => setImageIndex((imageIndex + 1) % outputLen)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </button>
                    <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                      {imageIndex + 1} / {outputLen}
                    </span>
                  </>
                )}
              </>
            )}
            {task.status === 'done' && outputLen > 0 && !outputDisplaySrc && (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <LoaderCircle className="h-8 w-8 animate-spin text-primary" />
                <span className="text-xs">{t('detail.loadingImage')}</span>
              </div>
            )}
            {task.status === 'running' && (
              <>
                <div className="absolute left-4 top-4 flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  {formatDuration()}
                </div>
                {task.status === 'running' && (
                  <svg
                    className="w-10 h-10 text-primary animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                )}
              </>
            )}
            {task.status === 'error' && (
              <div className="w-full max-w-md px-4 text-center">
                <svg
                  className="w-10 h-10 text-destructive mx-auto mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p
                  className="overflow-hidden whitespace-pre-line text-sm leading-6 text-destructive break-words"
                  style={{
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 4,
                  }}
                >
                  {task.error || t('detail.generateFailed')}
                </p>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <div className="relative group">
                    <button
                      type="button"
                      {...copyErrorTooltip.handlers}
                      onClick={(e) => {
                        copyErrorTooltip.handlers.onClick()
                        handleCopyError()
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-destructive/80 bg-card/80 px-3 py-1.5 text-destructive transition hover:bg-destructive/10 dark:border-destructive/20 dark:hover:bg-destructive/10"
                      aria-label={t('detail.copyFullError')}
                    >
                      <CopyIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip
                      visible={copyErrorTooltip.visible}
                      className="whitespace-nowrap"
                    >
                      {t('detail.copyFullError')}
                    </ViewportTooltip>
                  </div>
                  {task.rawResponsePayload && (
                    <div className="relative group">
                      <button
                        type="button"
                        {...viewRawResponseTooltip.handlers}
                        onClick={(e) => {
                          dismissAllTooltips()
                          setShowRawResponseModal(true)
                        }}
                        className="inline-flex items-center justify-center rounded-full border border-primary/80 bg-primary/10 px-3 py-1.5 text-primary transition hover:bg-primary/10"
                        aria-label={t('detail.viewRawResponse')}
                      >
                        <CodeIcon className="h-4 w-4" />
                      </button>
                      <ViewportTooltip
                        visible={viewRawResponseTooltip.visible}
                        className="whitespace-nowrap"
                      >
                        {t('detail.viewRawResponse')}
                      </ViewportTooltip>
                    </div>
                  )}
                  {task.rawImageUrls && task.rawImageUrls.length > 0 && (
                    <div className="relative group">
                      <button
                        type="button"
                        {...copyRawUrlsTooltip.handlers}
                        onClick={async (e) => {
                          if (task.rawImageUrls!.length === 1) {
                            copyRawUrlsTooltip.handlers.onClick()
                            try {
                              await copyTextToClipboard(task.rawImageUrls![0])
                              showToast(t('detail.imageUrlCopied'), 'success')
                            } catch (err) {
                              showToast(
                                getClipboardFailureMessage(t('detail.copyLinkFailed'), err),
                                'error',
                              )
                            }
                          } else {
                            dismissAllTooltips()
                            setShowRawUrlsModal(true)
                          }
                        }}
                        className="inline-flex items-center justify-center rounded-full border border-success/80 bg-success/10 px-3 py-1.5 text-success transition hover:bg-success/10 dark:border-success/20 dark:bg-success/10 dark:text-success dark:hover:bg-success/20"
                        aria-label={t('detail.copyImageUrls')}
                      >
                        <LinkIcon className="h-4 w-4" />
                      </button>
                      <ViewportTooltip
                        visible={copyRawUrlsTooltip.visible}
                        className="whitespace-nowrap"
                      >
                        {t('detail.copyImageUrls')}
                      </ViewportTooltip>
                    </div>
                  )}
                  <div className="relative group">
                    <button
                      type="button"
                      {...retryTooltip.handlers}
                      onClick={(e) => {
                        retryTooltip.handlers.onClick()
                        handleRetry()
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-primary/80 bg-card/80 px-3 py-1.5 text-primary transition hover:bg-primary/10"
                      aria-label={t('action.retryTask')}
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    </button>
                    <ViewportTooltip visible={retryTooltip.visible} className="whitespace-nowrap">
                      {t('action.retryTask')}
                    </ViewportTooltip>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 右侧：信息 */}
          <div className="md:w-1/2 w-full p-5 overflow-y-auto overscroll-contain flex flex-col">
            <button
              onClick={() => setDetailTaskId(null)}
              className="absolute top-3 right-3 hidden p-1 rounded-full hover:bg-muted transition text-muted-foreground z-10 md:block"
              aria-label={t('common:action.close')}
            >
              <CloseIcon className="w-5 h-5" />
            </button>

            <div data-selectable-text className="flex-1">
              <div className="flex items-center gap-1.5 mb-2">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('detail.inputSection')}
                </h3>
                {task.prompt && (
                  <button
                    onClick={handleCopyPrompt}
                    className="p-1 rounded text-muted-foreground hover:bg-muted transition"
                    title={t('detail.copyPrompt')}
                  >
                    <CopyIcon className="h-4 w-4" />
                  </button>
                )}
                {showPromptWarning && (
                  <span className="relative inline-flex">
                    <button
                      type="button"
                      className="p-1 rounded text-warning hover:bg-warning/10 dark:text-warning dark:hover:bg-warning/10 transition"
                      onClick={handleShowPromptWarning}
                      aria-label={t('detail.promptRevised')}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                        />
                      </svg>
                    </button>
                  </span>
                )}
              </div>
              <p
                className={`text-sm text-foreground dark:text-foreground leading-relaxed whitespace-pre-wrap ${
                  promptExpanded ? 'mb-1' : 'line-clamp-4 mb-1'
                }`}
              >
                {task.prompt || t('prompt.empty')}
              </p>
              {(task.prompt?.length ?? 0) > 120 && (
                <button
                  onClick={() => setPromptExpanded((v) => !v)}
                  className="mb-3 text-xs text-primary hover:text-primary transition"
                >
                  {promptExpanded ? t('common:action.collapse') : t('detail.expandAll')}
                </button>
              )}
              {(task.prompt?.length ?? 0) <= 120 && <span className="block mb-3" />}
              {showRevisedPrompt && currentRevisedPrompt && (
                <div className="mb-4">
                  <ActualValueBadge
                    value={currentRevisedPrompt}
                    className="max-w-full rounded px-2 py-1 text-left text-xs leading-relaxed whitespace-pre-wrap"
                  />
                </div>
              )}

              {/* 参考图 */}
              {allInputImageIds.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-1.5 mb-2">
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      {t('detail.referenceSection')}
                    </h3>
                    <button
                      onClick={handleCopyInputImage}
                      className="p-1 rounded text-muted-foreground hover:bg-muted transition"
                      title={t('detail.copyReference')}
                    >
                      <CopyIcon className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {allInputImageIds.map((imgId) => {
                      const isMaskTarget = imgId === maskTargetId
                      return (
                        <div key={imgId} className="relative group inline-block">
                          <div
                            className={`relative w-16 h-16 rounded-lg overflow-hidden border cursor-pointer hover:opacity-80 transition ${
                              isMaskTarget ? 'border-primary border-2 shadow-sm' : 'border-border'
                            }`}
                            onClick={() => setLightboxImageId(imgId, allInputImageIds)}
                          >
                            <ReferenceThumb
                              imageId={imgId}
                              overrideSrc={isMaskTarget ? maskPreviewSrc : ''}
                            />
                            {isMaskTarget && (
                              <span className="absolute left-1 top-1 rounded bg-primary/90 px-1.5 py-0.5 text-[8px] leading-none text-primary-foreground font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
                                MASK
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 参数 */}
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {t('detail.paramsSection')}
              </h3>
              {showSourceInfo && (
                <div className="mb-2 rounded-lg bg-card px-3 py-2 text-xs">
                  <span className="text-muted-foreground">{t('detail.source')}</span>
                  <br />
                  <span className="font-medium text-foreground">{taskProviderName}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {taskProfileName} · {taskModel}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs mb-4">
                <div className="bg-card rounded-lg px-3 py-2">
                  <span className="text-muted-foreground">{t('param.size')}</span>
                  <br />
                  <DetailParamValue
                    task={task}
                    paramKey="size"
                    className="font-medium"
                    actualParams={currentActualParams}
                  />
                </div>
                <div className="bg-card rounded-lg px-3 py-2">
                  <span className="text-muted-foreground">{t('param.quality')}</span>
                  <br />
                  <DetailParamValue
                    task={task}
                    paramKey="quality"
                    className="font-medium"
                    actualParams={currentActualParams}
                  />
                </div>
                <div className="bg-card rounded-lg px-3 py-2">
                  <span className="text-muted-foreground">{t('param.format')}</span>
                  <br />
                  <DetailParamValue
                    task={task}
                    paramKey="output_format"
                    className="font-medium"
                    actualParams={currentActualParams}
                  />
                </div>
                <div className="bg-card rounded-lg px-3 py-2">
                  <span className="text-muted-foreground">{t('param.moderation')}</span>
                  <br />
                  <DetailParamValue
                    task={task}
                    paramKey="moderation"
                    className="font-medium"
                    actualParams={currentActualParams}
                  />
                </div>
                <div className="bg-card rounded-lg px-3 py-2">
                  <span className="text-muted-foreground">{t('param.count')}</span>
                  <br />
                  <DetailParamValue task={task} paramKey="n" className="font-medium" />
                </div>
                {task.params.output_compression != null && (
                  <div className="bg-card rounded-lg px-3 py-2">
                    <span className="text-muted-foreground">{t('param.compression')}</span>
                    <br />
                    <DetailParamValue
                      task={task}
                      paramKey="output_compression"
                      className="font-medium"
                      actualParams={currentActualParams}
                    />
                  </div>
                )}
              </div>

              {/* 时间 */}
              <div className="text-xs text-muted-foreground mb-4">
                <span>{t('detail.createdAt', { time: formatTime(task.createdAt) })}</span>
                {formatDuration() && (
                  <span> · {t('detail.elapsed', { duration: formatDuration() })}</span>
                )}
              </div>
            </div>

            {/* 操作按钮：三个主操作带文字均分；删除 / 收藏为图标小方钮，避免一行挤爆 */}
            <div className="grid grid-cols-8 sm:flex gap-2 pt-4 border-t border-border">
              <button
                onClick={handleReuse}
                className="col-span-4 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/10 transition text-sm font-medium whitespace-nowrap"
              >
                <svg
                  className="w-4 h-4 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                  />
                </svg>
                {t('action.reuse')}
              </button>
              <button
                onClick={handleEdit}
                disabled={!outputLen}
                className="col-span-4 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-success/10 dark:bg-success/10 text-success dark:text-success hover:bg-success/10 dark:hover:bg-success/20 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
              >
                <EditIcon className="w-4 h-4 flex-shrink-0" />
                {t('action.editOutput')}
              </button>
              <button
                onClick={handleSendToCanvas}
                disabled={!outputLen}
                className="col-span-4 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
              >
                <svg
                  className="w-4 h-4 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5z M4 15l4-4a2 2 0 012.8 0l4 4 M14 13l1.5-1.5a2 2 0 012.8 0L20 13 M9 9a1 1 0 100-2 1 1 0 000 2z"
                  />
                </svg>
                {t('action.sendToCanvas')}
              </button>
              <button
                onClick={handleDelete}
                className="col-span-2 sm:flex-none sm:w-11 w-full flex items-center justify-center rounded-xl bg-destructive/10 dark:bg-destructive/10 text-destructive dark:text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20 transition"
                title={t('action.deleteRecord')}
              >
                <TrashIcon className="w-5 h-5" />
              </button>
              <button
                onClick={handleToggleFavorite}
                className={`col-span-2 sm:flex-none sm:w-11 w-full flex items-center justify-center rounded-xl transition ${
                  task.isFavorite
                    ? 'bg-warning/10 text-warning hover:bg-warning/10 dark:bg-warning/10 dark:hover:bg-warning/20'
                    : 'bg-card text-muted-foreground hover:bg-warning/10 hover:text-warning dark:hover:bg-warning/10'
                }`}
                title={t(task.isFavorite ? 'action.unfavorite' : 'action.favorite')}
              >
                <svg
                  className="w-5 h-5"
                  fill={task.isFavorite ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </Overlay>

      {showRawUrlsModal && rawImageUrls.length > 0 && (
        <Overlay onClose={() => setShowRawUrlsModal(false)} tier="raised">
          <div className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
              <h3 className="text-base font-semibold text-foreground dark:text-white">
                {t('rawUrls.title', { n: rawImageUrls.length })}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(rawImageUrls.join('\n'))
                      showToast(t('common:toast.copySucceeded'), 'success')
                    } catch (err) {
                      showToast(
                        getClipboardFailureMessage(t('common:toast.copyFailed'), err),
                        'error',
                      )
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-card text-muted-foreground hover:bg-muted transition-colors text-xs font-medium"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  {t('detail.copyAll')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawUrlsModal(false)}
                  className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-muted-foreground transition-colors"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5 bg-card/50 dark:bg-black/20 overscroll-contain">
              <div className="space-y-2.5">
                {rawImageUrls.map((url, i) => (
                  <div
                    key={i}
                    className="group flex items-center gap-3 p-3 sm:p-4 rounded-xl bg-card border border-border shadow-sm hover:shadow-md transition-all"
                  >
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <div className="text-xs font-medium text-muted-foreground">
                        {t('rawUrls.imageIndex', { n: i + 1 })}
                      </div>
                      <div className="text-sm text-foreground truncate select-text" title={url}>
                        {url}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await copyTextToClipboard(url)
                          showToast(t('common:toast.copySucceeded'), 'success')
                        } catch (err) {
                          showToast(
                            getClipboardFailureMessage(t('common:toast.copyFailed'), err),
                            'error',
                          )
                        }
                      }}
                      className="flex-shrink-0 p-2 sm:px-3 sm:py-1.5 flex items-center justify-center gap-1.5 rounded-lg bg-card text-muted-foreground hover:bg-muted transition-colors text-xs font-medium border border-transparent border-border"
                      title={t('rawUrls.copyLink')}
                    >
                      <CopyIcon className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                      <span className="hidden sm:inline">{t('common:action.copy')}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Overlay>
      )}

      {showRawResponseModal && task?.rawResponsePayload && (
        <Overlay onClose={() => setShowRawResponseModal(false)} tier="raised">
          <div
            className="flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
            onPointerDown={(e) => {
              if (!(e.target as Element).closest('[data-selectable-text]')) clearTextSelection()
            }}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
              <h3 className="text-base font-semibold text-foreground dark:text-white">
                {t('rawResponse.title')}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(task.rawResponsePayload!)
                      showToast(t('common:toast.copySucceeded'), 'success')
                    } catch (err) {
                      showToast(
                        getClipboardFailureMessage(t('common:toast.copyFailed'), err),
                        'error',
                      )
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-card text-muted-foreground hover:bg-muted transition-colors text-xs font-medium"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  {t('detail.copyAll')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawResponseModal(false)}
                  className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-muted-foreground transition-colors"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 bg-card/50 dark:bg-black/20 overscroll-contain">
              <pre
                data-selectable-text
                className="text-[11px] sm:text-xs text-muted-foreground font-mono whitespace-pre-wrap break-all select-text"
              >
                {task.rawResponsePayload.replace(
                  /"(b64_json|base64|data)":\s*"[^"]+"/g,
                  '"$1": "<base64_data>"',
                )}
              </pre>
            </div>
          </div>
        </Overlay>
      )}
    </>
  )
}

/**
 * 参考图先铺缩略图：原图（遮罩预览要用它合成）动辄几 MB，等它读完这格就一直空着。
 * `overrideSrc` 给遮罩目标用——合成好的预览优先于任何一张原图。
 */
function ReferenceThumb({ imageId, overrideSrc }: { imageId: string; overrideSrc: string }) {
  const preview = useImagePreview(imageId)
  const src = overrideSrc || preview?.url || ''
  if (!src) return <div className="h-full w-full animate-pulse bg-muted" />
  return (
    <img
      src={src}
      data-image-id={imageId}
      decoding="async"
      className="w-full h-full object-cover"
      alt=""
    />
  )
}
