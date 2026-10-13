import { useTranslation } from '../i18n'
import { useStore } from '../store'
import SearchField from './patterns/SearchField'
import { Button } from './ui/button'
import { Icon } from './ui/icon'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/** `compact`：首屏「我的作品」那一行用的窄版，不自带上下留白。 */
export default function SearchBar({ compact = false }: { compact?: boolean } = {}) {
  const { t } = useTranslation(['composer', 'common'])
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore((s) => s.setSearchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const setFilterStatus = useStore((s) => s.setFilterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setFilterFavorite = useStore((s) => s.setFilterFavorite)

  return (
    <div
      data-no-drag-select
      className={`flex items-center ${compact ? 'gap-4' : 'mb-4 mt-6 gap-3'}`}
    >
      <div className={`z-20 flex flex-shrink-0 ${compact ? 'gap-4' : 'gap-2'}`}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setFilterFavorite(!filterFavorite)}
          className={`shrink-0 ${
            filterFavorite
              ? 'border-primary bg-accent text-primary'
              : 'border-border bg-card text-muted-foreground hover:bg-card'
          }`}
          title={filterFavorite ? t('search.favoriteOnlyOff') : t('search.favoriteOnly')}
          aria-label={filterFavorite ? t('search.favoriteOnlyOff') : t('search.favoriteOnly')}
          aria-pressed={filterFavorite}
        >
          <Icon name="favorite" filled={filterFavorite} />
        </Button>
        <div className="relative w-28">
          <Select
            value={filterStatus}
            onValueChange={(value) => setFilterStatus(value as typeof filterStatus)}
          >
            <SelectTrigger aria-label={t('search.status')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('search.statusAll')}</SelectItem>
              <SelectItem value="done">{t('search.statusDone')}</SelectItem>
              <SelectItem value="running">{t('common:state.generating')}</SelectItem>
              <SelectItem value="error">{t('common:state.failed')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <SearchField
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        className="z-10 min-w-0 max-w-none flex-1"
      />
    </div>
  )
}
