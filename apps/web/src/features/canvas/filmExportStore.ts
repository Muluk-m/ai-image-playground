import { create } from 'zustand'
import { i18next } from '../../i18n'
import { downloadBlob } from '../../lib/downloadImages'
import { useStore } from '../../store'
import {
  exportFilm,
  FilmExportError,
  type FilmExportPhase,
  zipTimelineClips,
} from './lib/exportFilm'
import type { FilmClip } from './lib/filmSpec'

export interface FilmExportRun {
  timelineId: string
  kind: 'film' | 'zip'
  phase: FilmExportPhase
  /** 0–1。 */
  fraction: number
}

function stamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function failureText(err: unknown): string {
  if (!(err instanceof FilmExportError)) return i18next.t('film.failed', { ns: 'canvas' })
  switch (err.reason) {
    case 'fetch':
      return i18next.t('film.fetchFailed', { ns: 'canvas', position: err.position })
    case 'unreadable':
      return i18next.t('film.unreadable', { ns: 'canvas', position: err.position })
    case 'tooLong':
      return i18next.t('film.tooLongActual', { ns: 'canvas' })
    default:
      return i18next.t('film.failed', { ns: 'canvas' })
  }
}

let controller: AbortController | null = null

/**
 * 成片导出一次只跑一条：整段成片放在内存里，并行两条会把内存翻倍。
 * 结果只下载到本机，不上传、不回落画布。
 */
export const useFilmExport = create<{
  run: FilmExportRun | null
  start(timelineId: string, clips: readonly FilmClip[], kind: FilmExportRun['kind']): void
  cancel(): void
}>((set, get) => ({
  run: null,
  start(timelineId, clips, kind) {
    if (get().run) return
    const current = new AbortController()
    controller = current
    set({ run: { timelineId, kind, phase: 'fetching', fraction: 0 } })
    const toast = useStore.getState().showToast
    const work =
      kind === 'film'
        ? exportFilm(clips, {
            signal: current.signal,
            onProgress: (phase, fraction) => {
              if (controller === current) set({ run: { timelineId, kind, phase, fraction } })
            },
          }).then((blob) =>
            downloadBlob(blob, `${i18next.t('film.fileName', { ns: 'canvas' })}-${stamp()}.mp4`),
          )
        : zipTimelineClips(clips, current.signal).then((blob) =>
            downloadBlob(
              blob,
              `${i18next.t('film.clipsFileName', { ns: 'canvas' })}-${stamp()}.zip`,
            ),
          )
    void work
      .then(() => {
        if (kind === 'film') toast(i18next.t('film.done', { ns: 'canvas' }), 'success')
      })
      .catch((err) => {
        if (current.signal.aborted) toast(i18next.t('film.cancelled', { ns: 'canvas' }), 'info')
        else
          toast(
            kind === 'film' ? failureText(err) : i18next.t('film.zipFailed', { ns: 'canvas' }),
            'error',
          )
      })
      .finally(() => {
        if (controller === current) controller = null
        set({ run: null })
      })
  },
  cancel() {
    controller?.abort()
  },
}))
