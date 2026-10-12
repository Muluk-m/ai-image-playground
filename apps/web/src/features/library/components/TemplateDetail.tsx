import { useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import { formatDateTime } from '../../../i18n/format'
import { useStore } from '../../../store'
import {
  getTemplateAssetRefs,
  getTemplateParamEntries,
  getTemplatePromptParts,
} from '../lib/templates'
import { useLibraryStore } from '../store'
import { assetCoverImageId } from '../types'
import AssetThumb from './AssetThumb'

export default function TemplateDetail() {
  const { t } = useTranslation(['library', 'common'])
  const template = useLibraryStore(
    (s) => s.templates.find((t) => t.id === s.detailTemplateId) ?? null,
  )
  const assets = useLibraryStore((s) => s.assets)
  const closeTemplateDetail = useLibraryStore((s) => s.closeTemplateDetail)
  const applyTemplate = useLibraryStore((s) => s.applyTemplate)
  const renameTemplate = useLibraryStore((s) => s.renameTemplate)
  const deleteTemplate = useLibraryStore((s) => s.deleteTemplate)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [draftName, setDraftName] = useState<string | null>(null)

  if (!template) return null

  const commitRename = () => {
    if (draftName !== null) void renameTemplate(template.id, draftName)
    setDraftName(null)
  }

  const refs = getTemplateAssetRefs(template, assets)

  return (
    <Overlay onClose={closeTemplateDetail} tier="raised">
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border bg-card shadow-2xl ring-1 ring-hairline animate-modal-in border-border">
        <div className="flex shrink-0 items-center gap-2 border-b border-border p-5">
          {draftName === null ? (
            <h3 className="min-w-0 flex-1 truncate text-lg font-bold text-foreground">
              {template.name}
            </h3>
          ) : (
            <Input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setDraftName(null)
              }}
              maxLength={40}
              className="min-w-0 flex-1 rounded-lg border-primary bg-card px-2"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setDraftName(template.name)}
            aria-label={t('action.rename')}
            title={t('action.rename')}
            className="shrink-0 text-muted-foreground hover:bg-muted hover:text-muted-foreground"
          >
            <Icon name="edit" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={closeTemplateDetail}
            aria-label={t('common:action.close')}
            className="shrink-0 text-muted-foreground hover:bg-muted hover:text-muted-foreground"
          >
            <Icon name="close" />
          </Button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section>
            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t('templateDetail.fullPrompt')}
            </h4>
            <div
              data-selectable-text
              className="whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-card/80 p-3 text-sm leading-relaxed text-foreground"
            >
              {getTemplatePromptParts(template, assets).map((part, index) =>
                part.type === 'text' ? (
                  <span key={index}>{part.text}</span>
                ) : (
                  <span
                    key={index}
                    className={part.type === 'slot' ? 'mention-tag slot-tag' : 'mention-tag'}
                  >
                    {part.text}
                  </span>
                ),
              )}
            </div>
          </section>

          {refs.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                {t('templateDetail.referencedAssets')}
              </h4>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {refs.map((ref, index) => (
                  <li
                    key={`${ref.assetId}:${index}`}
                    className="flex items-center gap-2 rounded-xl border border-border/60 p-2"
                  >
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-muted">
                      {ref.asset && (
                        <AssetThumb imageId={assetCoverImageId(ref.asset)} alt={ref.asset.name} />
                      )}
                    </div>
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        ref.asset ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {ref.asset?.name ?? t('asset.deleted')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t('templateDetail.params')}
            </h4>
            <div className="flex flex-wrap gap-2 text-xs">
              {getTemplateParamEntries(template.params).map((entry) => (
                <span
                  key={entry.label}
                  className="rounded-md bg-muted px-2 py-1 text-muted-foreground"
                >
                  {entry.label} {entry.value}
                </span>
              ))}
            </div>
          </section>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-label-sm text-muted-foreground">
            <span>
              {t('templateDetail.createdAt', { time: formatDateTime(template.createdAt) })}
            </span>
            <span>
              {t('templateDetail.lastUsedAt', { time: formatDateTime(template.lastUsedAt) })}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border p-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setConfirmDialog({
                title: t('template.deleteTitle'),
                message: t('template.deleteMessage', { name: template.name }),
                action: () => void deleteTemplate(template.id),
              })
            }
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Icon name="delete" />
            {t('common:action.delete')}
          </Button>
          <Button type="button" onClick={() => void applyTemplate(template.id)}>
            <Icon name="generate" />
            {t('template.apply')}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}
