import { useRef } from 'react'
import { FIELD, OUTLINE_BUTTON } from '../../../components/panelStyles'
import { useTranslation } from '../../../i18n'
import {
  PRODUCT_ANGLE_LABELS,
  PRODUCT_ANGLES,
  type ProductAngle,
  type ProductAsset,
} from '../../../lib/productAngle'
import type { AssetRecord } from '../types'
import AssetThumb from './AssetThumb'

interface ProductAssetPickerProps {
  assets: readonly AssetRecord[]
  selected: readonly ProductAsset[]
  uploadLabel: string
  onToggle: (assetId: string) => void
  onAngleChange: (assetId: string, angle: ProductAngle) => void
  onUpload: (files: File[]) => void
}

/** 素材多选加角度标注：复刻套图的产品素材与换背景的素材弹层共用这一份。 */
export default function ProductAssetPicker({
  assets,
  selected,
  uploadLabel,
  onToggle,
  onAngleChange,
  onUpload,
}: ProductAssetPickerProps) {
  const { t } = useTranslation('library')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const angleOf = (assetId: string): ProductAngle | null =>
    selected.find((product) => product.assetId === assetId)?.angle ?? null

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={OUTLINE_BUTTON}
        >
          {uploadLabel}
        </button>
        <span className="text-xs text-muted-foreground">
          {t('picker.selectedCount', { count: selected.length })}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label={uploadLabel}
          onChange={(e) => {
            onUpload([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>

      {assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('picker.empty')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {assets.map((asset) => {
            const angle = angleOf(asset.id)
            return (
              <li key={asset.id} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => onToggle(asset.id)}
                  aria-pressed={angle !== null}
                  className={`overflow-hidden rounded-xl border transition ${
                    angle !== null
                      ? 'border-primary ring-2 ring-ring/30'
                      : 'border-border hover:border-primary'
                  }`}
                >
                  <span className="block aspect-square">
                    <AssetThumb imageId={asset.imageId} alt={asset.name} />
                  </span>
                  <span className="block truncate px-2 py-1 text-xs text-foreground">
                    {asset.name}
                  </span>
                </button>
                {angle !== null && (
                  <select
                    value={angle}
                    data-angle-for={asset.id}
                    aria-label={t('picker.angleLabel', { name: asset.name })}
                    onChange={(e) => onAngleChange(asset.id, e.target.value as ProductAngle)}
                    className={FIELD}
                  >
                    {PRODUCT_ANGLES.map((option) => (
                      <option key={option} value={option}>
                        {PRODUCT_ANGLE_LABELS[option]}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
