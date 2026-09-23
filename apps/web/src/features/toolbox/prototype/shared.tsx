// PROTOTYPE — throwaway。只放三个变体都要的小零件（收图、表单原子、导出动作）；布局各变体自己写。
// 质量滑杆用的是原生 range：原型不加依赖，正式实现换 shadcn slider。

import { type ReactNode, useRef } from 'react'
import { Input } from '../../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { type ImageDropZoneProps, useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { filesFromFolderInput } from '../../../lib/imageFiles'
import { addImageFromFile, useStore } from '../../../store'
import {
  CROP_PRESETS,
  type CropPresetId,
  FORMAT_LABELS,
  type OutputFormat,
  type Recipe,
  type ResizeMode,
} from './ops'
import { useProto } from './state'

export interface ImageIntake {
  dragging: boolean
  dropZoneProps: ImageDropZoneProps
  inputs: ReactNode
  openFiles: () => void
  openFolder: () => void
}

/** 拖入、粘贴、选文件、选文件夹四条路都进同一个 `add`。 */
export function useIntake(): ImageIntake {
  const add = useProto((s) => s.add)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const { dragging, dropZoneProps } = useImageDropZone((files) => void add(files))
  usePasteImageFiles('tools', (files) => void add(files))
  const inputs = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void add([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          const { files } = filesFromFolderInput(event.target.files)
          void add(files.filter((file) => file.type.startsWith('image/')))
          event.target.value = ''
        }}
      />
    </>
  )
  return {
    dragging,
    dropZoneProps,
    inputs,
    openFiles: () => fileInput.current?.click(),
    openFolder: () => folderInput.current?.click(),
  }
}

export async function sendToCreate(blobs: { name: string; blob: Blob }[]) {
  for (const { name, blob } of blobs)
    await addImageFromFile(new File([blob], name, { type: blob.type }))
  useStore.getState().setAppMode('image')
  useStore.getState().showToast(`已放入输入框 ${blobs.length} 张`, 'success')
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T
  options: readonly { value: T; label: ReactNode; disabled?: boolean }[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={`rounded-md ${size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-[13px]'} transition-colors disabled:opacity-40 ${
            value === option.value
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

export function NumberField({
  value,
  onChange,
  suffix,
  className = 'w-28',
}: {
  value: number
  onChange: (value: number) => void
  suffix?: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        className="h-8 pr-9 text-[13px]"
      />
      {suffix && (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  )
}

export function QualitySlider({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={5}
        max={100}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 flex-1 accent-[hsl(var(--primary))]"
      />
      <span className="w-8 text-right text-xs tabular-nums">{value}</span>
    </div>
  )
}

export function PickSelect<T extends string>({
  value,
  options,
  onChange,
  className = 'h-8 w-44 text-[13px]',
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export const FORMAT_OPTIONS = (Object.keys(FORMAT_LABELS) as OutputFormat[]).map((value) => ({
  value,
  label: FORMAT_LABELS[value],
}))

export const CROP_OPTIONS = (Object.keys(CROP_PRESETS) as CropPresetId[]).map((value) => ({
  value,
  label: CROP_PRESETS[value].label,
}))

export const RESIZE_OPTIONS: readonly { value: ResizeMode; label: string }[] = [
  { value: 'none', label: '不改' },
  { value: 'longEdge', label: '长边' },
  { value: 'width', label: '宽度' },
  { value: 'percent', label: '百分比' },
]

export const ROTATE_OPTIONS: readonly { value: Recipe['rotate']; label: string }[] = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
]

export function ResultBadges({ fellBack, overTarget }: { fellBack: boolean; overTarget: boolean }) {
  return (
    <>
      {fellBack && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
          已回退 PNG
        </span>
      )}
      {overTarget && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
          未达目标体积
        </span>
      )}
    </>
  )
}
