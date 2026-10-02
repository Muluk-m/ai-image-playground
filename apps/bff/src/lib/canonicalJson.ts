/** 字段顺序无关的 JSON：同一份业务值无论键序如何都得出同一串，用于哈希与比对。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
