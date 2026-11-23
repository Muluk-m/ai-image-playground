import { useEffect, useRef, useState } from 'react'
import { CanvasLimitError } from '../toolbox/lib/canvasLimits'
import { downloadImages } from '../toolbox/lib/deliver'
import { deliverResizedToComposer } from './deliverToComposer'
import { type ExportSettings, type ExportSource, exportSize, prepareExports } from './export'

export type ExportAxis = 'width' | 'height'

export type ExportError =
  | { key: 'export.originalFailed' }
  | { key: 'export.failed' }
  | { key: 'export.limit'; width: number; height: number }

export type ExportBusyAction = 'export' | 'composer' | null

export const EXPORT_FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'] as const
export const EXPORT_SCALES = [0.5, 1, 2, 3, 4] as const
export const SCALE_PRESETS = [25, 50, 75, 100, 200] as const

export function validSize(text: string): boolean {
  return text.trim() !== '' && Number.isInteger(Number(text)) && Number(text) > 0
}

export function useExportState({
  sources,
  name = 'images',
  onBusyChange,
}: {
  sources: readonly ExportSource[]
  name?: string
  onBusyChange?: (busy: boolean) => void
}) {
  const [settings, setSettings] = useState<ExportSettings>(() => ({
    mode: 'original',
    value: 100,
    quality: 92,
    rows: [{ id: crypto.randomUUID(), scale: 1, format: 'image/png' }],
  }))
  const [loadedDimensions, setLoadedDimensions] = useState<{
    width: number
    height: number
  } | null>(null)
  const [loadedPreview, setLoadedPreview] = useState<string | null>(null)
  const [loadingDimensions, setLoadingDimensions] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [busyAction, setBusyAction] = useState<ExportBusyAction>(null)
  const [error, setError] = useState<ExportError | null>(null)
  const [done, setDone] = useState(0)
  const [sizeDraft, setSizeDraft] = useState<Partial<Record<ExportAxis, string>>>({})
  const lastAxis = useRef<ExportAxis>('width')
  const abort = useRef<AbortController | null>(null)
  // 单张且未预知尺寸时读尺寸已经拿到原图，导出直接复用，不再下载第二遍。
  const firstBlob = useRef<Blob | null>(null)

  const single = sources.length === 1 && sources[0]?.media === 'image'
  const first = sources[0]
  const knownDimensions =
    single && first?.width && first?.height ? { width: first.width, height: first.height } : null
  const sourcesKey = sources.map((one) => one.id).join(',')

  const prevSourcesKey = useRef(sourcesKey)
  useEffect(() => {
    if (prevSourcesKey.current === sourcesKey) return
    prevSourcesKey.current = sourcesKey
    setSizeDraft({})
    setError(null)
    setDone(0)
  }, [sourcesKey])

  useEffect(() => {
    let alive = true
    let url: string | null = null
    const controller = new AbortController()
    firstBlob.current = null
    setLoadedDimensions(null)
    setLoadedPreview(null)
    setLoadingDimensions(false)
    setError((prev) => (prev?.key === 'export.originalFailed' ? null : prev))
    if (!single || !first || (first.width && first.height)) return
    setLoadingDimensions(true)
    void first
      .load(controller.signal)
      .then(async (blob) => {
        const bitmap = await createImageBitmap(blob)
        if (alive) {
          firstBlob.current = blob
          setLoadedDimensions({ width: bitmap.width, height: bitmap.height })
          url = URL.createObjectURL?.(blob) ?? null
          setLoadedPreview(url)
        }
        bitmap.close()
      })
      .catch(() => {
        if (alive) setError({ key: 'export.originalFailed' })
      })
      .finally(() => {
        if (alive) setLoadingDimensions(false)
      })
    return () => {
      alive = false
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [single, first])

  useEffect(() => () => abort.current?.abort(), [])

  const busy = progress !== null
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  const dimensions = knownDimensions ?? loadedDimensions
  const preview = loadedPreview ?? (single ? (first?.preview ?? null) : null)
  const loading = loadingDimensions

  const imageSources = sources.filter((source) => source.media === 'image')
  const images = imageSources.length
  const empty = sources.length === 0
  const count = images * settings.rows.length + sources.length - images
  const locked = settings.stretch === undefined

  const originals = imageSources.map((source) => {
    if (single) return dimensions
    if (source.width && source.height) return { width: source.width, height: source.height }
    return null
  })

  const outputSizes = (scale: number) =>
    originals.map((original) =>
      original
        ? exportSize(
            original.width,
            original.height,
            settings.mode,
            settings.value,
            scale,
            settings.stretch,
          )
        : null,
    )

  const sizes = outputSizes(1)
  const sharedAxis = (axis: ExportAxis, outputs = sizes) => {
    const value = outputs[0]?.[axis]
    return value !== undefined && outputs.every((output) => output?.[axis] === value) ? value : null
  }

  const fieldValue = (axis: ExportAxis) =>
    sizeDraft[axis] ??
    settings.stretch?.[axis] ??
    (settings.mode === axis ? settings.value : sharedAxis(axis)) ??
    ''

  const invalid = Object.values(sizeDraft).some((text) => !validSize(text))
  const hasStretchValues =
    settings.stretch !== undefined && Object.keys(settings.stretch).length > 0
  const isSizeModified =
    hasStretchValues ||
    Object.keys(sizeDraft).length > 0 ||
    (settings.mode !== 'original' && !(settings.mode === 'percent' && settings.value === 100))

  const activePercent =
    invalid || hasStretchValues || !locked
      ? null
      : settings.mode === 'original'
        ? 100
        : settings.mode === 'percent'
          ? settings.value
          : null

  const hasLossy = settings.rows.some((row) => row.format !== 'image/png')
  const hasJpeg = images > 0 && settings.rows.some((row) => row.format === 'image/jpeg')
  const hasVideo = sources.some((source) => source.media === 'video')
  const canExport = !empty && !invalid && !loading && !busy
  const canSendToComposer = images > 0 && !hasVideo && !invalid && !loading && !busy

  const changeSize = (axis: ExportAxis, text: string) => {
    setSizeDraft((prev) => (locked ? { [axis]: text } : { ...prev, [axis]: text }))
    setDone(0)
    if (!validSize(text)) return
    lastAxis.current = axis
    setSettings((prev) =>
      locked
        ? { ...prev, mode: axis, value: Number(text) }
        : { ...prev, stretch: { ...prev.stretch, [axis]: Number(text) } },
    )
  }

  const applyPercent = (percent: number) => {
    setSizeDraft({})
    setDone(0)
    setError(null)
    setSettings((prev) => ({
      ...prev,
      mode: percent === 100 ? 'original' : 'percent',
      value: percent,
      stretch: undefined,
    }))
  }

  const toggleLock = () => {
    if (invalid) return
    const axis = lastAxis.current
    const value = Number(fieldValue(axis))
    setSizeDraft({})
    setDone(0)
    setSettings((prev) =>
      locked
        ? { ...prev, stretch: {} }
        : { ...prev, stretch: undefined, ...(value > 0 ? { mode: axis, value } : {}) },
    )
  }

  const resetSize = () => {
    setSizeDraft({})
    setDone(0)
    setError(null)
    setSettings((prev) => ({
      ...prev,
      mode: 'original',
      value: 100,
      stretch: locked ? undefined : {},
    }))
  }

  const updateRow = (id: string, patch: Partial<ExportSettings['rows'][number]>) =>
    setSettings((prev) => ({
      ...prev,
      rows: prev.rows.map((one) => (one.id === id ? { ...one, ...patch } : one)),
    }))

  const addRow = () =>
    setSettings((prev) =>
      prev.rows.length >= 8
        ? prev
        : {
            ...prev,
            rows: [...prev.rows, { id: crypto.randomUUID(), scale: 2, format: 'image/png' }],
          },
    )

  const removeRow = (id: string) =>
    setSettings((prev) =>
      prev.rows.length <= 1
        ? prev
        : {
            ...prev,
            rows: prev.rows.filter((one) => one.id !== id),
          },
    )

  const setQuality = (quality: number) => setSettings((prev) => ({ ...prev, quality }))

  const execute = async (action: Exclude<ExportBusyAction, null>) => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    const cached = firstBlob.current
    const inputs = single && cached && first ? [{ ...first, load: async () => cached }] : sources
    const total = inputs.length
    setError(null)
    setDone(0)
    setBusyAction(action)
    setProgress({ done: 0, total })
    const reportProgress = (completed: number) => {
      if (!controller.signal.aborted && abort.current === controller) {
        setProgress({ done: completed, total })
      }
    }
    try {
      const files = await prepareExports(inputs, settings, controller.signal, reportProgress)
      controller.signal.throwIfAborted()
      if (action === 'export') {
        await downloadImages(files, `${name}.zip`, controller.signal)
        if (!controller.signal.aborted && abort.current === controller) setDone(files.length)
      } else {
        await deliverResizedToComposer(files, controller.signal)
      }
    } catch (err) {
      if (!controller.signal.aborted && abort.current === controller) {
        setError(
          err instanceof CanvasLimitError
            ? { key: 'export.limit', width: err.width, height: err.height }
            : { key: 'export.failed' },
        )
      }
    } finally {
      if (abort.current === controller) {
        abort.current = null
        setProgress(null)
        setBusyAction(null)
      }
    }
  }

  return {
    settings,
    dimensions,
    preview,
    loading,
    progress,
    busy,
    busyAction,
    error,
    done,
    sizeDraft,
    single,
    first,
    imageSources,
    images,
    empty,
    count,
    locked,
    originals,
    outputSizes,
    sharedAxis,
    fieldValue,
    invalid,
    isSizeModified,
    activePercent,
    hasLossy,
    hasJpeg,
    hasVideo,
    canExport,
    canSendToComposer,
    changeSize,
    applyPercent,
    toggleLock,
    resetSize,
    updateRow,
    addRow,
    removeRow,
    setQuality,
    runExport: () => execute('export'),
    runSendToComposer: () => execute('composer'),
  }
}

export type ExportState = ReturnType<typeof useExportState>
