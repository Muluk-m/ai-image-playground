/**
 * ADR numbers must be unique: links and code comments cite "ADR 0007", so two files sharing a
 * number make that citation ambiguous (it happened three times before this check existed).
 */
const directory = new URL('../docs/adr/', import.meta.url)
const owners = new Map<string, string[]>()
for await (const file of new Bun.Glob('*.md').scan({ cwd: directory.pathname })) {
  const number = /^(\d{4})-/.exec(file)?.[1]
  if (!number) {
    console.error(
      `docs/adr/${file}: name must start with a four-digit number, e.g. 0020-short-title.md`,
    )
    process.exitCode = 1
    continue
  }
  owners.set(number, [...(owners.get(number) ?? []), file])
}
for (const [number, files] of owners) {
  if (files.length > 1) {
    console.error(
      `ADR ${number} is used by ${files.length} files: ${files.sort().join(', ')}. Give the newer one the next free number.`,
    )
    process.exitCode = 1
  }
}
