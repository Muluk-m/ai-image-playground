import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showToast, downloadBlob, exportFilm, zipTimelineClips } = vi.hoisted(() => ({
  showToast: vi.fn(),
  downloadBlob: vi.fn(),
  exportFilm: vi.fn(),
  zipTimelineClips: vi.fn(),
}))
vi.mock('../../../store', () => ({ useStore: { getState: () => ({ showToast }) } }))
vi.mock('../../../lib/downloadImages', () => ({ downloadBlob }))
vi.mock('../../../features/canvas/lib/exportFilm', async () => {
  const { FilmExportError } = await import('../../../features/canvas/lib/filmPipeline')
  return { exportFilm, zipTimelineClips, FilmExportError }
})

import { useFilmExport } from '../../../features/canvas/filmExportStore'
import { FilmExportError } from '../../../features/canvas/lib/filmPipeline'

const clips = [{ taskId: 't1', outputIndex: 0, in: 0 }]

function settled() {
  return vi.waitFor(() => expect(useFilmExport.getState().run).toBeNull())
}

beforeEach(() => {
  vi.clearAllMocks()
  useFilmExport.setState({ run: null })
})

describe('useFilmExport', () => {
  it('reports progress and downloads the finished film', async () => {
    let finish!: (blob: Blob) => void
    exportFilm.mockImplementation((_clips, { onProgress }) => {
      onProgress('encoding', 0.5)
      return new Promise<Blob>((resolve) => {
        finish = resolve
      })
    })
    useFilmExport.getState().start('tl', clips, 'film')
    expect(useFilmExport.getState().run).toEqual({
      timelineId: 'tl',
      kind: 'film',
      phase: 'encoding',
      fraction: 0.5,
    })
    const blob = new Blob(['mp4'])
    finish(blob)
    await settled()
    expect(downloadBlob).toHaveBeenCalledWith(blob, expect.stringMatching(/\.mp4$/))
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'success')
  })

  it('runs one export at a time', () => {
    exportFilm.mockReturnValue(new Promise(() => {}))
    useFilmExport.getState().start('a', clips, 'film')
    useFilmExport.getState().start('b', clips, 'film')
    expect(exportFilm).toHaveBeenCalledTimes(1)
    expect(useFilmExport.getState().run?.timelineId).toBe('a')
  })

  it('cancels through the abort signal without downloading', async () => {
    exportFilm.mockImplementation(
      (_clips, { signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    )
    useFilmExport.getState().start('tl', clips, 'film')
    useFilmExport.getState().cancel()
    await settled()
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info')
  })

  it('names the clip that failed to download', async () => {
    exportFilm.mockRejectedValue(new FilmExportError('fetch', 3))
    useFilmExport.getState().start('tl', clips, 'film')
    await settled()
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('3'), 'error')
  })

  it('downloads a zip of clips as the fallback', async () => {
    const zip = new Blob(['zip'])
    zipTimelineClips.mockResolvedValue(zip)
    useFilmExport.getState().start('tl', clips, 'zip')
    await settled()
    expect(zipTimelineClips).toHaveBeenCalledWith(clips, expect.any(AbortSignal))
    expect(downloadBlob).toHaveBeenCalledWith(zip, expect.stringMatching(/\.zip$/))
  })
})
