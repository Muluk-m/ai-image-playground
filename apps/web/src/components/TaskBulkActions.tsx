import { useCallback, useMemo } from 'react'
import { taskExportSources } from '../features/image-export/sources'
import { openImageExport } from '../features/image-export/store'
import { useHistoryTasks } from '../hooks/useHistoryTasks'
import { useTranslation } from '../i18n'
import { taskMatchesStatusFilter } from '../lib/taskStatusFilter'
import { removeMultipleTasks, setTaskFavorite, useStore } from '../store'
import { Hint } from './assistant-ui/elements/tooltip-icon-button'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

/**
 * 选中任务后的批量操作条。生成记录能在生图与作品两个入口里框选，所以它不能挂在输入框上，
 * 那样只有带输入框的那一页才有批量。
 */
export default function TaskBulkActions() {
  const { t } = useTranslation('composer')
  const tasks = useHistoryTasks()
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
      if (!taskMatchesStatusFilter(task, filterStatus)) return false
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
        for (const task of selected) void setTaskFavorite(task, isFavorite)
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

  const handleExportSelected = useCallback(() => {
    const selected = tasks.filter((task) => selectedTaskIds.includes(task.id))
    const sources = taskExportSources(selected)
    if (sources.length === 0) {
      showToast(t('bulk.noImages'), 'info')
      return
    }
    openImageExport(sources)
    clearSelection()
  }, [tasks, selectedTaskIds, showToast, clearSelection, t])

  if (selectedTaskIds.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-36 z-30 flex justify-center px-4"
      style={{ paddingLeft: 'var(--app-sidebar-width)' }}
    >
      <div className="pointer-events-auto flex items-center rounded-full border border-border/50 bg-card/90 p-1 shadow-popover backdrop-blur">
        <Hint tooltip={t('bulk.clearSelection')}>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={clearSelection}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('bulk.clearSelection')}
          >
            <Icon name="close" />
          </Button>
        </Hint>
        <div className="mx-1 h-5 w-px bg-muted" />
        <Button
          autoTooltip={false}
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={handleSelectAllToggle}
          className="text-primary transition-colors hover:text-primary"
          aria-label={allSelected ? t('bulk.deselectAll') : t('bulk.selectAllVisible')}
        >
          <Icon name={allSelected ? 'check' : 'selectRectangle'} filled={allSelected} />
        </Button>

        <div className="mx-1 h-5 w-px bg-muted" />
        <Hint tooltip={t('bulk.toggleFavorite')}>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={handleToggleFavorite}
            className="text-primary transition-colors"
            aria-label={t('bulk.toggleFavorite')}
          >
            <Icon name="favorite" />
          </Button>
        </Hint>
        <div className="mx-1 h-5 w-px bg-muted" />
        <Hint tooltip={t('bulk.export')}>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={handleExportSelected}
            className="text-foreground transition-colors"
            aria-label={t('bulk.export')}
          >
            <Icon name="download" />
          </Button>
        </Hint>
        <div className="mx-1 h-5 w-px bg-muted" />
        <Hint tooltip={t('bulk.delete')}>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={handleDeleteSelected}
            className="text-destructive transition-colors"
            aria-label={t('bulk.delete')}
          >
            <Icon name="delete" />
          </Button>
        </Hint>
      </div>
    </div>
  )
}
