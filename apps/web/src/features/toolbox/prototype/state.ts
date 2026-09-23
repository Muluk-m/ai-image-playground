// PROTOTYPE — throwaway。三个变体共用一份已导入的图片与参数，切变体时不丢图，方便对照。
// 全在内存里，刷新即清空；正式实现不写 IndexedDB（见 docs/research/image-toolbox.md 第五节）。

import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  type ComposedOutput,
  type ComposeOptions,
  compose,
  DEFAULT_COMPOSE,
  DEFAULT_RECIPE,
  outputName,
  type ProcessedImage,
  processImage,
  type Recipe,
} from './ops'

export interface ProtoItem {
  id: string
  file: File
  name: string
  /** 原图的对象 URL，用来画缩略图与对比。 */
  url: string
  width: number
  height: number
  size: number
  type: string
  error: string | null
}

const bitmaps = new Map<string, ImageBitmap>()

interface ProtoState {
  items: ProtoItem[]
  selectedId: string | null
  recipe: Recipe
  composeOptions: ComposeOptions
  add: (files: File[]) => Promise<void>
  remove: (id: string) => void
  move: (id: string, delta: number) => void
  clear: () => void
  select: (id: string) => void
  setRecipe: (patch: Partial<Recipe>) => void
  resetRecipe: () => void
  setCompose: (patch: Partial<ComposeOptions>) => void
}

export const useProto = create<ProtoState>()((set, get) => ({
  items: [],
  selectedId: null,
  recipe: DEFAULT_RECIPE,
  composeOptions: DEFAULT_COMPOSE,
  add: async (files) => {
    const added: ProtoItem[] = []
    for (const file of files) {
      const id = crypto.randomUUID()
      const base = {
        id,
        file,
        name: file.name,
        url: URL.createObjectURL(file),
        size: file.size,
        type: file.type || 'application/octet-stream',
      }
      try {
        const bitmap = await createImageBitmap(file)
        bitmaps.set(id, bitmap)
        added.push({ ...base, width: bitmap.width, height: bitmap.height, error: null })
      } catch {
        added.push({ ...base, width: 0, height: 0, error: '这个浏览器解不开' })
      }
    }
    set((s) => ({
      items: [...s.items, ...added],
      selectedId: s.selectedId ?? added[0]?.id ?? null,
    }))
  },
  remove: (id) => {
    const item = get().items.find((one) => one.id === id)
    if (item) URL.revokeObjectURL(item.url)
    bitmaps.get(id)?.close()
    bitmaps.delete(id)
    set((s) => {
      const items = s.items.filter((one) => one.id !== id)
      return { items, selectedId: s.selectedId === id ? (items[0]?.id ?? null) : s.selectedId }
    })
  },
  move: (id, delta) =>
    set((s) => {
      const index = s.items.findIndex((one) => one.id === id)
      const target = index + delta
      if (index < 0 || target < 0 || target >= s.items.length) return s
      const items = [...s.items]
      ;[items[index], items[target]] = [items[target], items[index]]
      return { items }
    }),
  clear: () => {
    for (const item of get().items) URL.revokeObjectURL(item.url)
    for (const bitmap of bitmaps.values()) bitmap.close()
    bitmaps.clear()
    set({ items: [], selectedId: null })
  },
  select: (id) => set({ selectedId: id }),
  setRecipe: (patch) => set((s) => ({ recipe: { ...s.recipe, ...patch } })),
  resetRecipe: () => set({ recipe: DEFAULT_RECIPE }),
  setCompose: (patch) => set((s) => ({ composeOptions: { ...s.composeOptions, ...patch } })),
}))

export type ResultState =
  | { status: 'pending' }
  | { status: 'done'; result: ProcessedImage & { url: string } }
  | { status: 'error'; message: string }

/** 参数一变就对全部图重算（串行，防抖 250ms）；新结果到之前旧结果留在屏上，不闪。 */
export function useProcessed(items: ProtoItem[], recipe: Recipe) {
  const [results, setResults] = useState<Map<string, ResultState>>(new Map())
  const [busy, setBusy] = useState(false)
  const urls = useRef(new Map<string, string>())

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      for (const item of items) {
        if (cancelled) return
        const bitmap = bitmaps.get(item.id)
        let next: ResultState
        if (!bitmap) {
          next = { status: 'error', message: item.error ?? '这个浏览器解不开' }
        } else {
          try {
            const processed = await processImage(bitmap, item.type, recipe)
            if (cancelled) return
            const url = URL.createObjectURL(processed.blob)
            const old = urls.current.get(item.id)
            if (old) URL.revokeObjectURL(old)
            urls.current.set(item.id, url)
            next = { status: 'done', result: { ...processed, url } }
          } catch (error) {
            next = { status: 'error', message: error instanceof Error ? error.message : '处理失败' }
          }
        }
        setResults((prev) => new Map(prev).set(item.id, next))
      }
      if (!cancelled) setBusy(false)
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [items, recipe])

  useEffect(() => {
    const owned = urls.current
    return () => {
      for (const url of owned.values()) URL.revokeObjectURL(url)
    }
  }, [])

  return { results, busy }
}

export type ComposedState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'done'; outputs: (ComposedOutput & { url: string })[] }
  | { status: 'error'; message: string }

export function useComposed(items: ProtoItem[], options: ComposeOptions, enabled: boolean) {
  const [state, setState] = useState<ComposedState>({ status: 'idle' })
  const urls = useRef<string[]>([])

  useEffect(() => {
    const sources = items.flatMap((item) => bitmaps.get(item.id) ?? [])
    if (!enabled || sources.length === 0) {
      setState({ status: 'idle' })
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setState((prev) => (prev.status === 'done' ? prev : { status: 'pending' }))
      try {
        const outputs = await compose(sources, options)
        if (cancelled) return
        for (const url of urls.current) URL.revokeObjectURL(url)
        const withUrls = outputs.map((out) => ({ ...out, url: URL.createObjectURL(out.blob) }))
        urls.current = withUrls.map((out) => out.url)
        setState({ status: 'done', outputs: withUrls })
      } catch (error) {
        if (!cancelled)
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : '合成失败',
          })
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [items, options, enabled])

  return state
}

export function totalBytes(items: ProtoItem[], results: Map<string, ResultState>) {
  let before = 0
  let after = 0
  for (const item of items) {
    const state = results.get(item.id)
    if (state?.status !== 'done') continue
    before += item.size
    after += state.result.blob.size
  }
  return { before, after }
}

export function doneEntries(items: ProtoItem[], results: Map<string, ResultState>) {
  return items.flatMap((item) => {
    const state = results.get(item.id)
    return state?.status === 'done' ? [{ item, result: state.result }] : []
  })
}

/** 变体 C 的「全部导出」：调参时只算选中那张，导出时才把配方跑遍全部。 */
export async function processAll(items: ProtoItem[], recipe: Recipe) {
  const entries: { name: string; blob: Blob }[] = []
  for (const item of items) {
    const bitmap = bitmaps.get(item.id)
    if (!bitmap) continue
    const { blob } = await processImage(bitmap, item.type, recipe)
    entries.push({ name: outputName(item.name, blob.type), blob })
  }
  return entries
}
