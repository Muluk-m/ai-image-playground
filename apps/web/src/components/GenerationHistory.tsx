import { useState } from 'react'
import { useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import CloudGenerationHistory from './CloudGenerationHistory'
import SearchBar from './SearchBar'
import TaskGrid from './TaskGrid'
import { Button } from './ui/button'

export default function GenerationHistory({ userId }: { userId?: string }) {
  const { t } = useTranslation('task')
  const [cloud, setCloud] = useState(false)
  const canReadCloud = Boolean(userId) && isClientCapabilityEnabled('accounts:sync')
  return (
    <>
      {canReadCloud && (
        <div className="flex gap-2 pt-5" role="group" aria-label={t('cloudHistory.title')}>
          <Button
            variant={cloud ? 'ghost' : 'secondary'}
            aria-pressed={!cloud}
            onClick={() => setCloud(false)}
          >
            {t('cloudHistory.local')}
          </Button>
          <Button
            variant={cloud ? 'secondary' : 'ghost'}
            aria-pressed={cloud}
            onClick={() => setCloud(true)}
          >
            {t('cloudHistory.title')}
          </Button>
        </div>
      )}
      {canReadCloud && cloud ? (
        <CloudGenerationHistory />
      ) : (
        <>
          <SearchBar />
          <TaskGrid />
        </>
      )}
    </>
  )
}
