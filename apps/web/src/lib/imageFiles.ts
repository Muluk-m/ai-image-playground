import { i18next } from '../i18n'
import { useStore } from '../store'

const nonImageNotice = (): string => i18next.t('image.onlyImages', { ns: 'lib' })

/** 拖入或粘贴进来的一堆文件里只留图片，丢掉的那些提示一次。 */
export function acceptImageFiles(files: readonly File[]): File[] {
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (images.length < files.length) {
    useStore.getState().showToast(nonImageNotice(), 'error')
  }
  return images
}
