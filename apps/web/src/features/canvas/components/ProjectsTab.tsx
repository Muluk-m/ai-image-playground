import { useEffect } from 'react'
import { useTranslation } from '../../../i18n'
import { useCanvasProjectStore } from '../projectStore'
import ProjectGrid from './ProjectGrid'

/**
 * 「资产 → 项目」：所有画布项目一张网格。画布与视频不各占一个标签——它们是这里的项目类型，
 * 新建时选一次，之后不可改。
 */
export default function ProjectsTab({ search }: { search: string }) {
  const { t } = useTranslation('library')
  const projectError = useCanvasProjectStore((state) => state.error)

  useEffect(() => {
    void useCanvasProjectStore
      .getState()
      .load()
      .catch(() => {})
  }, [])

  return (
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
  )
}
