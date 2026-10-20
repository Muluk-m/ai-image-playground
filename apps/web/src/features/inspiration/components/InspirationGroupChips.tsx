import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { INSPIRATION_GROUPS, type InspirationGroupId } from '../lib/groups'
import { useInspirationStore } from '../store'

/** 九个分组。点一个会清掉搜索词；点「全部」只取消分组。 */
export default function InspirationGroupChips() {
  const selectedGroup = useInspirationStore((s) => s.selectedGroup)
  const setGroup = useInspirationStore((s) => s.setGroup)
  const setSearch = useInspirationStore((s) => s.setSearch)
  const { t } = useTranslation('inspiration')

  const choose = (group: InspirationGroupId | null) => {
    setGroup(group)
    setSearch('')
  }

  return (
    <div
      role="group"
      aria-label={t('filter.groups')}
      className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-pressed={selectedGroup === null}
        className={selectedGroup === null ? 'bg-primary/15 text-primary' : ''}
        onClick={() => choose(null)}
      >
        {t('filter.all')}
      </Button>
      {INSPIRATION_GROUPS.map((group) => (
        <Button
          key={group.id}
          type="button"
          size="xs"
          variant="ghost"
          aria-pressed={selectedGroup === group.id}
          className={`shrink-0 ${selectedGroup === group.id ? 'bg-primary/15 text-primary' : ''}`}
          onClick={() => choose(group.id)}
        >
          {t(`group.${group.id}`)}
        </Button>
      ))}
    </div>
  )
}
