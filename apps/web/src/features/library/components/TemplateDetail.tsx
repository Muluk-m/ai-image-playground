import { useState } from 'react'
import { CloseIcon, EditIcon, SparkleIcon, TrashIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { useStore } from '../../../store'
import {
  getTemplateAssetRefs,
  getTemplateParamEntries,
  getTemplatePromptParts,
} from '../lib/templates'
import { useLibraryStore } from '../store'
import AssetThumb from './AssetThumb'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

export default function TemplateDetail() {
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
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/50 bg-white shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10">
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 p-5 dark:border-white/[0.08]">
          {draftName === null ? (
            <h3 className="min-w-0 flex-1 truncate text-lg font-bold text-gray-800 dark:text-gray-100">
              {template.name}
            </h3>
          ) : (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setDraftName(null)
              }}
              maxLength={40}
              className="min-w-0 flex-1 rounded-lg border border-blue-300 bg-white px-2 py-1 text-lg font-bold text-gray-800 focus:outline-none dark:border-blue-500/50 dark:bg-white/[0.06] dark:text-gray-100"
            />
          )}
          <button
            type="button"
            onClick={() => setDraftName(template.name)}
            aria-label="重命名"
            title="重命名"
            className="shrink-0 rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          >
            <EditIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={closeTemplateDetail}
            aria-label="关闭"
            className="shrink-0 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section>
            <h4 className="mb-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
              完整提示词
            </h4>
            <div
              data-selectable-text
              className="whitespace-pre-wrap break-words rounded-xl border border-gray-200/60 bg-gray-50/80 p-3 text-sm leading-relaxed text-gray-800 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-gray-100"
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
              <h4 className="mb-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
                引用素材
              </h4>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {refs.map((ref, index) => (
                  <li
                    key={`${ref.assetId}:${index}`}
                    className="flex items-center gap-2 rounded-xl border border-gray-200/60 p-2 dark:border-white/[0.06]"
                  >
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-gray-100 dark:bg-white/[0.04]">
                      {ref.asset && <AssetThumb imageId={ref.asset.imageId} alt={ref.asset.name} />}
                    </div>
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        ref.asset
                          ? 'text-gray-800 dark:text-gray-100'
                          : 'text-gray-400 dark:text-gray-500'
                      }`}
                    >
                      {ref.asset?.name ?? '素材已删除'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">参数</h4>
            <div className="flex flex-wrap gap-2 text-xs">
              {getTemplateParamEntries(template.params).map((entry) => (
                <span
                  key={entry.label}
                  className="rounded-md bg-gray-100 px-2 py-1 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300"
                >
                  {entry.label} {entry.value}
                </span>
              ))}
            </div>
          </section>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400 dark:text-gray-500">
            <span>创建于 {formatTime(template.createdAt)}</span>
            <span>最近使用 {formatTime(template.lastUsedAt)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-100 p-4 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={() =>
              setConfirmDialog({
                title: '删除模板',
                message: `确定删除模板「${template.name}」吗？`,
                action: () => void deleteTemplate(template.id),
              })
            }
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-gray-500 transition hover:bg-red-50 hover:text-red-500 dark:text-gray-400 dark:hover:bg-red-500/10"
          >
            <TrashIcon className="h-4 w-4" />
            删除
          </button>
          <button
            type="button"
            onClick={() => void applyTemplate(template.id)}
            className="flex items-center gap-1.5 rounded-xl bg-blue-500 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600"
          >
            <SparkleIcon className="h-4 w-4" />
            套用
          </button>
        </div>
      </div>
    </Overlay>
  )
}
