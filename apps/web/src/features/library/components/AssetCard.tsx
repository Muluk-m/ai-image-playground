import { type KeyboardEvent, useState } from 'react'
import { EditIcon, TrashIcon } from '../../../components/icons'
import { useStore } from '../../../store'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import AssetThumb from './AssetThumb'

export default function AssetCard({ asset }: { asset: AssetRecord }) {
  const attachAsset = useLibraryStore((s) => s.attachAsset)
  const renameAsset = useLibraryStore((s) => s.renameAsset)
  const deleteAsset = useLibraryStore((s) => s.deleteAsset)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [draftName, setDraftName] = useState<string | null>(null)

  const commitRename = () => {
    if (draftName !== null) void renameAsset(asset.id, draftName)
    setDraftName(null)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void attachAsset(asset.id)
    }
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-gray-50/40 transition-all duration-300 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-blue-500/40">
      {/* 外层不是 <button>：卡片内还有重命名与删除按钮，嵌套 button 是 invalid HTML。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => void attachAsset(asset.id)}
        onKeyDown={handleKeyDown}
        title={asset.name}
        className="relative aspect-square cursor-pointer overflow-hidden bg-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-400/60 dark:bg-white/[0.05]"
      >
        <AssetThumb imageId={asset.imageId} alt={asset.name} />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="rounded-lg bg-white/90 px-2.5 py-1 text-[11px] font-medium text-gray-800">
            加入参考图
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1 px-2.5 py-2">
        {draftName === null ? (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800 dark:text-gray-100">
            {asset.name}
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
            className="min-w-0 flex-1 rounded-md border border-blue-300 bg-white px-1.5 py-0.5 text-xs text-gray-800 focus:outline-none dark:border-blue-500/50 dark:bg-white/[0.06] dark:text-gray-100"
          />
        )}

        <button
          type="button"
          onClick={() => setDraftName(asset.name)}
          aria-label="重命名"
          className="shrink-0 rounded-md p-1 text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
        >
          <EditIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() =>
            setConfirmDialog({
              title: '删除素材',
              message: `确定删除素材「${asset.name}」吗？图片本身保留。`,
              action: () => void deleteAsset(asset.id),
            })
          }
          aria-label="删除"
          className="shrink-0 rounded-md p-1 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-500/10"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
