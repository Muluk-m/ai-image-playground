import { create } from 'zustand'
import type { ExportSource } from './export'

interface ExportRequest {
  sources: readonly ExportSource[]
  name: string
}
export const useImageExportStore = create<{
  request: ExportRequest | null
  open: (sources: readonly ExportSource[], name?: string) => void
  close: () => void
}>((set) => ({
  request: null,
  open: (sources, name = 'images') => {
    if (sources.length) set({ request: { sources, name } })
  },
  close: () => set({ request: null }),
}))
export const openImageExport = (sources: readonly ExportSource[], name?: string) =>
  useImageExportStore.getState().open(sources, name)
