import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useCanvasComposer } from '../../canvas/composerStore'

/**
 * 视频入口。这一版只负责把人带到一张预置成视频的画布上：新建一张，或回到上次那张。
 * 片段编排与成片仍在画布的时间线里，独立的视频工程是后续的事。
 */
export default function VideoHome() {
  const { t } = useTranslation('video')
  const [busy, setBusy] = useState(false)
  const setAppMode = useStore((state) => state.setAppMode)

  const start = async (fresh: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const opened = fresh ? await useAgentStore.getState().createProject() : true
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
