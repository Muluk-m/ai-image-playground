import { useCallback, useMemo } from 'react'
import { useTranslation } from '../i18n'
import { downloadImagesByIds } from '../lib/downloadImages'
import { removeMultipleTasks, updateTaskInStore, useStore } from '../store'

/**
 * 选中任务后的批量操作条。生成记录能在生图与作品两个入口里框选，所以它不能挂在输入框上，
 * 那样只有带输入框的那一页才有批量。
 */
export default function TaskBulkActions() {
  const { t } = useTranslation('composer')
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    return sorted.filter((task) => {
      if (filterFavorite && !task.isFavorite) return false
      if (filterStatus !== 'all' && task.status !== filterStatus) return false
      if (!q) return true
      return task.prompt.toLowerCase().includes(q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite])

  const allSelected = selectedTaskIds.length === filteredTasks.length && filteredTasks.length > 0

  const handleSelectAllToggle = useCallback(() => {
    if (allSelected) clearSelection()
    else setSelectedTaskIds(filteredTasks.map((task) => task.id))
  }, [allSelected, filteredTasks, clearSelection, setSelectedTaskIds])

  const handleToggleFavorite = useCallback(() => {
    const selected = tasks.filter((task) => selectedTaskIds.includes(task.id))
    const allFavorite = selected.length > 0 && selected.every((task) => task.isFavorite)
    const isFavorite = !allFavorite
    setConfirmDialog({
      title: isFavorite ? t('bulk.favoriteTitle') : t('bulk.unfavoriteTitle'),
      message: isFavorite
        ? t('bulk.favoriteMessage', { count: selectedTaskIds.length })
        : t('bulk.unfavoriteMessage', { count: selectedTaskIds.length }),
      confirmText: isFavorite ? t('bulk.confirmFavorite') : t('bulk.confirmUnfavorite'),
      action: () => {
        selectedTaskIds.forEach((id) => updateTaskInStore(id, { isFavorite }))
        clearSelection()
      },
    })
  }, [tasks, selectedTaskIds, clearSelection, setConfirmDialog, t])

  const handleDeleteSelected = useCallback(() => {
    setConfirmDialog({
      title: t('bulk.deleteTitle'),
      message: t('bulk.deleteMessage', { count: selectedTaskIds.length }),
      action: () => {
        removeMultipleTasks(selectedTaskIds)
      },
    })
  }, [selectedTaskIds, setConfirmDialog, t])

  const handleDownloadSelected = useCallback(async () => {
    const selected = tasks.filter((task) => selectedTaskIds.includes(task.id))
    const imageIds = selected.flatMap((task) => task.outputImages || [])
    if (imageIds.length === 0) {
      showToast(t('bulk.noImages'), 'info')
      return
    }
    showToast(t('bulk.downloadStarted', { count: imageIds.length }), 'info')
    const { success, failed } = await downloadImagesByIds(imageIds)
    if (failed > 0) showToast(t('bulk.downloadPartial', { success, failed }), 'info')
    else showToast(t('bulk.downloadSucceeded', { count: success }), 'success')
    clearSelection()
  }, [tasks, selectedTaskIds, showToast, clearSelection, t])

  if (selectedTaskIds.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-36 z-30 flex justify-center px-4 md:pl-60">
      <div className="pointer-events-auto flex items-center rounded-full border border-border/50 bg-card/90 p-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] backdrop-blur dark:shadow-lg">
        <button
          type="button"
          onClick={clearSelection}
          className="p-2 text-muted-foreground transition-colors hover:text-foreground"
          title={t('bulk.clearSelection')}
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
        <div className="mx-1 h-5 w-px bg-muted" />
        <button
          type="button"
          onClick={handleSelectAllToggle}
          className="p-2 text-primary transition-colors hover:text-primary"
          title={allSelected ? t('bulk.deselectAll') : t('bulk.selectAllVisible')}
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
          >
            {allSelected ? (
              <>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <path d="M9 12l2 2 4-4" />
              </>
            ) : (
              <path
                strokeDasharray="4 4"
                d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"
              />
            )}
          </svg>
        </button>
        <div className="mx-1 h-5 w-px bg-muted" />
        <button
          type="button"
          onClick={handleToggleFavorite}
          className="p-2 text-warning transition-colors"
          title={t('bulk.toggleFavorite')}
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
        <div className="mx-1 h-5 w-px bg-muted" />
        <button
          type="button"
          onClick={() => void handleDownloadSelected()}
          className="p-2 text-success transition-colors"
          title={t('bulk.download')}
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </button>
        <div className="mx-1 h-5 w-px bg-muted" />
        <button
          type="button"
          onClick={handleDeleteSelected}
          className="p-2 text-destructive transition-colors"
          title={t('bulk.delete')}
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
