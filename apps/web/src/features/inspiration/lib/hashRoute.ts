import { useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { onInspirationPage, openInspiration } from './navigate'

const HASH = '#inspirations'

/** 设置或清除 location.hash 为 #inspirations，不重新触发 hashchange。 */
function setHash(open: boolean) {
  if (typeof window === 'undefined') return
  const { pathname, search } = window.location
  if (open) {
    if (window.location.hash !== HASH)
      window.history.replaceState(null, '', `${pathname}${search}${HASH}`)
  } else if (window.location.hash === HASH) {
    window.history.replaceState(null, '', `${pathname}${search}`)
  }
}

let unsubscribe: (() => void)[] = []

/**
 * hash ↔ 灵感页双向同步：灵感现在是「库」的一个页签，所以这条老链接落到那一页，
 * 离开那一页时 hash 自己清掉。
 */
export function initHashRoute() {
  if (typeof window === 'undefined') return

  for (const off of unsubscribe) off()
  const sync = () => setHash(onInspirationPage())
  unsubscribe = [useStore.subscribe(sync), useLibraryStore.subscribe(sync)]

  const onHashChange = () => {
    if (window.location.hash === HASH) {
      if (!onInspirationPage()) openInspiration()
    } else if (onInspirationPage()) useLibraryStore.getState().setTab('works')
  }
  window.addEventListener('hashchange', onHashChange)
  unsubscribe.push(() => window.removeEventListener('hashchange', onHashChange))

  if (window.location.hash === HASH && !onInspirationPage()) openInspiration()
}
