import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useCanvasComposer } from '../../canvas/composerStore'
import { projectCatalog } from '../../canvas/lib/projectCatalog'
import { useCanvasProjectStore } from '../../canvas/projectStore'

/**
 * 视频入口。这一版只负责把人带到一张视频画布上：新建一张，或回到上次那张。
 * 片段编排与成片仍在画布的时间线里，独立的视频工程是后续的事。
 */
export default function VideoHome() {
  const { t } = useTranslation('video')
  const [busy, setBusy] = useState(false)
  const setAppMode = useStore((state) => state.setAppMode)

  /** 「继续」要回到上一张视频画布：图片项目定死是图片轮，接不住这里的活。 */
  const resume = async () => {
    const projects = useCanvasProjectStore.getState()
    const current = projects.projects.find((one) => one.id === projects.activeId)
    if (current?.kind === 'video') return true
    const last = projectCatalog(projects.projects, projects.cloudCatalog).find(
      (one) => one.kind === 'video',
    )
    return last
      ? await useAgentStore.getState().selectProject(last.id)
      : await useAgentStore.getState().createProject('video')
  }

  const start = async (fresh: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      // 目录还没读完就点进来时（直接访问 /video），先等它；读不出来照常新建一张。
      await useCanvasProjectStore
        .getState()
        .load()
        .catch(() => {})
      const opened = fresh ? await useAgentStore.getState().createProject('video') : await resume()
      if (!opened) return
      useCanvasComposer.getState().requestVideo()
      setAppMode('canvas')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="font-display text-2xl font-medium tracking-tight">{t('entry.title')}</h1>
      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={() => void start(true)}>
          {t('entry.newCanvas')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void start(false)}>
          {t('entry.continue')}
        </Button>
      </div>
    </main>
  )
}
