import { useImageThumbnail } from '../../../hooks/useImageThumbnail'
import { useTranslation } from '../../../i18n'
import AssetThumb from '../../library/components/AssetThumb'

/** 蒙版盖在图上的缩略图。调用方给的容器要是 `relative` 的，叠层才对得上。 */
export default function MattedThumb({
  imageId,
  overlayImageId,
  alt,
}: {
  imageId: string
  overlayImageId: string | null | undefined
  alt: string
}) {
  const { t } = useTranslation('productShots')
  const overlay = useImageThumbnail(overlayImageId ?? undefined)
  return (
    <>
      <AssetThumb imageId={imageId} alt={alt} />
      {overlay?.dataUrl && (
        <img
          src={overlay.dataUrl}
          alt={t('matte.mask')}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </>
  )
}
