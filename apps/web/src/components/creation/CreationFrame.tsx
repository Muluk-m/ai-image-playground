import type { ComponentProps, ReactNode, Ref } from 'react'
import { useTranslation } from '../../i18n'
import { Hint } from '../assistant-ui/elements/tooltip-icon-button'
import { Button } from '../ui/button'
import { Icon, type IconName } from '../ui/icon'
import { useOverflowTitle } from '../ui/overflowTitle'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { CreationMode } from './draft'
import './creation.css'

export function CreationFrame({ className = '', ...props }: ComponentProps<'div'>) {
  return <div className={`creation-composer creation-layout-A ${className}`} {...props} />
}

export function CreationBody({
  references,
  referencesRef,
  children,
}: {
  referencesRef?: Ref<HTMLDivElement>
  references: ReactNode
  children: ReactNode
}) {
  return (
    <div className="creation-body">
      <div ref={referencesRef} className="creation-references">
        {references}
      </div>
      <div className="creation-editor">{children}</div>
    </div>
  )
}

/** Shared slots keep every composer on the same wide and narrow layout. */
export function CreationToolbar({
  mode,
  children,
  action,
  status,
}: {
  mode?: ReactNode
  children: ReactNode
  action: ReactNode
  status?: ReactNode
}) {
  return (
    <div className="creation-toolbar" data-has-mode={Boolean(mode)}>
      {mode && <div className="creation-toolbar-mode">{mode}</div>}
      <div className="creation-live-controls">{children}</div>
      <div className="creation-toolbar-action">{action}</div>
      {status && <div className="creation-toolbar-status">{status}</div>}
    </div>
  )
}

export function CreationSend({
  streaming = false,
  busy = false,
  cost,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'className' | 'size' | 'variant'> & {
  'aria-label': string
  streaming?: boolean
  busy?: boolean
  /** 发出去要扣的积分，写在按钮上；缺席即普通的图标按钮。 */
  cost?: string
}) {
  const showCost = Boolean(cost) && !streaming
  return (
    <Button
      type="button"
      size="icon-lg"
      variant={props.disabled ? 'secondary' : 'default'}
      className="creation-send"
      data-slot="composer-send"
      data-cost={showCost || undefined}
      aria-busy={busy || undefined}
      {...props}
      aria-label={props['aria-label']}
    >
      {showCost && (
        <span className="creation-send-cost">
          <Icon name="credits" />
          {cost}
        </span>
      )}
      {busy && !streaming ? (
        <Icon name="loading" className="animate-spin motion-reduce:animate-none" />
      ) : (
        <Icon name={streaming ? 'stop' : 'send'} filled={streaming} />
      )}
    </Button>
  )
}

export function CreationModePicker({
  value,
  onChange,
  modes = ['agent', 'image', 'video'],
}: {
  value: CreationMode
  onChange: (mode: CreationMode) => void
  modes?: readonly CreationMode[]
}) {
  const { t } = useTranslation('composer')
  const icons = { agent: 'chat', image: 'imageAdd', video: 'video' } as const
  const shortLabels = {
    agent: t('studio.shortModes.agent'),
    image: t('studio.shortModes.image'),
    video: t('studio.shortModes.video'),
  }
  return (
    <CreationOptionPicker
      value={value}
      onChange={onChange}
      label={t('studio.type')}
      options={modes.map((mode) => ({
        value: mode,
        label: t(`studio.modes.${mode}`),
        shortLabel: shortLabels[mode],
        icon: icons[mode],
      }))}
    />
  )
}

export function CreationOptionPicker<T extends string>({
  value,
  onChange,
  options,
  label,
  side = 'top',
}: {
  value: T
  onChange: (value: T) => void
  options: readonly { value: T; label: string; shortLabel: string; icon: IconName }[]
  label: string
  side?: 'top' | 'bottom'
}) {
  const selected = options.find((option) => option.value === value) ?? options[0]
  const fullName = useOverflowTitle<HTMLSpanElement>(selected?.label ?? '', { whenHidden: true })
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next)
        if (option) onChange(option.value)
      }}
    >
      <Hint tooltip={fullName.title}>
        <SelectTrigger aria-label={label} className="creation-mode-trigger">
          <SelectValue>
            <span className="creation-mode-value">
              {selected && <Icon name={selected.icon} />}
              <span ref={fullName.ref} className="creation-mode-full">
                {selected?.label}
              </span>
              <span className="creation-mode-short">{selected?.shortLabel}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
      </Hint>
      <SelectContent side={side} align="start" sideOffset={10} className="creation-mode-menu">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="creation-mode-option">
            <span className="flex items-center gap-3">
              <Icon name={option.icon} />
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
