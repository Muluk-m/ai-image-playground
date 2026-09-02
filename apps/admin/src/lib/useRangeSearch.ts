import { useNavigate, useSearch } from '@tanstack/react-router'

import { parseRange, type Range } from './search-params'

/** 时间窗读写都走 URL：读当前 search 的 range，写回同一路径并 replace。 */
export function useRangeSearch(): [Range, (next: Range) => void] {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { range?: unknown }
  const setRange = (next: Range): void => {
    void navigate({
      to: '.',
      search: (previous) => ({ ...(previous ?? {}), range: next }),
      replace: true,
    })
  }
  return [parseRange(search.range), setRange]
}
