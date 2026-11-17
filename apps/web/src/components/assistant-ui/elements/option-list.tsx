/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */

import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Icon } from '../../ui/icon'
import { paper } from './surfaces'

export interface OptionListOption {
  id: string
  label: string
  description?: string
  disabled?: boolean
  /** 行首徽标，例如 A/B/C。只展示，不参与确认值。 */
  marker?: string
}
export interface OptionListProps extends Omit<ComponentProps<'div'>, 'children' | 'onChange'> {
  options: readonly OptionListOption[]
  onConfirm?: (ids: string[]) => void
  choice?: readonly string[]
  pending?: boolean
  /** 去掉自带的纸面卡片，把行的颜色交给外层样式。 */
  bare?: boolean
  rowClassName?: string
  /** 选中行对勾的无障碍名称。 */
  selectedLabel?: string
}
const row =
  'flex h-auto w-full items-start justify-start gap-2.5 whitespace-normal rounded-xl px-3 py-2.5 text-start font-normal transition-colors focus-visible:ring-1'
const bareRow =
  'flex h-auto w-full items-center justify-start gap-3 whitespace-normal rounded-lg px-3 py-2 text-start font-normal shadow-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0'
function OptionText({ option }: { option: OptionListOption }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="break-words text-sm leading-5">{option.label}</span>
      {option.description && (
        <span className="break-words text-xs leading-4 text-muted-foreground">
          {option.description}
        </span>
      )}
    </span>
  )
}
export function OptionList({
  options,
  onConfirm,
  choice,
  pending,
  bare = false,
  rowClassName,
  selectedLabel,
  className,
  ...props
}: OptionListProps) {
  return (
    <div
      role="group"
      data-slot="option-list"
      data-state={choice !== undefined ? 'receipt' : pending ? 'pending' : 'open'}
      aria-busy={pending || undefined}
      className={cn(
        bare
          ? 'flex w-full flex-col'
          : cn(paper, 'flex w-full max-w-md flex-col gap-1 rounded-2xl p-2'),
        className,
      )}
      {...props}
    >
      {options.map((option) => {
        const selected = choice?.includes(option.id) ?? false
        const check = selected ? (
          <Icon
            name="check"
            size="sm"
            label={bare ? selectedLabel : undefined}
            className={bare ? undefined : 'mt-0.5 text-primary'}
          />
        ) : null
        const body = bare ? (
          <>
            <OptionText option={option} />
            {check}
          </>
        ) : (
          <>
            {check}
            <OptionText option={option} />
          </>
        )
        const itemClass = cn(
          bare ? bareRow : row,
          !bare &&
            (selected
              ? 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20'
              : 'text-muted-foreground'),
          rowClassName,
        )
        return choice !== undefined || !onConfirm ? (
          <div
            key={option.id}
            data-marker={option.marker}
            data-selected={selected || undefined}
            className={itemClass}
          >
            {body}
          </div>
        ) : (
          <Button
            key={option.id}
            type="button"
            variant="ghost"
            data-marker={option.marker}
            disabled={option.disabled || pending}
            onClick={() => onConfirm([option.id])}
            className={itemClass}
          >
            {body}
          </Button>
        )
      })}
    </div>
  )
}
