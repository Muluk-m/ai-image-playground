/**
 * Strict argument parsing shared by the inspiration maintenance scripts (not a script itself).
 * Unknown options, a value option without a value, or a value that looks like another option all
 * abort before anything touches the database: a typo must never flip a run into the opposite
 * bulk operation (for example `--operator --restore` silently archiving).
 */
export interface ParsedArgs {
  file: string
  flags: Set<string>
  options: Map<string, string>
}

export function parseArgs(
  argv: string[],
  spec: { flags: string[]; options: string[]; usage: string },
): ParsedArgs {
  const fail = (message: string): never => {
    throw new Error(`${message}\nusage: ${spec.usage}`)
  }
  const flags = new Set<string>()
  const options = new Map<string, string>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (spec.options.includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-') || !value.trim()) {
        fail(`${arg} needs a value`)
      }
      if (options.has(arg)) fail(`${arg} given twice`)
      options.set(arg, (value as string).trim())
      index++
    } else if (arg.startsWith('-')) {
      if (!spec.flags.includes(arg)) fail(`unknown option ${arg}`)
      flags.add(arg)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) fail(`expected exactly one input path, got ${positional.length}`)
  return { file: positional[0] as string, flags, options }
}
