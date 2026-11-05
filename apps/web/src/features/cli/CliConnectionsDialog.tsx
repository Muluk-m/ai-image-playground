import Dialog from '../../components/patterns/Dialog'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { useTranslation } from '../../i18n'
import { CLI_CONNECT_PATH } from '../../lib/appPaths'
import { navigate } from '../../lib/pathname'
import CliConnectionsSection from './CliConnectionsSection'

/**
 * 账户菜单里的「CLI 连接」。已连接设备在这里查看和撤销；第一次接入、安装与授权引导在
 * `/connect` 整页。公开账户菜单与收费 overlay 的菜单都从这个导出进来（宿主面，先扩后缩）。
 */
export default function CliConnectionsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('shell')
  const { t: tAuth } = useTranslation('auth')
  return (
    <Dialog
      onClose={onClose}
      tier="raised"
      title={t('header.cliConnections')}
      footer={
        <Button
          type="button"
          size="sm"
          onClick={() => {
            onClose()
            navigate(CLI_CONNECT_PATH)
          }}
        >
          <Icon name="terminal" />
          {tAuth('cliConnect.openGuide')}
        </Button>
      }
    >
      <p className="mb-5 text-body-sm text-muted-foreground">
        {t('header.cliConnectionsDescription')}
      </p>
      <CliConnectionsSection standalone />
    </Dialog>
  )
}
