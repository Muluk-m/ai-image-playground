import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { type ModelChoice, ModelList } from '../../../components/composer/ModelSelector'
import {
  CreationBody,
  CreationSend,
  CreationToolbar,
} from '../../../components/creation/CreationFrame'
import { compactModelName, ModelLogo } from '../../../components/ModelIdentity'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { OverflowText } from '../../../components/ui/overflowTitle'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import type { NodeReference } from '../lib/nodeCanvasFlow'
import { fetchTextChatModels, type TextChatModel } from '../lib/textGenerationModels'
import NodeComposerFrame from './NodeComposerFrame'

export default function TextNodeComposer({
  references,
  files,
  tools,
  value,
  onChange,
  onSubmit,
  busy = false,
  error,
}: {
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  tools?: ReactNode
  value: string
  onChange: (value: string) => void
  onSubmit: (model: string) => void
  busy?: boolean
  error?: string | null
}) {
  const { t } = useTranslation('textGeneration')
  const [models, setModels] = useState<readonly TextChatModel[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetchTextChatModels(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setModels(next.models)
        setSelected(next.defaultModel ?? next.models[0]?.id ?? null)
        if (!next.models.length) setDirectoryError('text_model_unavailable')
      })
      .catch(() => {
        if (!controller.signal.aborted) setDirectoryError('text_model_unavailable')
      })
    return () => controller.abort()
  }, [])
  const choices = useMemo<ModelChoice[]>(
    () =>
      models.map((model) => ({
        value: model.id,
        model: model.model,
        profileId: 'chat',
        label:
          model.label === model.model ? compactModelName(model.model, model.label) : model.label,
      })),
    [models],
  )
  const current = choices.find((model) => model.value === selected)
  const canSend = value.trim().length > 0 && Boolean(current) && !busy
  const displayedError = error ?? directoryError
  return (
    <NodeComposerFrame
      standard
      label={t('composer.label')}
      references={tools ? [] : references}
      files={files}
    >
      <CreationBody references={tools}>
        <Textarea
          value={value}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.placeholder')}
          rows={3}
          disabled={busy}
          className="max-h-40 min-h-[4.5rem] w-full resize-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              if (canSend && selected) onSubmit(selected)
            }
          }}
        />
      </CreationBody>
      <CreationToolbar
        action={
          <CreationSend
            aria-label={t('composer.send')}
            busy={busy}
            disabled={!canSend}
            onClick={() => {
              if (canSend && selected) onSubmit(selected)
            }}
          />
        }
        status={
          displayedError ? (
            <p className="text-label-sm text-destructive" role="alert">
              {t(`errors.${displayedError}`, { defaultValue: t('errors.failed') })}
            </p>
          ) : undefined
        }
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="chip-sm"
              className="creation-control min-w-0"
              aria-label={t('composer.chooseModel')}
              disabled={!choices.length || busy}
            >
              {current ? <ModelLogo model={current.model} /> : <Icon name="model" />}
              <OverflowText
                text={current?.label ?? t('composer.chooseModel')}
                className="min-w-0 truncate"
              />
              <Icon name="chevronDown" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            collisionPadding={12}
            className="w-max max-w-[calc(100vw-1.5rem)]"
          >
            <ModelList
              options={choices}
              value={selected ?? ''}
              onPick={(id) => {
                setSelected(id)
                setOpen(false)
              }}
            />
          </PopoverContent>
        </Popover>
      </CreationToolbar>
    </NodeComposerFrame>
  )
}
