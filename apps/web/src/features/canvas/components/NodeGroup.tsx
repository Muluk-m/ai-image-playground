import type { CanvasGroup } from '@image-playground/shared'
import { createContext, memo, useContext, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
export const RenameGroupContext = createContext<(id: string, name: string) => void>(() => {})
export default memo(function NodeGroup({
  data: { group },
  selected,
}: {
  data: { group?: CanvasGroup }
  selected?: boolean
}) {
  const { t } = useTranslation('canvas')
  const rename = useContext(RenameGroupContext)
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState('')
  if (!group) return null
  return (
    <div className="studio-node-group" data-selected={selected || undefined}>
      <div className="studio-node-group-title text-label-md">
        <Icon name="folder" size="sm" />
        {editing ? (
          <Input
            className="nodrag nopan h-7 max-w-64 text-sm"
            autoFocus
            value={draft}
            maxLength={500}
            aria-label={t('nodes.groupName')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              rename(group.id, draft.trim() || t('nodes.groupDefault'))
              setEditing(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                setDraft(group.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="max-w-64 justify-start truncate px-1"
            onKeyDown={(event) => {
              if (['Enter', ' ', 'F2'].includes(event.key)) {
                event.preventDefault()
                event.stopPropagation()
                setDraft(group.name)
                setEditing(true)
              }
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              setDraft(group.name)
              setEditing(true)
            }}
          >
            {group.name}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">{group.members.length}</span>
      </div>
    </div>
  )
})
