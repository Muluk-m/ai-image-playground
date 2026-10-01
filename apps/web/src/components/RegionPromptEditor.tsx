import { Scan, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import {
  getMentionedImageIndexes,
  getSelectedImageMentionLabel,
  getVisiblePrompt,
} from '../lib/promptImageMentions'
import PromptEditor, { usePromptEditor } from './PromptEditor'
import { Button } from './ui/button'

/** The editor's mention slots are stable region identities, never current array positions. */
export function useRegionPrompt({
  ids,
  value,
  onChange,
  onRemove,
  maxLength,
}: {
  ids: readonly number[]
  value: string
  onChange: (value: string) => void
  onRemove: (id: number) => void
  maxLength?: number
}) {
  const { t } = useTranslation('canvas')
  const numbers = useRef(new Map<number, number>())
  const inserted = useRef(new Set<number>())
  const scope = useRef(crypto.randomUUID())
  const caret = useRef<number | null>(null)
  const [composing, setComposing] = useState(false)
  const numberFor = useCallback((id: number) => {
    let number = numbers.current.get(id)
    if (number === undefined) {
      number = numbers.current.size + 1
      numbers.current.set(id, number)
    }
    return number
  }, [])
  const activeNumbers = ids.map(numberFor)
  const activeKey = activeNumbers.join(',')
  const active = useMemo(() => new Set(activeKey.split(',').map(Number)), [activeKey])
  const label = useCallback(
    (index: number) => `@${t('inpaint.regionName', { no: index + 1 }).replace(' ', '')}`,
    [t],
  )
  const labels = useCallback(
    (index: number) =>
      active.has(index + 1) ? label(index) : `${label(index)}${t('inpaint.regionRemoved')}`,
    [active, label, t],
  )
  const referenceIds = Array.from(
    numbers.current,
    ([id, number]) => [number - 1, `${scope.current}:${id}`] as const,
  )
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
  const editor = usePromptEditor({
    value,
    labels,
    referenceIds,
    onChange,
    renderMention: (index) => {
      const number = index + 1
      const id = [...numbers.current].find((entry) => entry[1] === number)?.[0]
      return (
        <span className="region-prompt-chip" data-invalid={!active.has(number) || undefined}>
          <Scan size={12} aria-hidden="true" />
          <span>{labels(index)}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-5 rounded p-0 [&_svg]:size-3"
            type="button"
            aria-label={t('inpaint.removeRegion', { no: number })}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange(value.split(getSelectedImageMentionLabel(index)).join(''))
              if (id !== undefined && active.has(number)) onRemove(id)
            }}
          >
            <X size={12} aria-hidden="true" />
          </Button>
        </span>
      )
    },
    onEdit: () => {
      if (document.activeElement === editor.ref.current) caret.current = editor.selection().end
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') editor.insertText('\n')
    },
  })
  useEffect(() => {
    if (composing) return
    const added = ids.filter((id) => !inserted.current.has(id))
    if (!added.length) return
    for (const id of added) inserted.current.add(id)
    const mentions = added.filter(
      (id) => !value.includes(getSelectedImageMentionLabel(numberFor(id) - 1)),
    )
    if (!mentions.length) return
    const text =
      mentions.map((id) => getSelectedImageMentionLabel(numberFor(id) - 1)).join(' ') + ' '
    const offset = Math.min(caret.current ?? editor.visible.length, editor.visible.length)
    editor.replaceRange(offset, offset, text)
    caret.current = offset + getVisiblePrompt(text, labels).length
  }, [activeKey, composing, ids, value, editor, labels, numberFor])
  return {
    editor,
    numberFor,
    serialize: () => getVisiblePrompt(value, label),
    tooLong: maxLength !== undefined && getVisiblePrompt(value, label).length > maxLength,
    maxLength,
    hasMissing: getMentionedImageIndexes(value).some((index) => !active.has(index + 1)),
    onBlur: () => {
      caret.current = editor.selection().end
    },
    onCompositionStartCapture: () => setComposing(true),
    onCompositionEndCapture: () => setComposing(false),
  }
}

export default function RegionPromptEditor({
  prompt,
  label,
  placeholder,
  disabled = false,
}: {
  prompt: ReturnType<typeof useRegionPrompt>
  label: string
  placeholder: string
  disabled?: boolean
}) {
  const { t } = useTranslation('canvas')
  return (
    <section className="region-prompt-field" inert={disabled}>
      <PromptEditor
        editor={prompt.editor}
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-invalid={prompt.hasMissing || prompt.tooLong || undefined}
        placeholder={placeholder}
        disabled={disabled}
        className="region-prompt"
        onBlur={prompt.onBlur}
        onCompositionStartCapture={prompt.onCompositionStartCapture}
        onCompositionEndCapture={prompt.onCompositionEndCapture}
      />
      {prompt.tooLong && (
        <p role="status" className="region-prompt-error">
          {t('inpaint.promptTooLong', { max: prompt.maxLength })}
        </p>
      )}
      {prompt.hasMissing && (
        <p role="status" className="region-prompt-error">
          {t('inpaint.regionMissing')}
        </p>
      )}
    </section>
  )
}
