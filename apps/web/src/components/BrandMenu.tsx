import { useState } from 'react'
import { useAgentStore } from '../features/agent/store'
import { projectDisplayName } from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { BRAND_WORDMARK, brandNeedsWordmark, useTranslation } from '../i18n'
import { isWorkbenchMode, useStore } from '../store'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const MENU_ITEM =
  'flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50'

/**
 * 左上角的品牌菜单。工作台里侧栏不出现，回主页、换项目、新建与删除都从这里走。
 */
export default function BrandMenu() {
  const { t } = useTranslation('shell')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const appMode = useStore((state) => state.appMode)
  const setAppMode = useStore((state) => state.setAppMode)
  const setConfirmDialog = useStore((state) => state.setConfirmDialog)
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const inWorkbench = isWorkbenchMode(appMode)

  const go = (mode: Parameters<typeof setAppMode>[0]) => {
    setOpen(false)
    setAppMode(mode)
  }

  const newProject = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (await useAgentStore.getState().createProject()) go('canvas')
    } finally {
      setBusy(false)
    }
  }

  const removeProject = () => {
    if (!project) return
    setOpen(false)
    setConfirmDialog({
      title: t('brand.deleteProject'),
      message: t('brand.deleteProjectMessage', { name: projectDisplayName(project.name) }),
      action: () => {
        void useAgentStore.getState().deleteProject(project.id)
      },
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t('header.homeAria')}
        className="flex max-w-full items-center gap-2.5 rounded-lg font-display text-[18px] font-medium tracking-wide text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src="/brand/muvloom-icon.svg"
          alt=""
          width="28"
          height="28"
          className="h-7 w-7 shrink-0 rounded-lg"
        />
        <span className="truncate">
          {t('header.brandName')}
          {brandNeedsWordmark() ? (
            <span className="ml-2 hidden sm:inline">{BRAND_WORDMARK}</span>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1.5">
        <button type="button" className={MENU_ITEM} onClick={() => go('image')}>
          {t('brand.home')}
        </button>
        <button type="button" className={MENU_ITEM} onClick={() => go('projects')}>
          {t('brand.projects')}
        </button>
        <div className="my-1.5 h-px bg-border" />
        <button
          type="button"
          className={MENU_ITEM}
          disabled={busy}
          onClick={() => void newProject()}
        >
          {t('brand.newProject')}
        </button>
        {inWorkbench && project ? (
          <button type="button" className={MENU_ITEM} onClick={removeProject}>
            {t('brand.deleteProject')}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
