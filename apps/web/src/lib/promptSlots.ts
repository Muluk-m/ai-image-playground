/** 一次提交（笛卡尔积 × 数量）允许的最大出图数。 */
export const MAX_BATCH_IMAGES = 16

const SLOT_RE = /\{([^{}\s]+)\}/g

export type PromptSlotPart =
  | { type: 'text'; text: string }
  | { type: 'slot'; text: string; name: string }

export type SlotValues = Record<string, string[]>

export function getPromptSlotNames(prompt: string): string[] {
  const names: string[] = []
  for (const match of prompt.matchAll(SLOT_RE)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

export function splitTextIntoSlotParts(text: string): PromptSlotPart[] {
  const parts: PromptSlotPart[] = []
  let lastIndex = 0

  for (const match of text.matchAll(SLOT_RE)) {
    if (match.index == null) continue
    if (match.index > lastIndex)
      parts.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    parts.push({ type: 'slot', text: match[0], name: match[1] })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) parts.push({ type: 'text', text: text.slice(lastIndex) })
  return parts
}

export function parseSlotValueLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function getUnfilledPromptSlots(prompt: string, slotValues: SlotValues): string[] {
  return getPromptSlotNames(prompt).filter((name) => !slotValues[name]?.length)
}

/** 展开后的提示词条数；任一槽位无值时为 0。 */
export function getPromptSlotBatchSize(prompt: string, slotValues: SlotValues): number {
  return getPromptSlotNames(prompt).reduce(
    (size, name) => size * (slotValues[name]?.length ?? 0),
    1,
  )
}

/** 按笛卡尔积展开为多条已替换的提示词；任一槽位无值时返回空数组。 */
export function expandPromptSlots(prompt: string, slotValues: SlotValues): string[] {
  const names = getPromptSlotNames(prompt)
  return names.reduce<string[]>(
    (prompts, name) =>
      prompts.flatMap((current) =>
        (slotValues[name] ?? []).map((value) => current.split(`{${name}}`).join(value)),
      ),
    [prompt],
  )
}
