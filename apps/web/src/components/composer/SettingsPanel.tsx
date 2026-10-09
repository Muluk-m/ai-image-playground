import { X } from 'lucide-react'
import { type InputHTMLAttributes, type ReactNode, useId, useState } from 'react'
import { useTranslation } from '../../i18n'
import { parseRatio } from '../../lib/size'
import { dismissAllTooltips } from '../../lib/tooltipDismiss'
import { cn } from '../../lib/utils'
import { field, paper } from '../assistant-ui/elements/surfaces'
import { Switch } from '../Switch'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** 输入框底部一排控件的两档高度：首页 40px，侧栏宽度（380px）的输入框 32px。 */
export type ComposerControlSize = 'md' | 'sm'

/**
 * 输入框底部的 chip 外壳：模型、参数摘要、生成栏的图片 / 视频切换都用它，同一排高度和描边一致。
 * 也直接套在 Radix Select 的 trigger 上，所以顺手盖掉它自带的宽度与阴影。
 */
export function composerChipClass(size: ComposerControlSize = 'md') {
  return cn(
    'relative inline-flex w-auto min-w-0 items-center gap-1.5 border border-input bg-background font-medium text-foreground shadow-none transition-colors duration-150 hover:border-ring/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-transparent data-[state=open]:bg-accent',
    size === 'md'
      ? 'h-10 shrink-0 rounded-xl px-3 text-xs'
      : 'h-8 shrink rounded-lg px-2.5 text-label-sm',
  )
}

/** 模型 chip：首页给足宽度，窄输入框按内容收。 */
export function composerModelChipClass(size: ComposerControlSize = 'md') {
  return cn(
    composerChipClass(size),
    'shrink',
    size === 'md' ? 'min-w-[11.5rem] max-w-[14rem] pr-8' : 'max-w-[11rem] pr-7',
  )
}

/** 附件这类方形图标按钮，和 chip 同高。 */
export function composerIconButtonClass(size: ComposerControlSize = 'md') {
  return cn(
    'grid shrink-0 place-items-center border border-input bg-background text-muted-foreground transition-colors duration-150 hover:border-ring/40 hover:bg-accent hover:text-foreground',
    size === 'md' ? 'h-10 w-10 rounded-xl' : 'h-8 w-8 rounded-lg',
  )
}

/**
 * 生成设置卡片：摘要 chip 点开，标题 + 关闭、中间分组、底部「恢复默认 / 完成」。
 * 改动即时写入，「完成」只是收起。图片与视频参数都走这一个外壳。
 * 分组由 `children` 渲染函数给出，卡片关着时不构建。
 */
