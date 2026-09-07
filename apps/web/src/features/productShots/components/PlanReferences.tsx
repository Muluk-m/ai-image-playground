import type { ProductBox } from '@image-playground/shared'
import { LABEL } from '../../../components/panelStyles'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import type { ProductShotVersion } from '../types'

interface Reference {
  label: string
  imageId: string
  box?: ProductBox | null
}

/** 这一版实际用到的图：原图、换上去的产品素材、抠出来的蒙版。 */
export default function PlanReferences({
  imageId,
  version,
}: {
  imageId: string
  version: ProductShotVersion
}) {
  const productImageId = useLibraryStore(
    (s) => s.assets.find((item) => item.id === version.productAssetId)?.imageId,
  )
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)

  const matteImageId = version.mattePreviewImageId ?? version.maskImageId
  const references: Reference[] = [{ label: '原图', imageId, box: version.productBox }]
  if (productImageId) references.push({ label: '产品', imageId: productImageId })
  if (matteImageId) references.push({ label: '蒙版', imageId: matteImageId })

  const imageIds = references.map((item) => item.imageId)

  return (
    <div data-product-shots-plan-references>
      <span className={LABEL}>参考图</span>
      <ul className="mt-1 flex flex-wrap gap-2">
        {references.map((item) => (
          <li key={item.label} className="w-16">
            <button
              type="button"
              onClick={() => setLightboxImageId(item.imageId, imageIds)}
              aria-label={`放大${item.label}`}
              className="group relative block h-16 w-16 overflow-hidden rounded-lg border border-gray-200 dark:border-white/[0.08]"
            >
              <AssetThumb imageId={item.imageId} alt={item.label} />
              {item.box && <BoxOutline box={item.box} />}
            </button>
            <span className="mt-0.5 block truncate text-center text-[10px] text-gray-500 dark:text-gray-400">
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 产品框是 0–1 归一化的，按百分比落到缩略图上，四个数字才有画面对照。 */
function BoxOutline({ box }: { box: ProductBox }) {
  return (
    <span
      data-product-shots-plan-box
      className="pointer-events-none absolute rounded-[3px] border border-blue-400 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
      }}
    />
  )
}
