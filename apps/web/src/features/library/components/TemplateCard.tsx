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
    <div className="group relative flex flex-col gap-2.5 rounded-2xl border border-gray-200/60 bg-gray-50/40 p-3.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-blue-500/40">
      {/* 外层不是 <button>：卡片底部还有「套用」按钮，嵌套 button 是 invalid HTML。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => openTemplateDetail(template.id)}
        onKeyDown={handleKeyDown}
        title="查看详情"
        className="flex cursor-pointer flex-col gap-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/60"
      >
        <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
          {template.name}
        </span>

        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {getTemplatePreviewText(template, assets)}
        </p>

        {refs.length > 0 && (
          <div className="flex items-center gap-1.5">
            <ul className="flex items-center gap-1.5">
              {shown.map((ref, index) => (
                <li
                  key={`${ref.assetId}:${index}`}
                  className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04]"
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
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500">
                +{overflow}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-gray-400 dark:text-gray-500">
          {getTemplateParamEntries(template.params)
            .map((entry) => `${entry.label} ${entry.value}`)
            .join(' · ')}
        </span>
        <button
          type="button"
          onClick={() => void applyTemplate(template.id)}
          className="shrink-0 rounded-lg bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-500/20 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25"
        >
          套用
        </button>
      </div>
    </div>
  )
}
