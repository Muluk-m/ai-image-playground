import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The Go module embeds its Skills and owns its installer/build scripts. These
// are the inputs consumed by cli-checks.yml; web/BFF checks still run in full.
export function isCliInput(path) {
  return (
    path.startsWith('cli-go/') ||
    path.startsWith('.github/actions/') ||
    /^\.github\/workflows\/cli[^/]*\.ya?ml$/.test(path) ||
    path === '.github/workflows/web.yml' ||
    path === 'scripts/ci-cli-required.mjs' ||
    path === 'scripts/__tests__/ci-cli-required.test.mjs' ||
    path === 'go.work' ||
    path === 'go.work.sum'
  )
}

export function cliRequired(eventName, event, diff) {
  let base
  let head
  let mergeBase = false
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha
    head = event.pull_request?.head?.sha
    mergeBase = true
  } else if (eventName === 'push') {
    base = event.before
    head = event.after
  } else {
    // Manual verification always exercises the entire CLI matrix.
    return true
  }
  const validSha = (sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha)
  if (!validSha(base) || !validSha(head)) return true
  try {
    return diff(base, head, mergeBase).some(isCliInput)
  } catch {
    // Missing history or a failed diff must never turn off a required check.
    return true
  }
}

export function changedPaths(base, head, mergeBase) {
  return execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', ...(mergeBase ? [`${base}...${head}`] : [base, head]), '--'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let required = true
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    required = cliRequired(process.env.GITHUB_EVENT_NAME, event, changedPaths)
  } catch {
    console.warn('Could not inspect changed files; running every CLI check.')
  }
  console.log(`CLI checks required: ${required}`)
  appendFileSync(process.env.GITHUB_OUTPUT, `cli_required=${required}\n`)
}
