import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CARD, FIELD, LABEL, OUTLINE_BUTTON } from '../../../components/panelStyles'
import { PRODUCT_ANGLE_LABELS } from '../../../lib/productAngle'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { formatColorList, parseColorList } from '../lib/remixPlan'
import { useProductShotsStore } from '../store'
import ProductPicker from './ProductPicker'

const NO_MAIN_COLOR = '未填主色，颜色可能漂'

export default function ProductBar() {
  const productAssets = useProductShotsStore(useShallow((s) => s.draft.productAssets))
  const product = useProductShotsStore(useShallow((s) => s.draft.product))
  const jobId = useProductShotsStore((s) => s.draft.id)
  const pickerOpen = useProductShotsStore((s) => s.productPickerOpen)
  const assets = useLibraryStore(useShallow((s) => s.assets))
  const [describing, setDescribing] = useState(false)

  const { openProductPicker, setProductDescription } = useProductShotsStore.getState()

  return (
    <section data-product-shots-product className={`${CARD} mb-4`}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">我的产品</h2>
        {productAssets.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            还没选产品素材，换产品与借创意重做要用它
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {productAssets.map((picked) => {
              const asset = assets.find((item) => item.id === picked.assetId)
              return (
                <li key={picked.assetId} className="w-14">
                  <span className="block h-14 w-14 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
                    <AssetThumb imageId={asset?.imageId ?? ''} alt={asset?.name ?? ''} />
                  </span>
                  <span className="mt-0.5 block truncate text-center text-[10px] text-gray-500 dark:text-gray-400">
                    {PRODUCT_ANGLE_LABELS[picked.angle]}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-product-shots-describe
            onClick={() => setDescribing((open) => !open)}
            aria-expanded={describing}
            className={OUTLINE_BUTTON}
          >
            产品描述
          </button>
          <button type="button" onClick={openProductPicker} className={OUTLINE_BUTTON}>
            {productAssets.length === 0 ? '选素材' : '换素材'}
          </button>
        </div>
      </div>

      {describing && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="产品名"
            value={product.name}
            placeholder="默认用素材名"
            onChange={(name) => setProductDescription({ name })}
          />
          <Field
            label="外形特征"
            value={product.features}
            placeholder="例：蛋形单边斜背"
            onChange={(features) => setProductDescription({ features })}
          />
          <Field
            label="主色"
            value={product.mainColor}
            placeholder="例：哑光灰棕"
            notice={product.mainColor.trim() ? undefined : NO_MAIN_COLOR}
            onChange={(mainColor) => setProductDescription({ mainColor })}
          />
          <Field
            // 受控会把刚敲下的分隔符吃掉（解析后又格式化回去），所以这一格不受控，换任务时重挂。
            key={jobId ?? 'new'}
            label="禁止色"
            defaultValue={formatColorList(product.forbiddenColors)}
            placeholder="例：米白、浅灰"
            onChange={(text) => setProductDescription({ forbiddenColors: parseColorList(text) })}
          />
        </div>
      )}

      {pickerOpen && <ProductPicker />}
    </section>
  )
}

interface FieldProps {
  label: string
  value?: string
  defaultValue?: string
  placeholder: string
  notice?: string
  onChange: (value: string) => void
}

function Field({ label, value, defaultValue, placeholder, notice, onChange }: FieldProps) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input
        type="text"
        aria-label={label}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 ${FIELD}`}
      />
      {notice && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{notice}</p>}
    </label>
  )
}
