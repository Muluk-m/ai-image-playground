import {
  SCRIPT_BRIEF_AUTO,
  SCRIPT_BRIEFS,
  type ScriptBrief,
  type ScriptCharacter,
} from '@image-playground/shared'
import { useState } from 'react'
import Dialog from '../../../components/patterns/Dialog'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { cn } from '../../../lib/utils'

const FIELDS = ['genre', 'audience', 'era', 'hook', 'style', 'structure', 'episodes'] as const

function copyBrief(brief: ScriptBrief): ScriptBrief {
  return { ...brief, characters: brief.characters.map((one) => ({ ...one })) }
}

/** 热门设定写进一个文本节点。设定正文来自目录，这里不调用模型。 */
export default function ScriptBriefDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void
  onConfirm: (brief: ScriptBrief) => void
}) {
  const { t } = useTranslation('canvas')
  const [brief, setBrief] = useState(() => copyBrief(SCRIPT_BRIEFS[0]!))
  const setField = (field: (typeof FIELDS)[number], value: string) =>
    setBrief((current) => ({ ...current, [field]: value }))
  const setCharacter = (index: number, patch: Partial<ScriptCharacter>) =>
    setBrief((current) => ({
      ...current,
      characters: current.characters.map((one, at) => (at === index ? { ...one, ...patch } : one)),
    }))
  const labels = {
    genre: t('scriptBrief.genre'),
    audience: t('scriptBrief.audience'),
    era: t('scriptBrief.era'),
    hook: t('scriptBrief.hook'),
    style: t('scriptBrief.style'),
    structure: t('scriptBrief.structure'),
    episodes: t('scriptBrief.episodes'),
  } as const
  const kinds = {
    person: t('scriptBrief.person'),
    location: t('scriptBrief.location'),
    prop: t('scriptBrief.prop'),
  } as const
  return (
    <Dialog
      title={t('scriptBrief.title')}
      onClose={onClose}
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('scriptBrief.cancel')}
          </Button>
          <Button disabled={!brief.title.trim()} onClick={() => onConfirm(brief)}>
            {t('scriptBrief.confirm')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted-foreground">{t('scriptBrief.hint')}</p>
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {SCRIPT_BRIEFS.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            aria-pressed={brief.id === item.id}
            className={cn(
              'h-auto w-28 shrink-0 flex-col items-stretch justify-start gap-0 overflow-hidden whitespace-normal rounded-xl p-0 text-left font-normal ring-1 hover:bg-transparent',
              brief.id === item.id ? 'ring-primary' : 'ring-hairline',
            )}
            onClick={() => setBrief(copyBrief(item))}
          >
            {item.coverUrl && (
              <img src={item.coverUrl} alt="" className="h-16 w-full object-cover" />
            )}
            <span className="block px-2 py-1.5 text-sm font-medium">{item.title}</span>
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
          {t('scriptBrief.name')}
          <Input
            value={brief.title}
            onChange={(event) => setBrief((current) => ({ ...current, title: event.target.value }))}
          />
        </label>
        {FIELDS.map((field) => (
          <label key={field} className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span className="flex items-center justify-between gap-2">
              {labels[field]}
              <Button
                type="button"
                variant="link"
                className="h-auto px-0 text-xs"
                onClick={() => setField(field, SCRIPT_BRIEF_AUTO)}
              >
                {t('scriptBrief.auto')}
              </Button>
            </span>
            <Input value={brief[field]} onChange={(event) => setField(field, event.target.value)} />
          </label>
        ))}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
          {t('scriptBrief.outline')}
          <Textarea
            value={brief.outline}
            rows={4}
            onChange={(event) =>
              setBrief((current) => ({ ...current, outline: event.target.value }))
            }
          />
        </label>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <p className="text-xs text-muted-foreground">{t('scriptBrief.characters')}</p>
          {brief.characters.map((one, index) => (
            <div key={`${brief.id}-${index}`} className="grid grid-cols-[4.5rem_1fr] gap-2">
              <Input
                aria-label={`${kinds[one.kind]} ${index + 1}`}
                value={one.name}
                onChange={(event) => setCharacter(index, { name: event.target.value })}
              />
              <Input
                aria-label={`${one.name || kinds[one.kind]} ${t('scriptBrief.description')}`}
                value={one.description}
                onChange={(event) => setCharacter(index, { description: event.target.value })}
              />
            </div>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
          {t('scriptBrief.episode1')}
          <Textarea
            value={brief.episode1}
            rows={4}
            onChange={(event) =>
              setBrief((current) => ({ ...current, episode1: event.target.value }))
            }
          />
        </label>
      </div>
    </Dialog>
  )
}
