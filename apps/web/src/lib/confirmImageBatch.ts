import { i18next } from '../i18n'
import { useStore } from '../store'

/**
 * 一次导入超过三张时先问清楚；取消/点遮罩都不执行导入。
 * 在过滤非图片和超限文件之后调用，数量才是实际将要进入画布或引用区的张数。
 */
export function confirmImageBatch(count: number, onConfirm: () => void): void {
  if (count <= 3) {
    onConfirm()
    return
  }
  useStore.getState().setConfirmDialog({
    title: i18next.t('image.confirmBatchTitle', { ns: 'lib' }),
    message: i18next.t('image.confirmBatchMessage', { ns: 'lib', count }),
    confirmText: i18next.t('image.confirmBatchAction', { ns: 'lib', count }),
    action: onConfirm,
  })
}
