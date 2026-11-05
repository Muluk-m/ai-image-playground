export interface SavedView {
  name: string
  href: string
}

function key(page: string): string {
  return `admin.saved-views.${page}`
}

export function readSavedViews(page: string): SavedView[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(page)) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is SavedView =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as SavedView).name === 'string' &&
          typeof (item as SavedView).href === 'string',
      )
      .slice(0, 20)
  } catch {
    return []
  }
}

export function writeSavedView(page: string, view: SavedView): SavedView[] {
  const next = [view, ...readSavedViews(page).filter((item) => item.name !== view.name)].slice(
    0,
    20,
  )
  localStorage.setItem(key(page), JSON.stringify(next))
  return next
}

export function removeSavedView(page: string, name: string): SavedView[] {
  const next = readSavedViews(page).filter((item) => item.name !== name)
  localStorage.setItem(key(page), JSON.stringify(next))
  return next
}
