import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useMediaTransferStore } from '../lib/mediaTransfer'

/**
 * 打包下载的传输卡片：画布底部居中，等待中 → 打包中 → 已完成。
 * lifted：资产弹窗开着时跟进弹窗那一层，抬到底部操作条上方（bottom 84px），不被遮罩挡住。
 */
export default function MediaTransferCard({ lifted = false }: { lifted?: boolean }) {
  const { t } = useTranslation('canvas')
  const transfer = useMediaTransferStore((s) => s.transfer)
  const dismiss = useMediaTransferStore((s) => s.dismiss)
  if (!transfer) return null
  const ended = transfer.status === 'finished' || transfer.status === 'failed'
  const done = transfer.status === 'finished' ? 1 : 0
  return (
    <div className="studio-transfer" data-lifted={lifted || undefined} role="status">
      <div className="studio-transfer-head">
        <span className="flex-1">
          {ended
            ? t('assetsPanel.transfer.done', { done, total: 1 })
            : t('assetsPanel.transfer.active', { done, total: 1 })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="studio-canvas-assets-iconbtn"
          aria-label={t('assetsPanel.transfer.close')}
          onClick={dismiss}
        >
          <Icon name="close" />
        </Button>
      </div>
      <div className="studio-transfer-row">
        <span className="studio-transfer-file">
          <Icon name="exportPackage" />
        </span>
        <div className="studio-transfer-name">
          <div className="truncate">{transfer.fileName}</div>
          <div className="studio-transfer-bar">
            <i style={{ width: `${Math.round(transfer.progress * 100)}%` }} />
          </div>
        </div>
        <span className="studio-transfer-status">
          {transfer.status === 'waiting'
            ? t('assetsPanel.transfer.waiting')
            : transfer.status === 'packing'
              ? t('assetsPanel.transfer.packing')
              : transfer.status === 'finished'
                ? t('assetsPanel.transfer.finished')
                : t('assetsPanel.transfer.failed')}
        </span>
      </div>
    </div>
  )
}
