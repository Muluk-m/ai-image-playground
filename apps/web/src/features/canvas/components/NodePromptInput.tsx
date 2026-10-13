import { useEffect, useRef, useState } from 'react'
import SuggestionMenu, { useSuggestionMenu } from '../../../components/SuggestionMenu'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { assetOptions } from '../../library/lib/assetMentions'
import { useLibraryStore } from '../../library/store'
import type { AssetRecord } from '../../library/types'

/** Asset identity lives in an upstream node, not in a mutable display-name token. */
export default function NodePromptInput({
  value,
  onChange,
  onSubmit,
  onAsset,
  label,
  className,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onAsset?: (asset: AssetRecord, prompt: string) => Promise<boolean>
  label: string
  className?: string
}) {
  const { t } = useTranslation('library')
  const assets = useLibraryStore((s) => s.assets)
  const input = useRef<HTMLTextAreaElement>(null)
  const [cursor, setCursor] = useState(0)
  const [adding, setAdding] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    if (onAsset)
      void useLibraryStore
        .getState()
        .loadAssets()
        .catch(() => {})
    return () => {
      mounted.current = false
    }
  }, [!!onAsset])
  const match = /(?:^|\s)@([^@\s]*)$/.exec(value.slice(0, cursor))
  const trigger =
    onAsset && match ? { start: cursor - match[1]!.length - 1, query: match[1]! } : null
  const choose = async (asset: AssetRecord) => {
    if (!trigger || !onAsset || adding) return
    setAdding(true)
    try {
      const prefix = `${value.slice(0, trigger.start)}@${asset.name} `
      if ((await onAsset(asset, prefix + value.slice(cursor))) && mounted.current) {
        setCursor(prefix.length)
        requestAnimationFrame(() => {
          input.current?.focus()
          input.current?.setSelectionRange(prefix.length, prefix.length)
        })
      }
    } finally {
      if (mounted.current) setAdding(false)
    }
  }
  const groups = trigger
    ? [
        {
          key: 'assets',
          heading: t('mention.headingAssets'),
          options: assetOptions(assets, trigger.query, (asset) => asset),
        },
      ]
    : []
  const menu = useSuggestionMenu({
    groups,
    onSelect: (asset: AssetRecord) => {
      void choose(asset)
    },
    onClose: () => {},
  })
  return (
    <div className="relative min-w-0">
      {menu.visible && (
        <SuggestionMenu
          groups={groups}
          activeIndex={menu.activeIndex}
          onActiveIndexChange={menu.setActiveIndex}
          offsetLeft={0}
          onSelect={menu.select}
        />
      )}
      <Textarea
        ref={input}
        aria-label={label}
        placeholder={label}
        className={className}
        rows={3}
        value={value}
        disabled={adding}
        onChange={(event) => {
          setCursor(event.target.selectionStart)
          onChange(event.target.value)
          menu.open()
        }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || menu.handleKeyDown(event)) return
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
    </div>
  )
}
