import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { OverflowText } from '../../components/ui/overflowTitle'
import { useTranslation } from '../../i18n'
import { CHECKERBOARD } from '../toolbox/components/ToolResultCard'
import ToolShell, { AddTile } from '../toolbox/components/ToolShell'
import { resizeTool } from '../toolbox/lib/registry'
import { toolSource, useToolboxStore } from '../toolbox/store'
import ExportForm from './ExportForm'

/** 尺寸调整：共用工作台，参数栏是导出表单本身（自带导出按钮，所以不显示工作台底栏）。 */
export default function ExportTool() {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const remove = useToolboxStore((state) => state.remove)
  const [busy, setBusy] = useState(false)
  const sources = useMemo(
    () =>
      items
        .filter((item) => item.decodable)
        .map((item) => ({
          id: item.id,
          name: item.name,
          media: 'image' as const,
          preview: item.url,
          width: item.width,
          height: item.height,
          load: async () => {
            const source = toolSource(item)
            if (!source) throw new Error('Original unavailable')
            return source.file
          },
        })),
    [items],
  )
  return (
    <ToolShell
      tool={resizeTool}
      busy={busy}
      footer={false}
      panelClassName="lg:w-80"
      panelBody={<ExportForm sources={sources} onBusyChange={setBusy} />}
    >
      {({ openFiles }) => (
        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="group overflow-hidden rounded-2xl border border-border bg-card"
            >
              <div className={`relative aspect-[4/3] ${CHECKERBOARD}`}>
                <img src={item.url} alt={item.name} className="h-full w-full object-contain" />
                <Button
                  variant="outline"
                  size="icon-xs"
                  type="button"
                  disabled={busy}
                  onClick={() => remove(item.id)}
                  aria-label={t('result.remove')}
                  className="absolute right-2 top-2 opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Icon name="close" />
                </Button>
              </div>
              <div className="space-y-0.5 px-3 py-2.5 text-xs">
                <OverflowText as="div" text={item.name} className="truncate" />
                <div className="whitespace-nowrap font-mono text-label-sm text-muted-foreground">
                  {item.decodable ? `${item.width} × ${item.height} px` : t('export.undecodable')}
                </div>
              </div>
            </div>
          ))}
          {!busy && <AddTile onClick={openFiles} />}
        </div>
      )}
    </ToolShell>
  )
}
