import { Plus, Scaling, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { TooltipIconButton } from '../../components/assistant-ui/elements/tooltip-icon-button'
import { Button } from '../../components/ui/button'
import { useTranslation } from '../../i18n'
import ToolboxHeader from '../toolbox/components/ToolboxHeader'
import { useToolboxIntake } from '../toolbox/components/useToolboxIntake'
import { toolSource, useToolboxStore } from '../toolbox/store'
import ExportForm from './ExportForm'

export default function ExportTool() {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const remove = useToolboxStore((state) => state.remove)
  const [busy, setBusy] = useState(false)
  const intake = useToolboxIntake(busy)
  const sources = useMemo(
    () =>
      items
        .filter((item) => item.decodable)
        .map((item) => ({
          id: item.id,
          name: item.name,
          media: 'image' as const,
          preview: item.url,
          load: async () => {
            const source = toolSource(item)
            if (!source) throw new Error('Original unavailable')
            return source.file
          },
        })),
    [items],
  )
  return (
    <main
      {...intake.dropZoneProps}
      className={`flex h-[calc(100dvh-var(--mobile-nav-height,0px))] min-h-0 flex-col ${intake.dragging ? 'bg-primary/5' : ''}`}
    >
      {intake.inputs}
      <ToolboxHeader
        title={
          <>
            <Scaling className="h-4 w-4 text-primary" aria-hidden="true" />
            {t('tool.export.name')}
          </>
        }
        back
        busy={busy}
        onAddImages={intake.openFiles}
        onAddFolder={intake.openFolder}
      />
      <div className="grid min-h-0 flex-1 overflow-y-auto lg:overflow-hidden lg:grid-cols-[1fr_400px]">
        <div className="overflow-y-auto p-6">
          {items.length ? (
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="overflow-hidden rounded-xl border border-border bg-card"
                >
                  <img
                    src={item.url}
                    alt={item.name}
                    className="aspect-square w-full object-contain bg-muted/20"
                  />
                  <div className="flex items-center gap-2 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.decodable
                          ? `${item.width} × ${item.height} px`
                          : t('export.undecodable')}
                      </p>
                    </div>
                    <TooltipIconButton
                      disabled={busy}
                      tooltip={t('intake.clear')}
                      onClick={() => remove(item.id)}
                    >
                      <Trash2 />
                    </TooltipIconButton>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid min-h-64 place-content-center gap-4 text-center">
              <p className="text-sm text-muted-foreground">{t('intake.hint')}</p>
              <Button onClick={intake.openFiles}>
                <Plus />
                {t('intake.chooseImages')}
              </Button>
            </div>
          )}
        </div>
        <aside className="flex min-h-0 flex-col border-l border-border bg-card">
          <ExportForm sources={sources} onBusyChange={setBusy} />
        </aside>
      </div>
    </main>
  )
}
