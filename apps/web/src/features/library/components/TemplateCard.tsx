import type { KeyboardEvent } from 'react'
import {
  getTemplateAssetRefs,
  getTemplateParamEntries,
  getTemplatePreviewText,
} from '../lib/templates'
import { useLibraryStore } from '../store'
import type { TemplateRecord } from '../types'
import AssetThumb from './AssetThumb'

const STRIP_LIMIT = 4

export default function TemplateCard({ template }: { template: TemplateRecord }) {
  const assets = useLibraryStore((s) => s.assets)
  const applyTemplate = useLibraryStore((s) => s.applyTemplate)
  const openTemplateDetail = useLibraryStore((s) => s.openTemplateDetail)

  const refs = getTemplateAssetRefs(template, assets)
  const shown = refs.slice(0, STRIP_LIMIT)
  const overflow = refs.length - shown.length

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openTemplateDetail(template.id)
    }
  }

  return (
    <div className="group relative flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-card/40 p-3.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary hover:shadow-lg">
      {/* 外层不是 <button>：卡片底部还有「套用」按钮，嵌套 button 是 invalid HTML。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => openTemplateDetail(template.id)}
        onKeyDown={handleKeyDown}
        title="查看详情"
        className="flex cursor-pointer flex-col gap-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-ring/60"
      >
        <span className="truncate text-sm font-medium text-foreground">{template.name}</span>

        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {getTemplatePreviewText(template, assets)}
        </p>

        {refs.length > 0 && (
          <div className="flex items-center gap-1.5">
            <ul className="flex items-center gap-1.5">
              {shown.map((ref, index) => (
                <li
                  key={`${ref.assetId}:${index}`}
                  className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-border bg-muted"
                >
                  {ref.asset ? (
                    <AssetThumb imageId={ref.asset.imageId} alt={ref.asset.name} />
                  ) : (
                    <span
                      title="素材已删除"
                      aria-label="素材已删除"
                      className="block h-full w-full bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(120,120,120,0.18)_4px,rgba(120,120,120,0.18)_8px)]"
                    />
                  )}
                </li>
              ))}
            </ul>
            {overflow > 0 && (
              <span className="text-[11px] font-medium text-muted-foreground">+{overflow}</span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {getTemplateParamEntries(template.params)
            .map((entry) => `${entry.label} ${entry.value}`)
            .join(' · ')}
        </span>
        <button
          type="button"
          onClick={() => void applyTemplate(template.id)}
          className="shrink-0 rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/20"
        >
          套用
        </button>
      </div>
    </div>
  )
}
