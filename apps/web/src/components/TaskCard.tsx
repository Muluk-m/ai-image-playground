import { formatImageRatio } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { taskExportSources } from '../features/image-export/sources'
import { openImageExport } from '../features/image-export/store'
import { useImagePreview } from '../hooks/useImagePreview'
import { useTranslation } from '../i18n'
import { ActualValueBadge, getParamDisplay } from '../lib/paramDisplay'
import { retryTask, setTaskFavorite, useStore } from '../store'
import type { TaskRecord } from '../types'
import { Hint } from './assistant-ui/elements/tooltip-icon-button'
import { compactModelName, ModelLogo } from './ModelIdentity'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

/** task-pop-in 入场动画窗口；超过这个秒数后 mount 的 task 视作历史回放，不再播。 */
const FRESH_POP_IN_WINDOW_MS = 600

interface Props {
  task: TaskRecord
  onReuse: () => void
  onEditOutputs: () => void
  onSendToCanvas: () => void
  onDelete: () => void
  onClick: (e: React.MouseEvent | React.TouchEvent) => void
  isSelected?: boolean
}

export default function TaskCard({
  task,
  onReuse,
  onEditOutputs,
  onSendToCanvas,
  onDelete,
  onClick,
  isSelected,
}: Props) {
  const { t } = useTranslation(['task', 'common'])
  const preview = useImagePreview(task.outputImages?.[0])
  const thumbSrc = preview?.url ?? ''
  // 平台图只有 URL、没有宽高，此时不渲染角标，别给用户一个空壳子。
  const coverBadges =
    preview?.width && preview.height
      ? {
          ratio: formatImageRatio(preview.width, preview.height),
          size: `${preview.width}×${preview.height}`,
        }
      : null
  const [now, setNow] = useState(Date.now())
  // 仅给「页面运行期间刚提交的卡片」播放一次入场动画。CSS keyframes 本身只在
  // mount 时播放一次，所以 useRef 锁定 mount 时刻的判定即可——不需要 state +
  // timer 去摘除 className（即便保留也只是 DOM 节点上一个无副作用的 class）。
  // 历史任务从 IndexedDB rehydrate 时 createdAt 通常远超窗口，不会触发动画。
  const isFreshRef = useRef(Date.now() - task.createdAt < FRESH_POP_IN_WINDOW_MS)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const [swipeStartedSelected, setSwipeStartedSelected] = useState(false)
  const [swipeActionActive, setSwipeActionActive] = useState(false)
  const toggleTaskSelection = useStore((s) => s.toggleTaskSelection)
  const settings = useStore((s) => s.settings)
  const exportLabel = t('download.export')
  const handleExport = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (task.outputImages?.length) openImageExport(taskExportSources([task]))
  }
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeResetTimerRef = useRef<number | null>(null)
  const suppressClickUntilRef = useRef(0)
  const horizontalSwipeRef = useRef(false)

  const isTagScrollTarget = (target: EventTarget | null) => {
    return target instanceof Element && Boolean(target.closest('[data-tag-scroll-area]'))
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isTagScrollTarget(e.target)) {
      touchStartRef.current = null
      horizontalSwipeRef.current = false
      setIsSwiping(false)
      setSwipeOffset(0)
      setSwipeActionActive(false)
      return
    }

    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
      swipeResetTimerRef.current = null
    }
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    horizontalSwipeRef.current = false
    setSwipeStartedSelected(Boolean(isSelected))
    setSwipeActionActive(false)
    setIsSwiping(true)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isTagScrollTarget(e.target)) return
    if (!touchStartRef.current) return
    const deltaX = e.touches[0].clientX - touchStartRef.current.x
    const deltaY = e.touches[0].clientY - touchStartRef.current.y

    // 如果主要是水平滑动
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      horizontalSwipeRef.current = true
      e.preventDefault()
      // 限制滑动距离，例如最大 60px
      const boundedOffset = Math.max(-60, Math.min(60, deltaX))
      setSwipeOffset(boundedOffset)
      setSwipeActionActive(Math.abs(deltaX) >= 40)
    }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isTagScrollTarget(e.target)) {
      touchStartRef.current = null
      horizontalSwipeRef.current = false
      setIsSwiping(false)
      setSwipeOffset(0)
      setSwipeActionActive(false)
      return
    }

    setIsSwiping(false)
    setSwipeOffset(0)

    if (!touchStartRef.current) return
    const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x
    touchStartRef.current = null
    const isSwipeAction = horizontalSwipeRef.current && Math.abs(deltaX) > 40
    horizontalSwipeRef.current = false
    setSwipeActionActive(isSwipeAction)
    swipeResetTimerRef.current = window.setTimeout(() => {
      setSwipeActionActive(false)
      swipeResetTimerRef.current = null
    }, 220)

    // 如果是水平滑动，且垂直偏移较小，认为是滑动选择
    if (isSwipeAction) {
      suppressClickUntilRef.current = Date.now() + 350
      e.preventDefault()
      e.stopPropagation()
      toggleTaskSelection(task.id)
    }
  }

  const handleTouchCancel = () => {
    touchStartRef.current = null
    horizontalSwipeRef.current = false
    setIsSwiping(false)
    setSwipeOffset(0)
    setSwipeActionActive(false)
  }

  useEffect(
    () => () => {
      if (swipeResetTimerRef.current != null) {
        window.clearTimeout(swipeResetTimerRef.current)
      }
    },
    [],
  )

  // 定时更新运行中任务的计时
  useEffect(() => {
    if (task.status !== 'running' && !(task.status === 'error' && task.customRecoverable)) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => clearInterval(id)
  }, [task.customRecoverable, task.status])

  const duration = (() => {
    let seconds: number
    if (task.status === 'running' || task.customRecoverable) {
      seconds = Math.floor((now - task.createdAt) / 1000)
    } else if (task.elapsed != null) {
      seconds = Math.floor(task.elapsed / 1000)
    } else {
      // 平台镜像的记录没有本机耗时，没有就不显示，不要糊一个 00:00 上去。
      return null
    }
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  })()
  const isSwipeReady = Math.abs(swipeOffset) >= 40
  const showSwipeAction = isSwipeReady || swipeActionActive
  const isCustomReconnecting = task.status === 'error' && task.customRecoverable
  const showRunningTimer = task.status === 'running' || isCustomReconnecting
  const runningLabel = task.queuePhase ? t(`card.phase.${task.queuePhase}`) : t('card.generating')
  const swipeBgClass = showSwipeAction
    ? swipeStartedSelected
      ? 'bg-muted'
      : 'bg-primary'
    : 'bg-muted'

  const qualityDisplay = getParamDisplay(task, 'quality')
  const showQuality = task.params.quality !== 'auto' || qualityDisplay.isMismatch

  const sizeDisplay = getParamDisplay(task, 'size')
  const showSize = task.params.size !== 'auto' || sizeDisplay.isMismatch

  const formatDisplay = getParamDisplay(task, 'output_format')
  const showFormat = task.params.output_format !== 'png' || formatDisplay.isMismatch

  const nDisplay = getParamDisplay(task, 'n')
  const showN = task.params.n > 1 || nDisplay.isMismatch

  const showTransparentOutput = Boolean(task.transparentOutput || task.params.transparent_output)
  const model = task.apiModel ?? ''
  const showModel = Boolean(model)

  return (
    <div className="relative rounded-xl">
      {/* 侧滑底图 */}
      <div
        className={`absolute inset-0 rounded-xl flex items-center transition-opacity duration-200 pointer-events-none ${
          isSwiping || swipeOffset || swipeActionActive ? 'opacity-100' : 'opacity-0'
        } ${swipeBgClass} ${swipeOffset > 0 ? 'justify-start pl-6' : 'justify-end pr-6'}`}
      >
        <Icon
          name={swipeStartedSelected && showSwipeAction ? 'close' : 'check'}
          size="lg"
          className={`transition-transform duration-150 ${showSwipeAction ? 'scale-110' : 'scale-90'} ${showSwipeAction && !swipeStartedSelected ? 'text-primary-foreground' : 'text-muted-foreground'}`}
        />
      </div>

      <div
        className={`relative bg-card rounded-xl border overflow-hidden cursor-pointer duration-200 hover:shadow-lg dark:hover:bg-muted/80 ${
          !isSwiping
            ? 'transition-[box-shadow,border-color,background-color,transform]'
            : 'transition-[box-shadow,border-color,background-color]'
        } ${isFreshRef.current ? 'animate-task-pop-in' : ''} ${
          task.status === 'running'
            ? 'border-primary generating'
            : isSelected
              ? 'border-primary shadow-md ring-2 ring-ring/50'
              : 'border-border hover:border-border dark:hover:border-white/[0.18]'
        }`}
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
        }}
        onClick={(e) => {
          if (Date.now() < suppressClickUntilRef.current) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          onClick(e)
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {/* 选中时的角标 */}
        {isSelected && (
          <div className="absolute top-2 right-2 z-10 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow-sm">
            <Icon name="check" size="xs" className="text-primary-foreground" />
          </div>
        )}
        <div className="flex h-40">
          {/* 左侧图片区域 */}
          <div className="w-40 min-w-[10rem] h-full bg-muted dark:bg-black/20 relative flex items-center justify-center overflow-hidden flex-shrink-0">
            {task.status === 'running' && (
              <div className="flex flex-col items-center gap-2">
                <Icon name="loading" size="lg" className="animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">{runningLabel}</span>
              </div>
            )}
            {task.status === 'error' && (
              <div className="flex flex-col items-center gap-1 px-2">
                <Icon name="error" size="lg" className="text-destructive" />
                <span className="text-xs text-destructive text-center leading-tight">
                  {t('common:state.failed')}
                </span>
              </div>
            )}
            {task.status === 'done' && thumbSrc && (
              <>
                <img
                  src={thumbSrc}
                  data-image-id={task.outputImages[0]}
                  className="saveable-image w-full h-full object-cover"
                  loading="lazy"
                  alt=""
                />
                {task.outputImages.length > 1 && (
                  <span className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                    {task.outputImages.length}
                  </span>
                )}
              </>
            )}
            {task.status === 'done' && !thumbSrc && (
              <Icon name="image" size="lg" className="text-muted-foreground" />
            )}
            {/* 运行中显示耗时，完成后显示封面图比例与分辨率标签 */}
            <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
              {!showRunningTimer && task.status === 'done' && coverBadges ? (
                <>
                  <span className="bg-black/50 text-white text-label-sm sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-mono">
                    {coverBadges.ratio}
                  </span>
                  <span className="bg-black/50 text-white/90 text-label-sm sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-medium">
                    {coverBadges.size}
                  </span>
                </>
              ) : (
                duration && (
                  <span className="flex items-center gap-1 bg-black/50 text-white text-label-sm sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-mono">
                    <Icon name="clock" size="xs" />
                    {duration}
                  </span>
                )
              )}
            </div>
          </div>

          {/* 右侧信息区域 */}
          <div className="flex-1 p-3 flex flex-col min-w-0">
            <div className="flex-1 min-h-0 mb-2 overflow-hidden">
              <p className="text-sm text-foreground leading-relaxed line-clamp-3">
                {task.prompt || t('prompt.empty')}
              </p>
            </div>
            <div className="mt-auto flex flex-col gap-1.5">
              {/* 参数与信息：横向滚动 */}
              <div
                data-tag-scroll-area
                className="flex flex-wrap pt-0.5 gap-1.5 min-w-0"
                onTouchStart={(e) => e.stopPropagation()}
                onTouchMove={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
                onTouchCancel={(e) => e.stopPropagation()}
              >
                {/* Model */}
                {showModel && (
                  <span
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-xs flex-shrink-0"
                    title={task.apiModel}
                  >
                    <ModelLogo model={model} />
                    <span>{compactModelName(model, model)}</span>
                  </span>
                )}
                {/* Mask */}
                {task.maskImageId && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs flex-shrink-0">
                    <Icon name="brush" size="xs" />
                    {t('card.inpaint')}
                  </span>
                )}
                {showTransparentOutput && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-success/10 dark:bg-success/10 text-success dark:text-success text-xs flex-shrink-0">
                    {t('card.transparentBackground')}
                  </span>
                )}
                {/* Params: only show if not default or mismatch */}
                {showQuality && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-xs flex-shrink-0">
                    <span className="text-muted-foreground">{t('param.quality')}</span>
                    {qualityDisplay.isMismatch ? (
                      <ActualValueBadge
                        value={qualityDisplay.displayValue}
                        className="px-1 rounded-sm"
                      />
                    ) : (
                      <span className="text-muted-foreground">{qualityDisplay.displayValue}</span>
                    )}
                  </span>
                )}
                {showSize && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-xs flex-shrink-0">
                    <span className="text-muted-foreground">{t('param.size')}</span>
                    {sizeDisplay.isMismatch ? (
                      <ActualValueBadge
                        value={sizeDisplay.displayValue}
                        className="px-1 rounded-sm"
                      />
                    ) : (
                      <span className="text-muted-foreground">{sizeDisplay.displayValue}</span>
                    )}
                  </span>
                )}
                {showFormat && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-xs flex-shrink-0">
                    <span className="text-muted-foreground">{t('param.format')}</span>
                    {formatDisplay.isMismatch ? (
                      <ActualValueBadge
                        value={formatDisplay.displayValue}
                        className="px-1 rounded-sm"
                      />
                    ) : (
                      <span className="text-muted-foreground">{formatDisplay.displayValue}</span>
                    )}
                  </span>
                )}
                {showN && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-xs flex-shrink-0">
                    <span className="text-muted-foreground">{t('param.count')}</span>
                    {nDisplay.isMismatch ? (
                      <ActualValueBadge value={nDisplay.displayValue} className="px-1 rounded-sm" />
                    ) : (
                      <span className="text-muted-foreground">{nDisplay.displayValue}</span>
                    )}
                  </span>
                )}
              </div>
              {/* 操作按钮 */}
              <div
                className="flex w-full items-center justify-between flex-shrink-0 mt-0.5 sm:w-auto sm:justify-end sm:gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                {(task.status === 'error' || settings.alwaysShowRetryButton) && (
                  <Hint tooltip={t('action.retryTask')}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => retryTask(task)}
                      className="text-muted-foreground"
                      aria-label={t('action.retryTask')}
                    >
                      <Icon name="refresh" size="xs" />
                    </Button>
                  </Hint>
                )}
                <Hint tooltip={t(task.isFavorite ? 'action.unfavorite' : 'action.favorite')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void setTaskFavorite(task, !task.isFavorite)}
                    className={
                      task.isFavorite
                        ? 'text-warning hover:text-warning'
                        : 'text-muted-foreground hover:text-warning'
                    }
                    aria-label={t(task.isFavorite ? 'action.unfavorite' : 'action.favorite')}
                    aria-pressed={task.isFavorite}
                  >
                    <Icon name="favorite" size="xs" filled={task.isFavorite} />
                  </Button>
                </Hint>
                <Hint tooltip={t('action.reuse')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onReuse}
                    className="text-muted-foreground"
                    aria-label={t('action.reuse')}
                  >
                    <Icon name="reuse" size="xs" />
                  </Button>
                </Hint>
                <Hint tooltip={t('action.editOutput')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onEditOutputs}
                    className="text-muted-foreground"
                    aria-label={t('action.editOutput')}
                    disabled={!task.outputImages?.length}
                  >
                    <Icon name="edit" size="xs" />
                  </Button>
                </Hint>
                <Hint tooltip={t('action.sendToCanvasTitle')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onSendToCanvas}
                    className="text-muted-foreground"
                    aria-label={t('action.sendToCanvasTitle')}
                    disabled={!task.outputImages?.length}
                  >
                    <Icon name="image" size="xs" />
                  </Button>
                </Hint>
                <Hint tooltip={exportLabel}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleExport}
                    className="text-muted-foreground"
                    aria-label={exportLabel}
                    disabled={!task.outputImages?.length}
                  >
                    <Icon name="download" size="xs" />
                  </Button>
                </Hint>
                <Hint tooltip={t('action.deleteRecord')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onDelete}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('action.deleteRecord')}
                  >
                    <Icon name="delete" size="xs" />
                  </Button>
                </Hint>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
