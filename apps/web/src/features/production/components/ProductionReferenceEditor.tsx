import type { ProductionMediaReference } from '@image-playground/shared'
import { ImagePlus, Library, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { imageMimeFromBytes } from '../../../lib/imageBytes'
import { MAX_IMAGE_BYTES } from '../../../lib/inputImageLimit'
import { getAssetImage } from '../../../lib/sync/syncClient'
import { uploadMediaBytes } from '../../../lib/uploadMedia'
import { assetStore } from '../../library/lib/assetStore'
import type { AssetRecord } from '../../library/types'
import ProductionReferencePreview from './ProductionReferencePreview'

export default function ProductionReferenceEditor({
  conversationId,
  name,
  value,
  onChange,
  disabled,
}: {
  conversationId: string
  name: string
  value?: ProductionMediaReference
  onChange: (value: ProductionMediaReference | undefined) => void
  disabled: boolean
}) {
  const { t } = useTranslation('production')
  const change = useRef(onChange)
  change.current = onChange
  const fileInput = useRef<HTMLInputElement>(null)
  const lifetime = useRef<AbortController>(new AbortController())
  const [uploading, setUploading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [library, setLibrary] = useState<AssetRecord[] | null>(null)
  const [localPreview, setLocalPreview] = useState<{ key: string; url: string }>()
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])
  useEffect(
    () => () => {
      if (localPreview) URL.revokeObjectURL(localPreview.url)
    },
    [localPreview],
  )
  const upload = async (file: File) => {
    setUploading(true)
    setFailed(false)
    try {
      if (file.size > MAX_IMAGE_BYTES) throw new Error('image_too_large')
      const bytes = await file.arrayBuffer()
      const contentType = imageMimeFromBytes(bytes)
      if (!contentType) throw new Error('unsupported_image')
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
      const mediaId = await uploadMediaBytes(bytes, contentType, hash, lifetime.current.signal)
      if (lifetime.current.signal.aborted) return
      setLocalPreview({ key: `media:${mediaId}`, url: URL.createObjectURL(file) })
      change.current({ kind: 'media', mediaId })
    } catch {
      if (!lifetime.current.signal.aborted) setFailed(true)
    } finally {
      if (!lifetime.current.signal.aborted) setUploading(false)
    }
  }
  const chooseAsset = async (imageId: string) => {
    setFailed(false)
    try {
      const blob = await getAssetImage(imageId)
      if (!blob) throw new Error('missing')
      if (lifetime.current.signal.aborted) return
      setLocalPreview({ key: `asset:${imageId}`, url: URL.createObjectURL(blob) })
      change.current({ kind: 'asset', imageId })
      setLibrary(null)
    } catch {
      if (!lifetime.current.signal.aborted) setFailed(true)
    }
  }
  const showLibrary = async () => {
    setFailed(false)
    try {
      const items = await assetStore.list()
      if (!lifetime.current.signal.aborted) setLibrary(items)
    } catch {
      setFailed(true)
    }
  }
  return (
    <div className="production-reference-editor">
      {value && (
        <div className="production-reference-detail">
          {localPreview &&
          ((value.kind === 'media' && localPreview.key === `media:${value.mediaId}`) ||
            (value.kind === 'asset' && localPreview.key === `asset:${value.imageId}`)) ? (
            <img src={localPreview.url} alt={name} />
          ) : (
            <ProductionReferencePreview
              conversationId={conversationId}
              reference={value}
              name={name}
            />
          )}
        </div>
      )}
      <div className="production-reference-actions">
        <button
          type="button"
          disabled={disabled || uploading}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus size={14} />
          {t(uploading ? 'saving' : 'asset.upload')}
        </button>
        <button type="button" disabled={disabled || uploading} onClick={() => void showLibrary()}>
          <Library size={14} />
          {t('asset.library')}
        </button>
        {value && (
          <button
            type="button"
            aria-label={t('asset.removeReference')}
            disabled={disabled || uploading}
            onClick={() => onChange(undefined)}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label={t('asset.upload')}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file)
        }}
      />
      {failed && (
        <p className="production-error" role="alert">
          {t('asset.uploadFailed')}
        </p>
      )}
      {library && (
        <div className="production-library-picker">
          <header>
            <strong>{t('asset.library')}</strong>
            <button type="button" aria-label={t('close')} onClick={() => setLibrary(null)}>
              <X size={14} />
            </button>
          </header>
          {library.length === 0
            ? t('asset.emptyLibrary')
            : library.flatMap((asset) =>
                asset.views.map((view, index) => (
                  <button
                    type="button"
                    key={`${asset.id}:${view.imageId}`}
                    onClick={() => void chooseAsset(view.imageId)}
                  >
                    {asset.name}
                    {asset.views.length > 1 ? ` · ${index + 1}` : ''}
                  </button>
                )),
              )}
        </div>
      )}
    </div>
  )
}
