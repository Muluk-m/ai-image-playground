import type { ComponentProps, ReactNode, Ref } from 'react'
import { useTranslation } from '../../i18n'
import { Hint } from '../assistant-ui/elements/tooltip-icon-button'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
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
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'className' | 'size' | 'variant'> & {
  'aria-label': string
  streaming?: boolean
  busy?: boolean
}) {
  return (
    <Button
      type="button"
      size="icon-lg"
      variant={props.disabled ? 'secondary' : 'default'}
      className="creation-send"
      data-slot="composer-send"
      aria-busy={busy || undefined}
      {...props}
      aria-label={props['aria-label']}
    >
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
  const fullLabel = t(`studio.modes.${value}`)
  const fullName = useOverflowTitle<HTMLSpanElement>(fullLabel, { whenHidden: true })
  const icons = { agent: 'chat', image: 'imageAdd', video: 'video' } as const
  const shortLabels = {
    agent: t('studio.shortModes.agent'),
    image: t('studio.shortModes.image'),
    video: t('studio.shortModes.video'),
  }
  return (
    <Select value={value} onValueChange={(mode) => onChange(mode as CreationMode)}>
      <Hint tooltip={fullName.title}>
        <SelectTrigger aria-label={t('studio.type')} className="creation-mode-trigger">
          <SelectValue>
            <span className="creation-mode-value">
              <Icon name={icons[value]} />
              <span ref={fullName.ref} className="creation-mode-full">
                {fullLabel}
              </span>
              <span className="creation-mode-short">{shortLabels[value]}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
      </Hint>
      <SelectContent side="top" align="start" sideOffset={10} className="creation-mode-menu">
        {modes.map((mode) => (
          <SelectItem key={mode} value={mode} className="creation-mode-option">
            <span className="flex items-center gap-3">
              <Icon name={icons[mode]} />
              {t(`studio.modes.${mode}`)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
