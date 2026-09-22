import { i18next } from '../i18n'
import { useStore } from '../store'
import { MAX_IMAGE_BYTES, MAX_IMAGE_MB } from './inputImageLimit'

const nonImageNotice = (): string => i18next.t('image.onlyImages', { ns: 'lib' })

/** 拖入或粘贴进来的一堆文件里只留图片，太大的也丢掉；丢掉的那些各提示一次。 */
export function acceptImageFiles(files: readonly File[]): File[] {
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (images.length < files.length) {
    useStore.getState().showToast(nonImageNotice(), 'error')
  }
  const sized = images.filter((file) => file.size <= MAX_IMAGE_BYTES)
  if (sized.length < images.length) {
    useStore.getState().showToast(
      i18next.t('image.tooLarge', {
        ns: 'lib',
        count: images.length - sized.length,
        max: MAX_IMAGE_MB,
      }),
      'error',
    )
  }
  return sized
}
