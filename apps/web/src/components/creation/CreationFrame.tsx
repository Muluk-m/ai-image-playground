import type { ComponentProps, ReactNode, Ref } from 'react'
import { useTranslation } from '../../i18n'
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

export function CreationToolbar({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="creation-toolbar">
      <div className="creation-tools">{children}</div>
      {action}
    </div>
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
