import SegmentedTabs from '../../../components/SegmentedTabs'
import { useTranslation } from '../../../i18n'
import { type InspirationProviderFilter, useInspirationStore } from '../store'

export default function InspirationProviderTabs() {
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const setProvider = useInspirationStore((s) => s.setProvider)
  const { t } = useTranslation('inspiration')

  return (
    <SegmentedTabs<InspirationProviderFilter>
      label={t('filter.provider')}
      // 后两项是产品名，不翻译。
      tabs={[
        { value: 'all', label: t('filter.all') },
        { value: 'openai-compat', label: 'GPT Image' },
        { value: 'gemini', label: 'Nano Banana 2' },
      ]}
      value={selectedProvider}
      onChange={setProvider}
    />
  )
}
