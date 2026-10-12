import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useTranslation } from '../../../i18n'
import type { NodeReference } from '../lib/nodeCanvasFlow'

export default function NodeReferenceEditor({
  references,
  files,
  available,
  onAdd,
  onRemove,
  onMove,
  roles,
  onRole,
}: {
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  available: readonly NodeReference[]
  onAdd: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string) => void
  roles?: Record<string, string>
  onRole?: (id: string, role: string) => void
}) {
  const { t } = useTranslation('canvas')
  const [picking, setPicking] = useState(false)
  return (
    <div className="studio-node-references" aria-label={t('nodes.references')}>
      {references.map((ref, index) => (
        <div className="studio-node-reference" key={ref.id}>
          {ref.fileId && files[ref.fileId] ? (
            <img src={files[ref.fileId]} alt="" />
          ) : (
            <Icon name={ref.kind === 'text' ? 'text' : ref.kind === 'video' ? 'video' : 'image'} />
          )}
          <span className="truncate max-w-28 text-xs" title={ref.label}>
            {ref.label ||
              t(
                ref.kind === 'text'
                  ? 'nodes.addText'
                  : ref.kind === 'video'
                    ? 'nodes.addVideo'
                    : 'nodes.addImage',
              )}
          </span>
          {roles && onRole && ref.kind === 'image' && (
            <Select
              value={roles[ref.id] ?? 'reference'}
              onValueChange={(value) => onRole(ref.id, value)}
            >
              <SelectTrigger className="h-7 w-24 text-xs" aria-label={t('nodes.references')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reference">{t('nodes.referenceImage')}</SelectItem>
                <SelectItem value="first">{t('nodes.firstFrame')}</SelectItem>
                <SelectItem value="last">{t('nodes.lastFrame')}</SelectItem>
              </SelectContent>
            </Select>
          )}
          {index > 0 && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('nodes.moveReference')}
              onClick={() => onMove(ref.id)}
            >
              <Icon name="chevronLeft" size="xs" />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('nodes.removeReference')}
            onClick={() => onRemove(ref.id)}
          >
            <Icon name="close" size="xs" />
          </Button>
        </div>
      ))}
      {available.length > 0 && (
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="studio-node-reference-add"
              aria-label={t('nodes.addReference')}
            >
              <Icon name="add" />
              {t('nodes.addReference')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="studio-node-reference-picker p-2" side="top" align="start">
            <p className="px-2 py-1 text-xs text-muted-foreground">{t('nodes.addReference')}</p>
            <div className="max-h-60 overflow-y-auto">
              {available.map((ref) => (
                <Button
                  key={ref.id}
                  variant="ghost"
                  className="h-10 w-full justify-start gap-2 px-2"
                  onClick={() => {
                    onAdd(ref.id)
                    setPicking(false)
                  }}
                >
                  {ref.fileId && files[ref.fileId] ? (
                    <img
                      src={files[ref.fileId]}
                      alt=""
                      className="h-7 w-7 rounded-sm object-cover"
                    />
                  ) : (
                    <Icon
                      name={ref.kind === 'text' ? 'text' : ref.kind === 'video' ? 'video' : 'image'}
                    />
                  )}
                  <span className="truncate text-xs">
                    {ref.label ||
                      t(
                        ref.kind === 'text'
                          ? 'nodes.addText'
                          : ref.kind === 'video'
                            ? 'nodes.addVideo'
                            : 'nodes.addImage',
                      )}
                  </span>
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
