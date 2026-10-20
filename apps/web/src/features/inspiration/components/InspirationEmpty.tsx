import EmptyState from '../../../components/patterns/EmptyState'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { INSPIRATION_GROUPS } from '../lib/groups'
import { useInspirationStore } from '../store'

export default function InspirationEmpty() {
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const selectedGroup = useInspirationStore((s) => s.selectedGroup)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const onlyImageEdits = useInspirationStore((s) => s.onlyImageEdits)
  const setProvider = useInspirationStore((s) => s.setProvider)
  const setGroup = useInspirationStore((s) => s.setGroup)
  const setOnlyImageEdits = useInspirationStore((s) => s.setOnlyImageEdits)
  const setSearch = useInspirationStore((s) => s.setSearch)
  const { t } = useTranslation('inspiration')
  const query = searchKeyword.trim()
  const filtered =
    Boolean(query) ||
    selectedProvider !== 'all' ||
    Boolean(selectedGroup) ||
    Boolean(selectedCategory) ||
    onlyImageEdits

  const reset = () => {
    setProvider('all')
    setOnlyImageEdits(false)
    setSearch('')
  }

  return (
    <EmptyState
      icon={<Icon name="search" />}
      title={query ? t('list.noResult', { q: query }) : t('list.noFilterResult')}
      description={query ? t('list.noResultHint') : t('list.noFilterHint')}
      action={
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap justify-center gap-2">
            {query ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setSearch('')}>
                {t('list.clearSearch')}
              </Button>
            ) : null}
            {filtered ? (
              <Button type="button" variant="outline" size="sm" onClick={reset}>
                {t('list.resetFilters')}
              </Button>
            ) : null}
          </div>
          <div className="flex max-w-lg flex-wrap justify-center gap-1.5">
            {INSPIRATION_GROUPS.map((group) => (
              <Button
                key={group.id}
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setProvider('all')
                  setGroup(group.id)
                  setSearch('')
                }}
              >
                {t(`group.${group.id}`)}
              </Button>
            ))}
          </div>
        </div>
      }
    />
  )
}