export function SettingsPopover({
  summary,
  icon,
  badge,
  title,
  dirty = false,
  size = 'md',
  onReset,
  children,
}: {
  summary: string
  icon?: ReactNode
  /** 摘要后的状态标记。 */
  badge?: ReactNode
  title: string
  /** 摘要里看不到的参数是否偏离默认值。 */
  dirty?: boolean
  size?: ComposerControlSize
  onReset?: () => void
  children: () => ReactNode
}) {
  const { t } = useTranslation('composer')
  const [open, setOpen] = useState(false)
  const titleId = useId()
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) dismissAllTooltips()
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`${title}: ${summary}`}
          aria-label={`${title}: ${summary}`}
          data-dirty={dirty || undefined}
          className={composerChipClass(size)}
        >
          {icon && <span className="flex shrink-0 text-muted-foreground">{icon}</span>}
          <span className="truncate tabular-nums">{summary}</span>
          {badge && <span className="flex shrink-0">{badge}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={titleId}
        className={cn(
          paper,
          'flex max-h-[min(36rem,calc(100dvh-6rem))] w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-0 rounded-[20px] p-0 shadow-popover',
        )}
      >
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 id={titleId} className="text-title font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            aria-label={t('settings.close')}
            onClick={() => setOpen(false)}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-2">{children()}</div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
          {onReset ? (
            <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onReset}>
              {t('settings.reset')}
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            {t('settings.done')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 卡片里的一组：标题在上（右侧可带当前值），控件居中，说明在下。 */
export function SettingsSection({
  title,
  value,
  hint,
  children,
}: {
  title: string
  value?: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <h3 className="text-muted-foreground">{title}</h3>
        {value != null && <span className="tabular-nums text-muted-foreground/80">{value}</span>}
      </div>
      {children}
      {hint && <p className="text-label-sm leading-relaxed text-muted-foreground">{hint}</p>}
    </section>
  )
}

interface SegmentOption<T extends string | number> {
  value: T
  label: ReactNode
  disabled?: boolean
}

const SEGMENT_TRACK = cn(field, 'rounded-full p-0.5')
const GRID_TRACK = cn(field, 'rounded-2xl p-0.5')
const SEGMENT_ITEM =
  'rounded-full text-xs text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-foreground/90 aria-pressed:shadow-sm'

/** 分段选择：互斥的几档并排，选中项浮起来。 */
export function SettingsSegmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<SegmentOption<T>>
  /** 不在选项里的值（比如自定义尺寸）时，一格都不亮。 */
  value: T | null
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex gap-0.5', SEGMENT_TRACK)}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 min-w-0 flex-1 truncate tabular-nums',
            // 档位多（数量 1–10）时收窄内边距，两位数也放得下。
            options.length > 6 ? 'px-0.5' : 'px-2',
            SEGMENT_ITEM,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 一组互斥档位的完整一节：标题 + 分段控件 + 说明。整组或个别档位可以置灰。 */
export function SettingsChoice<T extends string | number>({
  label,
  options,
  value,
  render,
  onChange,
  disabled,
  optionDisabled,
  note,
}: {
  label: string
  options: readonly T[]
  value: T
  render: (option: T) => string
  onChange: (option: T) => void
  disabled?: boolean
  /** 整组可用、但个别档位与另一组的选择配不上时置灰它。 */
  optionDisabled?: (option: T) => boolean
  note?: string
}) {
  const off = (option: T) => Boolean(disabled || optionDisabled?.(option))
  return (
    <SettingsSection title={label} hint={note}>
      <SettingsSegmented
        label={label}
        options={options.map((option) => ({
          value: option,
          label: render(option),
          disabled: off(option),
        }))}
        value={off(value) ? null : value}
        onChange={onChange}
      />
    </SettingsSection>
  )
}

/** 画幅形状：长边占满方框，短边按比例收。认不出的比例（`auto`）画虚线方框。 */
export function RatioShape({ ratio, className }: { ratio: string; className?: string }) {
  const parsed = parseRatio(ratio)
  const [w, h] = parsed ? [parsed.width, parsed.height] : [1, 1]
  return (
    <span aria-hidden="true" className={cn('flex h-4 w-4 items-center justify-center', className)}>
      <span
        className={cn('rounded-[3px] border-[1.5px] border-current', !parsed && 'border-dashed')}
        style={{
          width: w >= h ? '100%' : `${(w / h) * 100}%`,
          height: h >= w ? '100%' : `${(h / w) * 100}%`,
        }}
      />
    </span>
  )
}

/** 比例宫格：每格一个形状 + 文字，一行 5 格。`icon` 缺省时按 `value` 画形状。 */
export function RatioGrid({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<{ value: string; label: string; icon?: ReactNode }>
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div role="group" aria-label={label} className={cn('grid grid-cols-5 gap-0.5', GRID_TRACK)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex h-14 min-w-0 flex-col items-center justify-center gap-1.5 !rounded-xl !text-label-sm',
            SEGMENT_ITEM,
          )}
        >
          {option.icon ?? <RatioShape ratio={option.value} />}
          <span className="max-w-full truncate">{option.label}</span>
        </button>
      ))}
    </div>
  )
}

/** 开关行：名称 + 一句说明在左，开关在右。 */
export function SettingsToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div id={id} className="text-body-sm text-foreground">
          {label}
        </div>
        {description && (
          <p className="text-label-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch checked={checked} onChange={onChange} aria-labelledby={id} />
    </div>
  )
}

/**
 * 先编辑、后提交的输入框：打字只改本地草稿，失焦或回车才 `onCommit`。
 * 提交后显示的永远是外部值：被接受就是新值，被拒收或规整就回到实际生效的那个。
 */
export function DraftInput({
  value,
  onCommit,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onCommit: (draft: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setDraft(value)
  }
  // 调用方可能拒收或规整输入；值没变时也要回到实际生效的那个。
  const commit = () => {
    onCommit(draft)
    setDraft(value)
  }
  return (
    <Input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className={cn('rounded-lg bg-background text-body-sm tabular-nums', className)}
    />
  )
}
