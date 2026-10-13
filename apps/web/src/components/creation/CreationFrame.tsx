import type { ComponentProps, ReactNode, Ref } from 'react'
import { useTranslation } from '../../i18n'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
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
  const icons = { agent: 'chat', image: 'imageAdd', video: 'video' } as const
  return (
    <Select value={value} onValueChange={(mode) => onChange(mode as CreationMode)}>
      <SelectTrigger aria-label={t('studio.type')} className="creation-mode-trigger">
        <SelectValue />
      </SelectTrigger>
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
