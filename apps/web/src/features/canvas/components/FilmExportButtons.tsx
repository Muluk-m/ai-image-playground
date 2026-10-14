import { useEffect, useState } from 'react'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useFilmExport } from '../filmExportStore'
import type { CanvasEditor } from '../lib/editor'
import { filmExportSupported } from '../lib/exportFilm'
import { type FilmRefusal, planFilm } from '../lib/filmPlan'
import CanvasToolbarButton from './CanvasToolbarButton'

/** 这个浏览器能不能导出成片；探测完成前是 undefined。 */
function useFilmSupport(): boolean | undefined {
  const [supported, setSupported] = useState<boolean>()
  useEffect(() => {
    let live = true
    void filmExportSupported()
      .catch(() => false)
      .then((value) => {
        if (live) setSupported(value)
      })
    return () => {
      live = false
    }
  }, [])
  return supported
}

/** 时间线工具条上的「导出成片」；浏览器编不了 H.264 时换成「下载全部片段」。 */
export default function FilmExportButtons({
  editor,
  timelineId,
}: {
  editor: CanvasEditor
  timelineId: string
}) {
  const { t } = useTranslation('canvas')
  const supported = useFilmSupport()
  const run = useFilmExport((state) => state.run)
  const timeline = editor.getElement(timelineId)
  if (timeline?.type !== 'timeline') return null
  const plan = planFilm(timeline.clips, (id) => editor.getElement(id))
  const refusalText = (refusal: FilmRefusal) => {
    switch (refusal.kind) {
      case 'empty':
        return t('timeline.empty')
      case 'missing':
        return t('film.missing', { position: refusal.position })
      case 'tooMany':
        return t('film.tooMany', { max: refusal.max })
      case 'tooLong':
        return t('film.tooLong', { minutes: refusal.maxSeconds / 60 })
    }
  }
  const busy = run !== null
  const exporting = run?.timelineId === timelineId
  const percent = exporting ? Math.round(run.fraction * 100) : 0

  if (supported === false) {
    const zipPlan = planFilm(timeline.clips, (id) => editor.getElement(id), { limits: false })
    return (
      <>
        <CanvasToolbarButton
          icon={<Icon name="download" />}
          label={t('film.export')}
          reason={t('film.unsupported')}
          onClick={() => {}}
        />
        <CanvasToolbarButton
          icon={<Icon name="folder" />}
          label={exporting ? t('film.zipping') : t('film.downloadClips')}
          disabled={busy}
          reason={zipPlan.ok ? undefined : refusalText(zipPlan.refusal)}
          onClick={() => {
            if (zipPlan.ok) useFilmExport.getState().start(timelineId, zipPlan.clips, 'zip')
          }}
        />
      </>
    )
  }
  return (
    <CanvasToolbarButton
      icon={<Icon name="download" />}
      label={exporting ? t('film.progress', { percent }) : t('film.export')}
      disabled={busy || supported === undefined}
      reason={plan.ok ? undefined : refusalText(plan.refusal)}
      onClick={() => {
        if (plan.ok) useFilmExport.getState().start(timelineId, plan.clips, 'film')
      }}
    />
  )
}
