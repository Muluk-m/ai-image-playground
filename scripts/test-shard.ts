/**
 * Splits a sorted list of test files across CI machines: `--shard 2/3` keeps every third file,
 * starting from the second. Round-robin over the sorted list, so slow neighbouring files (the
 * same route's suites usually sit side by side) land on different machines.
 *
 * Every file belongs to exactly one shard, so running 1/N … N/N covers the whole suite once.
 */
export type Shard = { index: number; total: number }

export function parseShard(value: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim())
  if (!match) throw new Error(`--shard must look like 1/3, got "${value}"`)
  const index = Number(match[1])
  const total = Number(match[2])
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`--shard ${value}: index must be between 1 and the shard count`)
  }
  return { index, total }
}

export function selectShard<T>(sortedFiles: readonly T[], shard: Shard | undefined): T[] {
  if (!shard) return [...sortedFiles]
  return sortedFiles.filter((_, position) => position % shard.total === shard.index - 1)
}
