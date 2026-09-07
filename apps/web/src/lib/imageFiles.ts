import { useStore } from '../store'

const NON_IMAGE_NOTICE = '只支持图片文件'

/** 拖入或粘贴进来的一堆文件里只留图片，丢掉的那些提示一次。 */
export function acceptImageFiles(files: readonly File[]): File[] {
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (images.length < files.length) {
    useStore.getState().showToast(NON_IMAGE_NOTICE, 'error')
  }
  return images
}
