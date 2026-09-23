import type { InspirationReferenceInput } from '@image-playground/shared'
import { ImageOff, Loader2, Plus, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { inspirationErrorMessage, uploadInspirationAsset } from '@/lib/inspirations'
import { assetUrl, MAX_REFERENCE_IMAGES } from './constants'

/** 公开桶只收这四种，跟 BFF createInspirationUploadTarget 的白名单一致。 */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * 上传两步走：拿预签名 PUT → 直传公开桶，成功后把**绝对地址**交给表单。
 * 存绝对地址而不是裸 key，后台刷新后才有图可渲染（BFF 对 http(s) 原样放行）。
 */
function useAssetUpload() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File | undefined, apply: (publicUrl: string, name: string) => void) {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const uploaded = await uploadInspirationAsset(file)
      apply(uploaded.publicUrl, file.name)
    } catch (uploadError) {
      setError(inspirationErrorMessage(uploadError))
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, upload }
}

function AssetThumb({ url, className }: { url: string; className?: string }) {
  return url ? (
    <img src={url} alt="" className={className} />
  ) : (
    <div
      className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ''}`}
    >
      <ImageOff className="size-4" />
    </div>
  )
}

interface AssetPickerProps {
  label: string
  hint?: string
  value: string
  onChange: (next: string) => void
  clearable?: boolean
}

export function AssetPicker({ label, hint, value, onChange, clearable }: AssetPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { busy, error, upload } = useAssetUpload()
  const preview = assetUrl(value)

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      <div className="flex gap-3">
        <AssetThumb url={preview} className="size-20 shrink-0 rounded-lg object-cover" />
        <div className="min-w-0 flex-1 space-y-2">
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="https://… 或点右边上传"
            className="font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(event) => {
                void upload(event.target.files?.[0], (publicUrl) => onChange(publicUrl))
                event.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Upload className="mr-1 size-3.5" />
              )}
              上传
            </Button>
            {clearable && value ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
                清空
              </Button>
            ) : null}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}

interface ReferenceImageFieldsProps {
  value: InspirationReferenceInput[]
  onChange: (next: InspirationReferenceInput[]) => void
}

/** 参考图：主站「玩同款」会把它们塞进 composer，所以名字是给用户看的，必填。 */
export function ReferenceImageFields({ value, onChange }: ReferenceImageFieldsProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { busy, error, upload } = useAssetUpload()

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          参考图（最多 {MAX_REFERENCE_IMAGES} 张）
        </span>
        <span className="text-[11px] text-muted-foreground">名字会显示在主站的素材条上</span>
      </div>
      {value.map((reference, index) => (
        <div key={reference.key} className="flex items-center gap-3 rounded-lg border p-2">
          <AssetThumb
            url={assetUrl(reference.key)}
            className="size-12 shrink-0 rounded-md object-cover"
          />
          <Input
            value={reference.name}
            placeholder="素材名"
            onChange={(event) =>
              onChange(
                value.map((entry, position) =>
                  position === index ? { ...entry, name: event.target.value } : entry,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`移除参考图 ${reference.name || index + 1}`}
            onClick={() => onChange(value.filter((_, position) => position !== index))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          void upload(event.target.files?.[0], (publicUrl, name) =>
            onChange([...value, { key: publicUrl, name }]),
          )
          event.target.value = ''
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy || value.length >= MAX_REFERENCE_IMAGES}
        onClick={() => fileRef.current?.click()}
      >
        {busy ? (
          <Loader2 className="mr-1 size-3.5 animate-spin" />
        ) : (
          <Plus className="mr-1 size-3.5" />
        )}
        添加参考图
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
