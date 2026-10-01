interface DependencyItem {
  readonly key: string
  readonly dependencies: readonly string[]
}
interface DependencyTarget {
  readonly key: string
  readonly submitted: boolean
  readonly status: string | null
  readonly archived: boolean
}

/** Unsubmitted descendants of a durably cancelled target need no task or billing attempt. */
export function cancelledBatchDependents(
  items: readonly DependencyItem[],
  targets: readonly DependencyTarget[],
): Set<string> {
  const cancelled = new Set(
    targets
      .filter((target) => target.archived && target.status === 'cancelled')
      .map((target) => target.key),
  )
  const submitted = new Set(
    targets.filter((target) => target.submitted).map((target) => target.key),
  )
  const skipped = new Set<string>()
  // Plans contain at most 100 items. Iteration also handles callers whose rows aren't topological.
  for (let pass = 0; pass < items.length; pass++) {
    let changed = false
    for (const item of items) {
      if (submitted.has(item.key) || cancelled.has(item.key)) continue
      if (!item.dependencies.some((key) => cancelled.has(key))) continue
      cancelled.add(item.key)
      skipped.add(item.key)
      changed = true
    }
    if (!changed) break
  }
  return skipped
}
