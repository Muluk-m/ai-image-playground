import { formatImageRatio } from '@image-playground/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHistoryTasks } from '../hooks/useHistoryTasks'
import { useImagePreview } from '../hooks/useImagePreview'
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
import {
  editOutputImage,
  removeTask,
  retryTask,
  reuseConfig,
  sendTaskToCanvas,
  setTaskFavorite,
  useStore,
} from '../store'
import { Hint } from './assistant-ui/elements/tooltip-icon-button'
import Overlay from './Overlay'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

export default function DetailModal() {
  const { t } = useTranslation(['task', 'common'])
  const tasks = useHistoryTasks()
  const detailTaskId = useStore((s) => s.detailTaskId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const settings = useStore((s) => s.settings)

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
  // 云端镜下来的卡没有本机 profile，只有 provider + model：缺的那段不写，不拿「未知」凑数。
  const taskProvider = task.apiProvider || task.cloudProvider
  const sourceParts = [
    taskProvider ? getApiProviderLabel(settings, taskProvider) : '',
    task.apiProfileName ?? '',
    task.apiModel ?? '',
  ].filter(Boolean)
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
    void setTaskFavorite(task, !task.isFavorite)
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

  // 上游按内容安全拒了这次提示词：文案换成可行动的那句，出路是改词再来，不是原样重试。
  const blockedByContentPolicy = task.errorCode === 'content_policy'

  return (
    <>
      <Overlay onClose={() => setDetailTaskId(null)} tier="modal" label={t('detail.dialog')}>
        <div className="relative bg-card/90 backdrop-blur-xl border border-border rounded-3xl shadow-dialog max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row z-10 ring-1 ring-hairline animate-modal-in">
          <div className="flex h-14 items-center justify-end px-4 md:hidden">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setDetailTaskId(null)}
              className="rounded-full text-muted-foreground"
              aria-label={t('common:action.close')}
            >
              <Icon name="close" />
            </Button>
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
                    <Icon name="loading" size="xs" className="animate-spin" />
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
                        <Icon name="clock" size="xs" />
                        {formatDuration()}
                      </span>
                    )
                  )}
                </div>
                {outputLen > 1 && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('common:action.previousImage')}
                      onClick={() => setImageIndex((imageIndex - 1 + outputLen) % outputLen)}
                      className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 text-white hover:bg-black/50 hover:text-white"
                    >
                      <Icon name="chevronLeft" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('common:action.nextImage')}
                      onClick={() => setImageIndex((imageIndex + 1) % outputLen)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 text-white hover:bg-black/50 hover:text-white"
                    >
                      <Icon name="chevronRight" />
                    </Button>
                    <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                      {imageIndex + 1} / {outputLen}
                    </span>
                  </>
                )}
              </>
            )}
            {task.status === 'done' && outputLen > 0 && !outputDisplaySrc && (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Icon name="loading" size="lg" className="animate-spin text-primary" />
                <span className="text-xs">{t('detail.loadingImage')}</span>
              </div>
            )}
            {task.status === 'running' && (
              <>
                <div className="absolute left-4 top-4 flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                  <Icon name="clock" size="xs" />
                  {formatDuration()}
                </div>
                {task.status === 'running' && (
                  <Icon name="loading" size="lg" className="animate-spin text-primary" />
                )}
              </>
            )}
            {task.status === 'error' && (
              <div className="w-full max-w-md px-4 text-center">
                <Icon name="error" size="lg" className="mx-auto mb-2 text-destructive" />
                <p
                  className="overflow-hidden whitespace-pre-line text-sm leading-6 text-destructive break-words"
                  style={{
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 4,
                  }}
                >
                  {blockedByContentPolicy
                    ? t('detail.contentPolicy')
                    : task.error || t('detail.generateFailed')}
                </p>
                {blockedByContentPolicy && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleReuse}
                    className="mt-3 rounded-full"
                  >
                    {t('detail.rewritePrompt')}
                  </Button>
                )}
                <div className="mt-3 flex items-center justify-center gap-2">
                  <Hint tooltip={t('detail.copyFullError')}>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      className="rounded-full"
                      onClick={handleCopyError}
                      aria-label={t('detail.copyFullError')}
                    >
                      <Icon name="copy" />
                    </Button>
                  </Hint>
                  {task.rawResponsePayload && (
                    <Hint tooltip={t('detail.viewRawResponse')}>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="rounded-full"
                        onClick={() => setShowRawResponseModal(true)}
                        aria-label={t('detail.viewRawResponse')}
                      >
                        <Icon name="code" />
                      </Button>
                    </Hint>
                  )}
                  {task.rawImageUrls && task.rawImageUrls.length > 0 && (
                    <Hint tooltip={t('detail.copyImageUrls')}>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="rounded-full"
                        onClick={async () => {
                          if (task.rawImageUrls!.length === 1) {
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
                            setShowRawUrlsModal(true)
                          }
                        }}
                        aria-label={t('detail.copyImageUrls')}
                      >
                        <Icon name="link" />
                      </Button>
                    </Hint>
                  )}
                  {/* 内容安全拒绝原样重试稳定复现，只留改提示词那条出路。 */}
                  {!blockedByContentPolicy && (
                    <Hint tooltip={t('action.retryTask')}>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="rounded-full"
                        onClick={handleRetry}
                        aria-label={t('action.retryTask')}
                      >
                        <Icon name="refresh" />
                      </Button>
                    </Hint>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 右侧：信息 */}
          <div className="md:w-1/2 w-full p-5 overflow-y-auto overscroll-contain flex flex-col">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setDetailTaskId(null)}
              className="absolute right-3 top-3 z-10 hidden rounded-full text-muted-foreground md:inline-flex"
              aria-label={t('common:action.close')}
            >
              <Icon name="close" />
            </Button>

            <div data-selectable-text className="flex-1">
              <div className="flex items-center gap-1.5 mb-2">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('detail.inputSection')}
                </h3>
                {task.prompt && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleCopyPrompt}
                    className="text-muted-foreground"
                    title={t('detail.copyPrompt')}
                    aria-label={t('detail.copyPrompt')}
                  >
                    <Icon name="copy" size="xs" />
                  </Button>
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
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  onClick={() => setPromptExpanded((v) => !v)}
                  className="mb-3 h-auto px-0"
                >
                  {promptExpanded ? t('common:action.collapse') : t('detail.expandAll')}
                </Button>
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={handleCopyInputImage}
                      className="text-muted-foreground"
                      title={t('detail.copyReference')}
                      aria-label={t('detail.copyReference')}
                    >
                      <Icon name="copy" size="xs" />
                    </Button>
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
                              // design-allow arbitrary-font: 64px 缩略图上的角标，DESIGN.md 允许 7–9px
                              <span className="absolute left-1 top-1 rounded bg-primary/90 px-1.5 py-0.5 text-[8px] leading-none text-primary-foreground font-semibold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
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
              {sourceParts.length > 0 && (
                <div className="mb-2 rounded-lg bg-card px-3 py-2 text-xs">
                  <span className="text-muted-foreground">{t('detail.source')}</span>
                  <br />
                  <span className="font-medium text-foreground">{sourceParts[0]}</span>
                  {sourceParts.length > 1 && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {sourceParts.slice(1).join(' · ')}
                    </span>
                  )}
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
              <Button
                type="button"
                variant="secondary"
                onClick={handleReuse}
                className="col-span-4 sm:flex-1"
              >
                <Icon name="reuse" />
                {t('action.reuse')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleEdit}
                disabled={!outputLen}
                className="col-span-4 sm:flex-1"
              >
                <Icon name="edit" />
                {t('action.editOutput')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleSendToCanvas}
                disabled={!outputLen}
                className="col-span-4 sm:flex-1"
              >
                <Icon name="image" />
                {t('action.sendToCanvas')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleDelete}
                className="col-span-2 w-full text-muted-foreground hover:text-destructive sm:w-9"
                title={t('action.deleteRecord')}
                aria-label={t('action.deleteRecord')}
              >
                <Icon name="delete" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleToggleFavorite}
                aria-pressed={task.isFavorite}
                className={`col-span-2 w-full sm:w-9 ${task.isFavorite ? 'text-warning hover:text-warning' : 'text-muted-foreground hover:text-warning'}`}
                title={t(task.isFavorite ? 'action.unfavorite' : 'action.favorite')}
                aria-label={t(task.isFavorite ? 'action.unfavorite' : 'action.favorite')}
              >
                <Icon name="favorite" filled={task.isFavorite} />
              </Button>
            </div>
          </div>
        </div>
      </Overlay>

      {showRawUrlsModal && rawImageUrls.length > 0 && (
        <Overlay
          onClose={() => setShowRawUrlsModal(false)}
          tier="raised"
          label={t('rawUrls.title', { n: rawImageUrls.length })}
        >
          <div className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
              <h3 className="text-base font-semibold text-foreground dark:text-white">
                {t('rawUrls.title', { n: rawImageUrls.length })}
              </h3>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
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
                  className="text-muted-foreground"
                >
                  <Icon name="copy" size="xs" />
                  {t('detail.copyAll')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common:action.close')}
                  onClick={() => setShowRawUrlsModal(false)}
                  className="rounded-full text-muted-foreground"
                >
                  <Icon name="close" />
                </Button>
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
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
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
                      className="shrink-0"
                      title={t('rawUrls.copyLink')}
                      aria-label={t('rawUrls.copyLink')}
                    >
                      <Icon name="copy" size="xs" />
                      <span className="hidden sm:inline">{t('common:action.copy')}</span>
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Overlay>
      )}

      {showRawResponseModal && task?.rawResponsePayload && (
        <Overlay
          onClose={() => setShowRawResponseModal(false)}
          tier="raised"
          label={t('rawResponse.title')}
        >
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
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
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
                  className="text-muted-foreground"
                >
                  <Icon name="copy" size="xs" />
                  {t('detail.copyAll')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common:action.close')}
                  onClick={() => setShowRawResponseModal(false)}
                  className="rounded-full text-muted-foreground"
                >
                  <Icon name="close" />
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 bg-card/50 dark:bg-black/20 overscroll-contain">
              <pre
                data-selectable-text
                className="text-label-sm sm:text-xs text-muted-foreground font-mono whitespace-pre-wrap break-all select-text"
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
