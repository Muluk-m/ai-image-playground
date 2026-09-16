import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CARD, OUTLINE_BUTTON, PANEL_TITLE } from '../../../components/panelStyles'
import { useTranslation } from '../../../i18n'
import { PRODUCT_ANGLE_LABELS } from '../../../lib/productAngle'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { formatTextList, parseTextList } from '../lib/remixPlan'
import { useProductShotsStore } from '../store'
import ProductPicker from './ProductPicker'
import TextField from './TextField'

export default function ProductBar() {
  const { t } = useTranslation('productShots')
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
        <h2 className={PANEL_TITLE}>{t('product.title')}</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{t('product.subtitle')}</span>
        {productAssets.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('product.empty')}</p>
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
            {t('product.describe')}
          </button>
          <button type="button" onClick={openProductPicker} className={OUTLINE_BUTTON}>
            {productAssets.length === 0 ? t('product.pick') : t('product.change')}
          </button>
        </div>
      </div>

      {describing && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            label={t('product.name')}
            value={product.name}
            placeholder={t('product.namePlaceholder')}
            onChange={(name) => setProductDescription({ name })}
          />
          <TextField
            label={t('product.features')}
            value={product.features}
            placeholder={t('product.featuresPlaceholder')}
            onChange={(features) => setProductDescription({ features })}
          />
          <TextField
            label={t('product.mainColor')}
            value={product.mainColor}
            placeholder={t('product.mainColorPlaceholder')}
            notice={product.mainColor.trim() ? undefined : t('product.noMainColor')}
            onChange={(mainColor) => setProductDescription({ mainColor })}
          />
          <TextField
            // 不受控，所以换任务时要靠 key 重挂。
            key={jobId ?? 'new'}
            label={t('product.forbiddenColors')}
            defaultValue={formatTextList(product.forbiddenColors)}
            placeholder={t('product.forbiddenColorsPlaceholder')}
            onChange={(text) => setProductDescription({ forbiddenColors: parseTextList(text) })}
          />
        </div>
      )}

      {pickerOpen && <ProductPicker />}
    </section>
  )
}
