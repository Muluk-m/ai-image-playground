import {
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from '../../i18n'
import { parseRatio } from '../../lib/size'
import { cn } from '../../lib/utils'
import { field, paper } from '../assistant-ui/elements/surfaces'
import { Switch } from '../patterns/Switch'
import { Button, buttonVariants } from '../ui/button'
import { Icon } from '../ui/icon'
import { Input } from '../ui/input'
import { useOverflowTitle } from '../ui/overflowTitle'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** 输入框底部一排控件的两档高度：首页 40px，侧栏宽度（380px）的输入框 32px。 */
export type ComposerControlSize = 'md' | 'sm'

/**
 * 输入框底部的 chip 外壳：模型、参数摘要、生成栏的图片 / 视频切换都用它，同一排高度和描边一致。
 * 也直接套在 Radix Select 的 trigger 上，所以顺手盖掉它自带的宽度与阴影。
 */
export function composerChipClass(size: ComposerControlSize = 'md') {
  return cn(
    buttonVariants({ variant: 'outline', size: size === 'md' ? 'chip-lg' : 'chip-sm' }),
    'relative w-auto min-w-0 shrink-0 justify-start gap-1.5 text-foreground shadow-none data-[state=open]:border-transparent data-[state=open]:bg-accent',
  )
}

/** 模型 chip：首页给足宽度，窄输入框按内容收。 */
export function composerModelChipClass(size: ComposerControlSize = 'md') {
  return cn(
    composerChipClass(size),
    'creation-model-trigger shrink',
    size === 'md' ? 'min-w-[11.5rem] max-w-[14rem] pr-8' : 'max-w-[11rem] pr-7',
  )
}

/**
 * 生成设置卡片：摘要 chip 点开，标题行放「恢复默认」与关闭，下面按组排列。
 * 改动即时写入，没有确认按钮；点外面或 Esc 收起。图片与视频参数都走这一个外壳。
 * 分组由 `children` 渲染函数给出，卡片关着时不构建。
 */
export function SettingsPopover({
  summary,
  summaryContent,
  detail,
  icon,
  badge,
  title,
  dirty = false,
  size = 'md',
  className,
  onReset,
  children,
}: {
  /** 读屏与悬停用的完整摘要。 */
  summary: string
  /** 胶囊上实际显示的内容；给了它，`summary` 只作读屏名称。空串表示只显示图标。 */
  summaryContent?: ReactNode
  /** 悬停与读屏多出来的一句，不进可见摘要。 */
  detail?: string
  /** 缺省是调参图标。 */
  icon?: ReactNode
  /** 摘要后的状态标记。 */
  badge?: ReactNode
  title: string
  /** 胶囊上看不到的参数偏离了默认值：右上角亮一个芽绿点（`data-settings-dot`，调用方可用 CSS 控制何时显示）。 */
  dirty?: boolean
  size?: ComposerControlSize
  className?: string
  /** 只在有参数偏离默认值时传；不传就不显示「恢复默认」。 */
  onReset?: () => void
  children: () => ReactNode
}) {
  const { t } = useTranslation('composer')
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const accessible = detail ? `${summary} · ${detail}` : summary
  const summaryText = useOverflowTitle<HTMLSpanElement>(summary)
  const visible = summaryContent ?? summary
  const segmented = summaryContent != null && typeof summaryContent !== 'string'
  // 胶囊省掉了默认值（分段摘要在窄输入框里还会只留图标）时，悬停给回完整摘要。
  const abridged = summaryContent !== undefined && visible !== summary
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={size === 'md' ? 'chip-lg' : 'chip-sm'}
          type="button"
          title={abridged ? accessible : detail ? `${title}: ${accessible}` : summaryText.title}
          aria-label={`${title}: ${accessible}`}
          data-dirty={dirty || undefined}
          className={cn(composerChipClass(size), className)}
        >
          <span className="flex shrink-0 text-muted-foreground">
            {icon ?? <Icon name="settingsAdjust" />}
          </span>
          {visible !== '' && (
            <span ref={summaryText.ref} className={segmented ? 'min-w-0' : 'truncate tabular-nums'}>
              {visible}
            </span>
          )}
          {badge && <span className="flex shrink-0">{badge}</span>}
          {dirty && (
            <span
              data-settings-dot
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={titleId}
        className={cn(
          paper,
          'flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-0 rounded-xl p-0 shadow-popover',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
          <h2 id={titleId} className="text-title font-semibold text-foreground">
            {title}
          </h2>
          <div className="flex items-center gap-1">
            {onReset && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onReset()
                  // 恢复后按钮随之消失，焦点交给关闭按钮，免得落回 body。
                  closeRef.current?.focus()
                }}
              >
                {t('settings.reset')}
              </Button>
            )}
            <Button
              ref={closeRef}
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={t('settings.close')}
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <Icon name="close" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-2">{children()}</div>
      </PopoverContent>
    </Popover>
  )
}

/** 卡片里的二级页：顶部一行返回，下面是这一项的完整选项。 */
export function SettingsSubpage({
  title,
  onBack,
  returnFocusRef,
  children,
}: {
  title: string
  onBack: () => void
  /** 回到主页后接住焦点的那一行；卡片整个关掉时它不在，焦点照常交还触发按钮。 */
  returnFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const { t } = useTranslation('composer')
  const backRef = useRef<HTMLButtonElement>(null)
  // 主页与二级页互相替换，点过的那一行会卸载；焦点在两边各自接住，不掉到 body。
  useEffect(() => {
    backRef.current?.focus()
    return () => returnFocusRef?.current?.focus()
  }, [returnFocusRef])
  return (
    <section className="space-y-3" aria-label={title}>
      <Button
        ref={backRef}
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 gap-1 font-medium"
        aria-label={t('settings.back', { title })}
        onClick={onBack}
      >
        <Icon name="chevronLeft" />
        {title}
      </Button>
      {children}
    </section>
  )
}

/** 进入二级页的一行：名称在左，当前值与箭头在右。 */
export function SettingsLinkRow({
  label,
  value,
  onClick,
  ref,
}: {
  label: string
  value: ReactNode
  onClick: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      className="-mx-2 h-9 w-[calc(100%+1rem)] justify-between px-2 font-normal"
      onClick={onClick}
    >
      <span className="text-body-sm text-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">{value}</span>
        <Icon name="chevronRight" />
      </span>
    </Button>
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
        {value != null && <span className="tabular-nums text-muted-foreground">{value}</span>}
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
  'text-xs font-normal text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-sm'

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
  const grid = options.length > 10
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        grid ? 'grid grid-cols-5 gap-1' : 'flex gap-0.5',
        grid ? GRID_TRACK : SEGMENT_TRACK,
      )}
    >
      {options.map((option) => (
        <Button
          variant="ghost"
          size="xs"
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-w-0 flex-1 truncate rounded-full tabular-nums',
            // 档位多（数量 1–10）时收窄内边距，两位数也放得下。
            options.length > 6 ? 'px-0.5' : 'px-2',
            SEGMENT_ITEM,
          )}
        >
          {option.label}
        </Button>
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

/** 画幅形状：长边贴满方框，短边按比例收。认不出的比例（`auto`）画虚线方框。 */
export function RatioShape({ ratio, className }: { ratio: string; className?: string }) {
  const parsed = parseRatio(ratio)
  const width = parsed?.width ?? 1
  const height = parsed?.height ?? 1
  const wide = width >= height
  return (
    <span aria-hidden="true" className={cn('relative block h-4 w-4 shrink-0', className)}>
      <span
        className={cn(
          'absolute left-1/2 top-1/2 box-border -translate-x-1/2 -translate-y-1/2 rounded-sm border-[1.5px] border-current',
          !parsed && 'border-dashed',
        )}
        style={{
          width: wide ? '100%' : `${(width / height) * 100}%`,
          height: wide ? `${(height / width) * 100}%` : '100%',
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
    <div
      role="group"
      aria-label={label}
      className={cn('grid gap-0.5', GRID_TRACK)}
      style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 5)}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <Button
          variant="ghost"
          size="xs"
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            SEGMENT_ITEM,
            // 单行按钮的 40px 装不下「形状 + 比例名」，格子按两行来。
            'h-auto min-h-14 w-full flex-col gap-1.5 rounded-xl px-0.5 py-1.5 text-label-sm',
          )}
        >
          {option.icon ?? <RatioShape ratio={option.value} />}
          <span className="max-w-full truncate">{option.label}</span>
        </Button>
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
