import { type KeyboardEvent, useState } from 'react'
import { EditIcon, TrashIcon } from '../../../components/icons'
import { useStore } from '../../../store'
import { getTemplatePreviewText } from '../lib/templates'
import { useLibraryStore } from '../store'
import type { TemplateRecord } from '../types'

export default function TemplateCard({ template }: { template: TemplateRecord }) {
  const assets = useLibraryStore((s) => s.assets)
  const applyTemplate = useLibraryStore((s) => s.applyTemplate)
  const renameTemplate = useLibraryStore((s) => s.renameTemplate)
  const deleteTemplate = useLibraryStore((s) => s.deleteTemplate)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [draftName, setDraftName] = useState<string | null>(null)

  const commitRename = () => {
    if (draftName !== null) void renameTemplate(template.id, draftName)
    setDraftName(null)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void applyTemplate(template.id)
    }
  }

  const referencedCount = template.assetIds.filter(Boolean).length

  return (
    <div className="group relative flex flex-col gap-2 rounded-2xl border border-gray-200/60 bg-gray-50/40 p-3.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-blue-500/40">
      <div className="flex items-center gap-1">
        {draftName === null ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
            {template.name}
          </span>
        ) : (
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setDraftName(null)
            }}
            maxLength={40}
            className="min-w-0 flex-1 rounded-md border border-blue-300 bg-white px-1.5 py-0.5 text-sm text-gray-800 focus:outline-none dark:border-blue-500/50 dark:bg-white/[0.06] dark:text-gray-100"
          />
        )}

        <button
          type="button"
          onClick={() => setDraftName(template.name)}
          aria-label="重命名"
          className="shrink-0 rounded-md p-1 text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
        >
          <EditIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() =>
            setConfirmDialog({
              title: '删除模板',
              message: `确定删除模板「${template.name}」吗？`,
              action: () => void deleteTemplate(template.id),
            })
          }
          aria-label="删除"
          className="shrink-0 rounded-md p-1 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-500/10"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 外层不是 <button>：卡片内还有重命名与删除按钮，嵌套 button 是 invalid HTML。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => void applyTemplate(template.id)}
        onKeyDown={handleKeyDown}
        title="套用模板"
        className="cursor-pointer rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/60"
      >
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {getTemplatePreviewText(template, assets)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-400 dark:text-gray-500">
        <span>{template.params.size}</span>
        <span>·</span>
        <span>{template.params.quality}</span>
        <span>·</span>
        <span>{template.params.n} 张</span>
        {referencedCount > 0 && (
          <>
            <span>·</span>
            <span>{referencedCount} 张素材</span>
          </>
        )}
      </div>
    </div>
  )
}
