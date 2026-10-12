import { type Dispatch, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { getSelectedImageMentionLabel } from '../../lib/promptImageMentions'
import {
  RatioGrid,
  SettingsPopover,
  SettingsSection,
  SettingsSegmented,
} from '../composer/SettingsPanel'
import MediaImage from '../MediaImage'
import { ModelLogo } from '../ModelIdentity'
import PromptEditor, { usePromptEditor } from '../PromptEditor'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type {
  CreationCatalog,
  CreationDraft,
  CreationLayout,
  CreationMode,
  DraftAction,
} from './draft'
import './creation.css'

export const creationModeIcons = { agent: 'chat', image: 'imageAdd', video: 'video' } as const
export function CreationComposer({
  draft,
  dispatch,
  catalog,
  layout = 'A',
  onAssets,
  onUpload,
  onSubmit,
  templates,
}: {
  draft: CreationDraft
  dispatch: Dispatch<DraftAction>
  catalog: CreationCatalog
  layout?: CreationLayout
  onAssets: (source: 'library' | 'canvas') => void
  onUpload: (files: FileList) => void
  onSubmit: () => void
  templates?: readonly { id: string; name: string; image: string; prompt: string }[]
}) {
  const { t } = useTranslation('composer')
  const modeLabels = {
    agent: t('studio.modes.agent'),
    image: t('studio.modes.image'),
    video: t('studio.modes.video'),
  }
  const placeholders = {
    agent: t('studio.placeholders.agent'),
    image: t('studio.placeholders.image'),
    video: t('studio.placeholders.video'),
  }
  const [expanded, setExpanded] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const selection = draft.selections[draft.mode]
  const models = catalog[draft.mode]
  const model = models.find((m) => m.id === selection.model) ?? models[0]
  const editor = usePromptEditor({
    value: draft.text,
    onChange: (text) => dispatch({ type: 'text', text }),
    labels: (i) => (draft.references[i] ? `@${draft.references[i].name}` : null),
    referenceIds: draft.references.map((r) => r.id),
    renderMention: (i, label) => (
      <span className="creation-mention">
        <MediaImage src={draft.references[i]?.src} alt="" />
        {label}
      </span>
    ),
  })
  const modePicker = (
    <Select
      value={draft.mode}
      onValueChange={(mode) => dispatch({ type: 'mode', mode: mode as CreationMode })}
    >
      <SelectTrigger aria-label={t('studio.type')} className="creation-mode-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="rounded-2xl p-1.5">
        {(['agent', 'image', 'video'] as const).map((mode) => {
          const ModeIcon = creationModeIcons[mode]
          return (
            <SelectItem key={mode} value={mode}>
              <span className="flex items-center gap-3">
                <Icon name={ModeIcon} />
                {modeLabels[mode]}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
  const modelPicker = (
    <Popover open={modelOpen} onOpenChange={setModelOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="creation-control" aria-label={t('studio.model')}>
          <ModelLogo model={model.id} />
          <span>{model.name}</span>
          <Icon name="chevronDown" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="creation-popover w-80" aria-label={t('studio.model')}>
        <p className="creation-menu-label">{t('studio.model')}</p>
        {models.map((option) => (
          <Button
            key={option.id}
            variant="ghost"
            className="creation-model-option"
            onClick={() => {
              dispatch({ type: 'model', model: option })
              setModelOpen(false)
            }}
          >
            <ModelLogo model={option.id} />
            <span className="flex-1 text-left">
              <span className="block">{option.name}</span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {option.description}
              </span>
            </span>
            {selection.model === option.id && <Icon name="check" />}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  )
  const parameters = (
    <div className="creation-parameter-fields">
      {model.parameters.map((param) => (
        <SettingsSection key={param.id} title={param.label}>
          {param.id === 'ratio' ? (
            <RatioGrid
              label={param.label}
              options={param.options.map((value) => ({ value, label: value }))}
              value={selection.values[param.id] ?? param.initial}
              onChange={(value) => dispatch({ type: 'parameter', id: param.id, value })}
            />
          ) : (
            <SettingsSegmented
              label={param.label}
              options={param.options.map((value) => ({ value, label: value }))}
              value={selection.values[param.id] ?? param.initial}
              onChange={(value) => dispatch({ type: 'parameter', id: param.id, value })}
            />
          )}
        </SettingsSection>
      ))}
    </div>
  )
  const references = (
    <div className="creation-references">
      <Popover open={addOpen} onOpenChange={setAddOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" className="creation-add" aria-label={t('studio.addReference')}>
            <Icon name="add" />
            <span>{t('studio.reference')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="creation-popover w-60">
          {[
            {
              icon: 'upload' as const,
              label: t('studio.upload'),
              action: () => fileInput.current?.click(),
            },
            {
              icon: 'folder' as const,
              label: t('studio.library'),
              action: () => onAssets('library'),
            },
            {
              icon: 'canvas' as const,
              label: t('studio.canvas'),
              action: () => onAssets('canvas'),
            },
          ].map(({ icon: ItemIcon, label, action }) => (
            <Button
              key={label}
              variant="ghost"
              className="creation-menu-item"
              onClick={() => {
                setAddOpen(false)
                action()
              }}
            >
              <Icon name={ItemIcon} />
              {label}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      {draft.references.map((reference, index) => (
        <div className="creation-reference" key={reference.id}>
          <Button
            variant="ghost"
            type="button"
            aria-label={`${t('studio.mention')} ${reference.name}`}
            onClick={() => editor.insertText(`${getSelectedImageMentionLabel(index)} `)}
          >
            <MediaImage src={reference.src} alt={reference.name} />
            <span>{index + 1}</span>
          </Button>
          <Button
            variant="secondary"
            className="creation-reference-remove"
            aria-label={`${t('studio.remove')} ${reference.name}`}
            onClick={() => {
              // Rebase mention indexes when a reference is removed; never point an old mention at another asset.
              const text = draft.text.replace(/\u2063@图(\d+)\u2064/g, (token, n: string) =>
                Number(n) === index + 1
                  ? reference.name
                  : Number(n) > index + 1
                    ? getSelectedImageMentionLabel(Number(n) - 2)
                    : token,
              )
              dispatch({ type: 'text', text })
              dispatch({
                type: 'references',
                references: draft.references.filter((r) => r.id !== reference.id),
              })
            }}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
    </div>
  )
  return (
    <section
      className={`creation-composer creation-layout-${layout} ${expanded ? 'creation-expanded' : ''}`}
      aria-label={t('studio.composer')}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files) onUpload(e.target.files)
          e.target.value = ''
        }}
      />
      {layout !== 'A' && (
        <div className="creation-top-tabs">
          {(['agent', 'image', 'video'] as const).map((mode) => {
            const TabIcon = creationModeIcons[mode]
            return (
              <Button
                key={mode}
                variant="ghost"
                aria-pressed={draft.mode === mode}
                onClick={() => dispatch({ type: 'mode', mode })}
              >
                <Icon name={TabIcon} />
                {modeLabels[mode]}
              </Button>
            )
          })}
        </div>
      )}
      <div className="creation-body">
        {references}
        <PromptEditor
          editor={editor}
          role="textbox"
          aria-label={t('studio.prompt')}
          aria-multiline="true"
          placeholder={placeholders[draft.mode]}
          className="creation-prompt"
        />
        <Button
          variant="ghost"
          size="icon"
          className="creation-expand"
          aria-label={expanded ? t('studio.collapse') : t('studio.expand')}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Icon name="fit" /> : <Icon name="fullscreen" />}
        </Button>
      </div>
      <div className="creation-toolbar">
        <div className="creation-tools">
          {layout === 'A' && modePicker}
          {modelPicker}
          {layout !== 'C' && (
            <div className="creation-parameter-summary">
              <SettingsPopover
                title={t('studio.parameters')}
                summary={model.parameters
                  .filter((p) => p.id !== 'quality')
                  .map((p) => selection.values[p.id] ?? p.initial)
                  .join(' · ')}
                icon={<Icon name="settingsAdjust" />}
                onReset={() => dispatch({ type: 'model', model })}
              >
                {() => parameters}
              </SettingsPopover>
            </div>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('studio.mention')}>
                <Icon name="attach" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="creation-popover w-64">
              {draft.references.length ? (
                draft.references.map((r, i) => (
                  <Button
                    variant="ghost"
                    key={r.id}
                    className="creation-menu-item"
                    onClick={() => editor.insertText(`${getSelectedImageMentionLabel(i)} `)}
                  >
                    <MediaImage src={r.src} alt="" className="size-7 rounded object-cover" />
                    {r.name}
                  </Button>
                ))
              ) : (
                <p className="p-2 text-sm text-muted-foreground">{t('studio.noReferences')}</p>
              )}
            </PopoverContent>
          </Popover>
        </div>
        <Button
          className="creation-send"
          size="icon"
          disabled={!draft.text.trim()}
          aria-label={t('studio.send')}
          onClick={onSubmit}
        >
          <Icon name="send" />
        </Button>
      </div>
      {layout === 'C' && (
        <aside className="creation-side-parameters">
          <span className="creation-menu-label">{t('studio.parameters')}</span>
          {parameters}
        </aside>
      )}
      {templates?.length ? (
        <div className="creation-templates">
          <Button
            variant="ghost"
            className="creation-template-chip"
            onClick={() => dispatch({ type: 'text', text: templates[0].prompt })}
          >
            <MediaImage src={templates[0].image} alt="" />
            {templates[0].name}
          </Button>
          <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="creation-more-templates">
                {t('studio.moreTemplates')}
                <Icon name="chevronRight" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="creation-popover w-80">
              {templates.map((template) => (
                <Button
                  key={template.id}
                  variant="ghost"
                  className="creation-menu-item"
                  onClick={() => {
                    dispatch({ type: 'text', text: template.prompt })
                    setTemplateOpen(false)
                  }}
                >
                  <MediaImage
                    src={template.image}
                    alt=""
                    className="size-9 rounded-lg object-cover"
                  />
                  {template.name}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
    </section>
  )
}
