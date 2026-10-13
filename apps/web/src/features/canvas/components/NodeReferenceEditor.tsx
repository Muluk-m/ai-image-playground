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
import { type NodeReference, referenceFileIds } from '../lib/nodeCanvasFlow'
import NodeMediaImage from './NodeMediaImage'

export default function NodeReferenceEditor({
  references,
  files,
  onPick,
  onUpload,
  onAssets,
  disabled,
  onRemove,
  onMove,
  roles,
  onRole,
}: {
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  onPick: () => void
  onUpload: () => void
  onAssets: () => void
  disabled?: boolean
  onRemove: (id: string) => void
  onMove?: (id: string) => void
  roles?: Record<string, string>
  onRole?: (id: string, role: string) => void
}) {
  const { t } = useTranslation('canvas')
  const [picking, setPicking] = useState(false)
  const imageIds = referenceFileIds(references, files)
  return (
    <div className="studio-node-references" aria-label={t('nodes.references')}>
      {references.map((ref, index) => (
        <div
          className={`studio-node-reference${ref.fileId && files[ref.fileId] ? ' studio-node-reference--image' : ''}`}
          key={ref.id}
          title={ref.label}
        >
          <span className="studio-node-reference-index text-xs text-muted-foreground tabular-nums">
            {ref.kind === 'image' && imageIds.includes(ref.fileId ?? '')
              ? imageIds.indexOf(ref.fileId ?? '') + 1
              : null}
          </span>
          {ref.fileId && files[ref.fileId] ? (
            <NodeMediaImage src={files[ref.fileId]} alt="" />
          ) : (
            <Icon name={ref.kind === 'text' ? 'text' : ref.kind === 'video' ? 'video' : 'image'} />
          )}
          <span className="studio-node-reference-label truncate max-w-28 text-xs" title={ref.label}>
            {ref.label ||
              t(
                ref.kind === 'text'
                  ? 'nodes.addText'
                  : ref.kind === 'video'
                    ? 'nodes.addVideo'
                    : 'nodes.addImage',
              )}
          </span>
          {roles && onRole && ref.kind === 'image' && !ref.asset && (
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
          {index > 0 && onMove && (
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
      {references.some((ref) => ref.asset && !ref.fileId) && (
        <p className="w-full text-xs text-muted-foreground" role="note">
          {t('nodes.assetNoImage')}
        </p>
      )}
      <Popover open={picking} onOpenChange={setPicking}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="studio-node-reference-add"
            aria-label={t('nodes.addReference')}
            disabled={disabled}
          >
            <Icon name="add" />
            {t('nodes.addReference')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="studio-node-reference-picker w-56 p-2" side="top" align="start">
          {(
            [
              { icon: 'upload', label: t('nodes.addUpload'), action: onUpload },
              { icon: 'folder', label: t('nodes.assets'), action: onAssets },
              { icon: 'fit', label: t('nodes.pickFromCanvas'), action: onPick },
            ] as const
          ).map(({ icon, label, action }) => (
            <Button
              key={icon}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                setPicking(false)
                action()
              }}
            >
              <Icon name={icon} />
              {label}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
