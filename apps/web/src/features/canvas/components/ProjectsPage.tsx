import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import { useCanvasProjectStore } from '../projectStore'
import ProjectGrid from './ProjectGrid'

/**
 * 「项目」入口：所有画布项目一张网格。画布与视频不各占一个导航位——它们是这里的项目类型，
 * 新建时选一次，之后不可改。
 */
export default function ProjectsPage() {
  const { t } = useTranslation('library')
  const [search, setSearch] = useState('')
  const projectError = useCanvasProjectStore((state) => state.error)

  useEffect(() => {
    void useCanvasProjectStore
      .getState()
      .load()
      .catch(() => {})
  }, [])

  return (
    <main className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <div className="studio-page-head flex shrink-0 flex-wrap items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.projects}</h1>
        <label className="ml-auto flex h-9 w-full max-w-xs items-center rounded-lg border border-border px-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('panel.searchProjects')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 px-5 pb-10 pt-5">
        {projectError ? (
          <div role="alert" className="py-10 text-sm text-muted-foreground">
            {projectError}
            <button
              type="button"
              className="ml-3 text-primary underline"
              onClick={() =>
                void useCanvasProjectStore
                  .getState()
                  .load()
                  .catch(() => {})
              }
            >
              {t('panel.reloadProjects')}
            </button>
          </div>
        ) : (
          <ProjectGrid search={search} />
        )}
      </div>
    </main>
  )
}
