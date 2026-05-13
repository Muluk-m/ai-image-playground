import { useMemo } from 'react'
import { useInspirationStore } from '../store'
import { applyInspiration } from '../lib/applyInspiration'
import { useStore } from '../../../store'
import { CopyIcon, SparkleIcon } from '../../../components/icons'

export default function InspirationDetail() {
  const detailItemId = useInspirationStore((s) => s.detailItemId)
  const closeDetail = useInspirationStore((s) => s.closeDetail)
  const items = useInspirationStore((s) => s.items)
  const showToast = useStore((s) => s.showToast)

  const item = useMemo(
    () => items.find((i) => i.id === detailItemId) ?? null,
    [items, detailItemId],
  )

  const promptDisplay = useMemo(() => formatPrompt(item?.prompt ?? ''), [item?.prompt])

  if (!item) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      showToast('提示词已复制', 'success')
    } catch {
      showToast('复制失败，请手动选择文本', 'error')
    }
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-3xl bg-white dark:bg-gray-900 animate-modal-in">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0 border-b border-gray-100 p-5 dark:border-white/[0.08]">
        <button
          type="button"
          onClick={closeDetail}
          className="flex items-center gap-1.5 text-sm text-gray-500 transition hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          返回列表
        </button>
        <div className="text-xs text-gray-400 dark:text-gray-500">
          {item.recommendedProvider}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          {/* 左：大图 — 点击在新标签页打开原图 */}
          <a
            href={item.imageUrl ?? item.thumbnailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative block overflow-hidden rounded-2xl bg-gray-100 dark:bg-white/[0.04]"
            title="点击在新标签查看原图"
          >
            <img
              src={item.imageUrl ?? item.thumbnailUrl}
              alt={item.title}
              className="w-full h-auto object-contain transition-transform duration-200 group-hover:scale-[1.01]"
              loading="lazy"
            />
            <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/50 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
              查看原图 ↗
            </span>
          </a>

          {/* 右：信息 */}
          <div className="flex flex-col gap-4">
            <div>
              <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100">{item.title}</h4>
              {item.description && (
                <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">{item.description}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-blue-50 px-2 py-1 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
                {item.category}
              </span>
              <span className="rounded-md bg-gray-100 px-2 py-1 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
                {item.recommendedModel}
              </span>
              <span className="rounded-md bg-gray-100 px-2 py-1 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
                {item.params.size}
              </span>
              {item.params.quality && (
                <span className="rounded-md bg-gray-100 px-2 py-1 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
                  quality: {item.params.quality}
                </span>
              )}
              {item.params.n && item.params.n > 1 && (
                <span className="rounded-md bg-gray-100 px-2 py-1 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
                  n: {item.params.n}
                </span>
              )}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-gray-600 dark:text-gray-300">
                <span>完整提示词</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                  aria-label="复制提示词"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  复制
                </button>
              </div>
              <pre
                data-selectable-text
                className="max-h-[40vh] overflow-auto rounded-xl border border-gray-200/60 bg-gray-50/80 p-3 text-xs leading-relaxed text-gray-800 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-gray-100"
              ><code>{promptDisplay}</code></pre>
            </div>

            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                {item.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 dark:bg-white/[0.06]">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 shrink-0 border-t border-gray-100 p-4 dark:border-white/[0.08]">
        <button
          type="button"
          onClick={closeDetail}
          className="rounded-xl px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
        >
          关闭
        </button>
        <button
          type="button"
          onClick={() => applyInspiration(item)}
          className="flex items-center gap-1.5 rounded-xl bg-blue-500 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600"
        >
          <SparkleIcon className="h-4 w-4" />
          使用此提示词
        </button>
      </div>
    </div>
  )
}

function formatPrompt(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      // fallthrough: 不是合法 JSON，按原样
    }
  }
  return raw
}
