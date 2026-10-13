import { useState } from 'react'
import { Hint } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { CreationReferenceStack } from '../../../components/creation/CreationReferenceStack'
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
    <CreationReferenceStack
      count={references.length}
      disabled={disabled}
      previews={references.slice(-3).map((ref) =>
        ref.fileId && files[ref.fileId] ? (
          <NodeMediaImage key={ref.id} src={files[ref.fileId]} alt="" />
        ) : (
          <span key={ref.id} className="flex h-full items-center justify-center">
            <Icon name={ref.kind === 'text' ? 'text' : ref.kind === 'video' ? 'video' : 'image'} />
          </span>
        ),
      )}
      add={
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="creation-add"
              aria-label={t('nodes.addReference')}
              disabled={disabled}
            >
              <Icon name="add" />
              <span>{t('nodes.addReference')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="creation-popover studio-node-reference-picker w-56"
            side="top"
            align="start"
          >
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
      }
    >
      {references.map((ref, index) => (
        <div
          className="relative flex w-[72px] shrink-0 flex-col gap-2"
          key={ref.id}
          title={ref.label}
        >
          <div className="creation-reference creation-reference-frame">
            <Hint tooltip={ref.label || t('nodes.references')}>
              <div
                className="flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-secondary"
                role="img"
                aria-label={ref.label || t('nodes.references')}
              >
                {ref.fileId && files[ref.fileId] ? (
                  <NodeMediaImage src={files[ref.fileId]} alt={ref.label} />
                ) : (
                  <Icon
                    name={ref.kind === 'text' ? 'text' : ref.kind === 'video' ? 'video' : 'image'}
                  />
                )}
              </div>
            </Hint>
            <span>
              {ref.kind === 'image' && imageIds.includes(ref.fileId ?? '')
                ? imageIds.indexOf(ref.fileId ?? '') + 1
                : null}
            </span>
            <Hint tooltip={t('nodes.removeReference')}>
              <Button
                className="creation-reference-remove"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={t('nodes.removeReference')}
                onClick={() => onRemove(ref.id)}
              >
                <Icon name="close" />
              </Button>
            </Hint>
            {index > 0 && onMove && (
              <Button
                size="icon-xs"
                className="absolute bottom-1 right-1 bg-card/90"
                variant="ghost"
                aria-label={t('nodes.moveReference')}
                title={t('nodes.moveReference')}
                disabled={disabled}
                onClick={() => onMove(ref.id)}
              >
                <Icon name="chevronLeft" size="xs" />
              </Button>
            )}
          </div>
          {roles && onRole && ref.kind === 'image' && !ref.asset && (
            <Select
              disabled={disabled}
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
        </div>
      ))}
      {references.some((ref) => ref.asset && !ref.fileId) && (
        <p className="w-full text-xs text-muted-foreground" role="note">
          {t('nodes.assetNoImage')}
        </p>
      )}
    </CreationReferenceStack>
  )
}
