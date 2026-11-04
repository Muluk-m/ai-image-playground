import Dialog from '../../components/patterns/Dialog'
import { useTranslation } from '../../i18n'
import CliConnectionsSection from './CliConnectionsSection'

export default function CliConnectionsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('shell')
  return (
    <Dialog onClose={onClose} tier="raised" title={t('header.cliConnections')}>
      <p className="mb-5 text-body-sm text-muted-foreground">
        {t('header.cliConnectionsDescription')}
      </p>
      <CliConnectionsSection standalone />
    </Dialog>
  )
}
