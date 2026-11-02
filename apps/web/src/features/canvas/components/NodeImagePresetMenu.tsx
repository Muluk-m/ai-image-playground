import { IMAGE_PRESETS, type ImagePreset } from '@image-playground/shared'
import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useTranslation } from '../../../i18n'
import AgentSkillIcon from '../../agent/lib/agentSkillIcons'

export default function NodeImagePresetMenu({
  onSelect,
}: {
  onSelect: (preset: ImagePreset) => void
}) {
  const { t } = useTranslation('canvas')
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('imagePresets.open')}>
          <Icon name="layoutTemplate" />
          {t('imagePresets.open')}
          <Icon name="chevronDown" size="xs" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-1 p-2" side="bottom" collisionPadding={12}>
        {IMAGE_PRESETS.map((preset) => (
          <Button
            key={preset.skillName}
            variant="ghost"
            className="h-auto w-full justify-start py-2 text-left"
            onClick={() => {
              setOpen(false)
              onSelect(preset)
            }}
          >
            <AgentSkillIcon name={preset.icon} />
            <span className="min-w-0">
              <span className="block">{t(`imagePresets.${preset.skillName}.title`)}</span>
              <span className="block whitespace-normal text-xs font-normal text-muted-foreground">
                {t(`imagePresets.${preset.skillName}.description`)}
              </span>
            </span>
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
