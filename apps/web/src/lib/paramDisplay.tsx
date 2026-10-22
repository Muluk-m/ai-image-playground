import { useState } from 'react'
import { Hint } from '../components/assistant-ui/elements/tooltip-icon-button'
import { useTranslation } from '../i18n'
import type { TaskParams, TaskRecord } from '../types'
import { measuredSizeOf, sameAspectRatio, validMeasuredSize } from './size'

export { measuredSizeOf }

type ParamKey = keyof TaskParams

interface ParamValueProps {
  task: TaskRecord
  paramKey: ParamKey
  className?: string
  actualParams?: Partial<TaskParams>
  /** 产出图的真实像素（`宽x高`），只对 size 生效。 */
  measuredSize?: string
}

interface ActualValueBadgeProps {
  value: string
  className?: string
  variant?: 'highlight' | 'normal'
  /** 单行截断，窄卡片标签用；详情弹窗里 revised prompt 要多行完整显示，不能开。 */
  truncate?: boolean
}

export function ActualValueBadge({
  value,
  className = '',
  variant = 'highlight',
  truncate = false,
}: ActualValueBadgeProps) {
  const { t } = useTranslation('lib')
  // 触屏没有悬停，点一下也要能看到说明，所以由这里控制显隐。
  const [open, setOpen] = useState(false)
  const colorClass =
    variant === 'normal'
      ? 'bg-muted text-muted-foreground'
      : 'bg-warning/10 text-warning dark:bg-warning/20 dark:text-warning'

  return (
    <Hint tooltip={t('param.actualResponseValue')} open={open} onOpenChange={setOpen}>
      <span
        className={`inline-flex cursor-help ${colorClass} ${className}`}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
      >
        {/* 容器是 inline-flex，省略号得落在内层块上才生效。 */}
        {truncate ? (
          <span className="min-w-0 truncate" title={value}>
            {value}
          </span>
        ) : (
          value
        )}
      </span>
    </Hint>
  )
}

/**
 * 这条任务的上游按不按 `size` 出图。Gemini 只认比例与分辨率档，参数面板里那个 OpenAI 写法的
 * `size`（默认 1024x1024）会随请求带过去，但它从来不决定像素，拿它当「请求的尺寸」只会误导。
 */
export function honorsRequestedSize(task: Pick<TaskRecord, 'apiProvider' | 'cloudProvider'>) {
  // 与详情「来源」同一优先级：本机 profile 的 provider 在前，镜像卡才退到平台记录的 provider。
  const provider = task.apiProvider || task.cloudProvider
  return provider !== 'gemini' && provider !== 'gemini-queue'
}

/**
 * 参数的请求值与实际值。
 *
 * `measuredSize` 是产出图的真实像素（卡片缩略图记下的宽高、详情里解码出的尺寸），给了就压过一切：
 * 上游回报的 size 可能缺（Gemini、Grok）也可能不准，请求值更不是结果。
 */
export function getParamDisplay(
  task: TaskRecord,
  paramKey: ParamKey,
  actualParams = task.actualParams,
  measuredSize?: string,
) {
  const isSize = paramKey === 'size'
  const requestedValue = isSize && !honorsRequestedSize(task) ? 'auto' : task.params[paramKey]
  // 实测像素来自缓存或平台响应，先校验格式；不合法就当没测到，退回已验证的回报值或请求值。
  const measured = validMeasuredSize(measuredSize) ?? validMeasuredSize(task.measuredSize)
  // 不按 size 出图的上游，回报或落库的 size 都只是随请求带过去的占位，只认真实像素。
  const actualValue = isSize
    ? (measured ?? (honorsRequestedSize(task) ? actualParams?.size : undefined))
    : actualParams?.[paramKey]
  const hasActualValue = actualValue !== undefined && actualValue !== null
  const displayValue = hasActualValue ? actualValue : requestedValue
  const isMismatch =
    hasActualValue &&
    requestedValue !== 'auto' &&
    String(actualValue) !== String(requestedValue) &&
    !(isSize && sameAspectRatio(String(requestedValue), String(actualValue)))

  return {
    displayValue: String(displayValue),
    hasActualValue,
    isMismatch,
    requestedValue: String(requestedValue),
    // 不按 size 出图的上游没有「请求了 auto」这回事，实际像素直接就是答案。
    isAutoResolved:
      hasActualValue &&
      requestedValue === 'auto' &&
      !(isSize && !honorsRequestedSize(task)) &&
      String(actualValue) !== String(requestedValue),
  }
}

export function ParamValue({
  task,
  paramKey,
  className = '',
  actualParams,
  measuredSize,
}: ParamValueProps) {
  const { displayValue, isMismatch } = getParamDisplay(task, paramKey, actualParams, measuredSize)

  if (isMismatch) {
    return <ActualValueBadge value={displayValue} className={className} />
  }

  return <span className={`${className} bg-muted text-muted-foreground`}>{displayValue}</span>
}

export function DetailParamValue({
  task,
  paramKey,
  className = '',
  actualParams,
  measuredSize,
}: ParamValueProps) {
  const { displayValue, isMismatch, requestedValue, isAutoResolved } = getParamDisplay(
    task,
    paramKey,
    actualParams,
    measuredSize,
  )

  if (!isMismatch) {
    if (isAutoResolved) {
      return (
        <span className={`inline-flex items-center gap-1 ${className}`}>
          <span className="text-foreground">{requestedValue}</span>
          <span className="text-foreground">|</span>
          <ActualValueBadge value={displayValue} variant="normal" className="rounded px-1 py-0.5" />
        </span>
      )
    }
    return <span className={`text-foreground ${className}`}>{displayValue}</span>
  }

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className="text-foreground">{requestedValue}</span>
      <span className="text-foreground">|</span>
      <ActualValueBadge value={displayValue} className="rounded px-1 py-0.5" />
    </span>
  )
}
