import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import ProjectGrid from './ProjectGrid'

/** 首屏切到「画布」档时，输入框下面从作品流换成画布项目：接下来要去的是画布，先把最近的摆出来。 */
export default function HeroCanvasProjects() {
  const { t } = useTranslation(['canvas', 'shell'])
  const setAppMode = useStore((s) => s.setAppMode)
  return (
    <>
      <div className="flex items-center gap-4 pb-5 pt-10">
        <h2 className="text-[15px] font-semibold">{t('shell:nav.canvases')}</h2>
        <button
          type="button"
          onClick={() => setAppMode('projects')}
          className="ml-auto text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('shell:nav.allCanvases')} →
        </button>
      </div>
      <ProjectGrid recent />
    </>
  )
}
