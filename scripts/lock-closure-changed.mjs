#!/usr/bin/env node
// Decides whether the dependencies one side of the deployment actually installs changed between
// two commits. A lockfile edit for one app (a web-only package) should not rebuild the others.
//
//   node scripts/lock-closure-changed.mjs <base> <target> <importer>...
//
// Reads pnpm-lock.yaml at both commits and hashes the importers named here, every workspace
// importer they link to, and every package snapshot reachable from them. Exits 0 when the hashes
// differ, 1 when they match. Anything it cannot read or parse counts as changed (exit 0): a
// skipped deploy is worse than a redundant one.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

const [base, target, ...roots] = process.argv.slice(2)

const unquote = (value) => value.replace(/^'(.*)'$/, '$1')

/** The parts of a pnpm lockfile (v9) this check needs, keeping each entry's own lines. */
export function parseLock(text) {
  const sections = { importers: new Map(), packages: new Map(), snapshots: new Map() }
  // Everything outside the three dependency sections (lockfileVersion, settings, overrides,
  // patchedDependencies, catalogs…) changes what every side installs.
  const global = []
  const seen = new Set()
  let section = null
  let entry = null
  let inDeps = false
  let pending = null
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      const name = line.replace(/:.*$/, '')
      seen.add(name)
      section = sections[name] ? name : null
      entry = null
      if (!section) global.push(line)
      continue
    }
    if (!section) {
      if (line.trim()) global.push(line)
      continue
    }
    if (!line.trim()) continue
    const top = line.match(/^ {2}(\S.*?):(?:\s+\{\})?$/)
    if (top) {
      entry = { lines: [line], deps: [] }
      sections[section].set(unquote(top[1]), entry)
      inDeps = false
      pending = null
      continue
    }
    if (!entry) continue
    entry.lines.push(line)
    if (section === 'packages') continue
    const group = line.match(/^ {4}(\w+):/)
    if (group) {
      inDeps = ['dependencies', 'devDependencies', 'optionalDependencies'].includes(group[1])
      pending = null
      continue
    }
    if (!inDeps) continue
    if (section === 'importers') {
      const name = line.match(/^ {6}(\S.*?):$/)
      if (name) {
        pending = unquote(name[1])
        continue
      }
      const version = line.match(/^ {8}version:\s+(.+)$/)
      if (version && pending) entry.deps.push([pending, unquote(version[1])])
    } else {
      const dep = line.match(/^ {6}(\S.*?):\s+(.+)$/)
      if (dep) entry.deps.push([unquote(dep[1]), unquote(dep[2])])
    }
  }
  const version = text.match(/^lockfileVersion:\s*'?(\d+)(?:\.\d+)?'?\s*$/m)?.[1]
  if (version !== '9') throw new Error(`unsupported lockfileVersion ${version ?? '(missing)'}`)
  for (const name of ['importers', 'packages', 'snapshots'])
    if (!seen.has(name)) throw new Error(`lockfile has no ${name} section`)
  return { ...sections, global: global.join('\n') }
}

/** Snapshot key for a resolved dependency; aliases (`name@version`) already are one. */
function snapshotKey(name, version) {
  if (/^@?[^@(]+@/.test(version) && !/^\d/.test(version)) return version
  return `${name}@${version}`
}

/** The packages entry drops peer suffixes: `a@1.0.0(react@19)` → `a@1.0.0`. */
function packageKey(key) {
  const at = key.indexOf('@', 1)
  const paren = key.indexOf('(', at)
  return paren === -1 ? key : key.slice(0, paren)
}

export function closureHash(lock, importers) {
  const parts = [`global\n${lock.global}`]
  const seenImporters = new Set()
  const seenSnapshots = new Set()
  const queue = importers.map((path) => ['importer', path])
  while (queue.length) {
    const [kind, key] = queue.pop()
    if (kind === 'importer') {
      if (seenImporters.has(key)) continue
      seenImporters.add(key)
      const entry = lock.importers.get(key)
      // A root that is not in the lockfile at all hashes as missing; a link to one cannot be read.
      if (!entry && !importers.includes(key)) throw new Error(`linked importer ${key} is missing`)
      parts.push(`importer ${key}\n${entry ? entry.lines.join('\n') : '(missing)'}`)
      for (const [name, version] of entry?.deps ?? []) {
        if (version.startsWith('link:'))
          queue.push(['importer', posix.normalize(posix.join(key, version.slice(5)))])
        else queue.push(['snapshot', snapshotKey(name, version)])
      }
      continue
    }
    if (seenSnapshots.has(key)) continue
    seenSnapshots.add(key)
    const snapshot = lock.snapshots.get(key)
    const pkg = lock.packages.get(packageKey(key))
    // An unresolved reference means this parser did not understand the file: do not guess.
    if (!snapshot || !pkg) throw new Error(`package ${key} is referenced but not in the lockfile`)
    parts.push(`snapshot ${key}\n${snapshot.lines.join('\n')}\n${pkg.lines.join('\n')}`)
    for (const [name, version] of snapshot.deps)
      queue.push(['snapshot', snapshotKey(name, version)])
  }
  return createHash('sha256').update(parts.sort().join('\n\n')).digest('hex')
}

function lockAt(revision) {
  return execFileSync('git', ['show', `${revision}:pnpm-lock.yaml`], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (!base || !target || roots.length === 0) throw new Error('usage: <base> <target> <importer>...')
    const before = closureHash(parseLock(lockAt(base)), roots)
    const after = closureHash(parseLock(lockAt(target)), roots)
    process.exit(before === after ? 1 : 0)
  } catch (error) {
    console.log(`::warning::lockfile closure check failed (${error.message}); treating it as changed.`)
    process.exit(0)
  }
}
