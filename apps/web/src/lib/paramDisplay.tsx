import { useState } from 'react'
import { Hint } from '../components/assistant-ui/elements/tooltip-icon-button'
import { useTranslation } from '../i18n'
import type { TaskParams, TaskRecord } from '../types'
import { sameAspectRatio } from './size'

type ParamKey = keyof TaskParams

interface ParamValueProps {
  task: TaskRecord
  paramKey: ParamKey
  className?: string
  actualParams?: Partial<TaskParams>
}

interface ActualValueBadgeProps {
  value: string
  className?: string
  variant?: 'highlight' | 'normal'
}

export function ActualValueBadge({
  value,
  className = '',
  variant = 'highlight',
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
        {value}
      </span>
    </Hint>
  )
}

export function getParamDisplay(
  task: TaskRecord,
  paramKey: ParamKey,
  actualParams = task.actualParams,
) {
  const requestedValue = task.params[paramKey]
  const actualValue = actualParams?.[paramKey]
  const hasActualValue = actualValue !== undefined && actualValue !== null
  const displayValue = hasActualValue ? actualValue : requestedValue
  const isMismatch =
    hasActualValue &&
    requestedValue !== 'auto' &&
    String(actualValue) !== String(requestedValue) &&
    !(paramKey === 'size' && sameAspectRatio(String(requestedValue), String(actualValue)))

  return {
    displayValue: String(displayValue),
    isMismatch,
    requestedValue: String(requestedValue),
    isAutoResolved:
      hasActualValue && requestedValue === 'auto' && String(actualValue) !== String(requestedValue),
  }
}

export function ParamValue({ task, paramKey, className = '', actualParams }: ParamValueProps) {
  const { displayValue, isMismatch } = getParamDisplay(task, paramKey, actualParams)

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
}: ParamValueProps) {
  const { displayValue, isMismatch, requestedValue, isAutoResolved } = getParamDisplay(
    task,
    paramKey,
    actualParams,
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
