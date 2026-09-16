import { exportStorage, fromBase64, importEntry, type StorageEntry, toBase64 } from './storage'

interface MigrationConfig {
  sourceOrigin: string
  targetOrigin: string
  sourceApi: string
  targetApi: string
}
interface Pending {
  secret: string
  returnPath: string
  created: number
}
const PENDING = 'muvloom.domain-migration.pending'
const DONE = 'muvloom.domain-migration.done'
const BRIDGE = '/__domain-migration'
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha = async (s: string) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
const keyFor = (s: string) =>
  crypto.subtle.importKey(
    'raw',
    Uint8Array.from(s.match(/../g)!, (x) => Number.parseInt(x, 16)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )

async function post<T>(api: string, route: string, body: unknown): Promise<T> {
  const r = await fetch(`${api}/api/domain-migration/${route}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    cache: 'no-store',
  })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'migration_network')
  return r.json()
}
function preparing(): HTMLElement {
  const view = document.createElement('main')
  view.className = 'auth-status-screen'
  const icon = document.createElement('img')
  icon.src = '/brand/muvloom-icon.svg'
  icon.width = 40
  icon.height = 40
  icon.alt = ''
  const text = document.createElement('p')
  text.textContent = '正在准备工作台'
  view.append(icon, text)
  document.getElementById('root')!.replaceChildren(view)
  return view
}
async function exportAtSource(config: MigrationConfig, proof: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(proof)) throw new Error('migration_invalid')
  const key = await keyFor(proof)
  const transfer = await post<{ id: string; uploadKey: string }>(config.sourceApi, 'start', {
    challenge: await sha(proof),
  })
  let sequence = 0,
    record = 0
  async function* batches() {
    let batch: StorageEntry[] = []
    let size = 0
    for await (const entry of exportStorage()) {
      const length = JSON.stringify(entry).length
      if (size + length > 150_000 && batch.length) {
        yield JSON.stringify(batch)
        batch = []
        size = 0
      }
      batch.push(entry)
      size += length
      if (size >= 150_000) {
        yield JSON.stringify(batch)
        batch = []
        size = 0
      }
    }
    if (batch.length) yield JSON.stringify(batch)
  }
  for await (const json of batches()) {
    const parts = Math.max(1, Math.ceil(json.length / 150_000))
    for (let part = 0; part < parts; part++) {
      const plaintext = JSON.stringify({
        record,
        part,
        parts,
        text: json.slice(part * 150_000, (part + 1) * 150_000),
      })
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: new TextEncoder().encode(`${transfer.id}:${sequence}`),
        },
        key,
        new TextEncoder().encode(plaintext),
      )
      const bytes = new Uint8Array(12 + encrypted.byteLength)
      bytes.set(iv)
      bytes.set(new Uint8Array(encrypted), 12)
      await post(config.sourceApi, 'upload', { ...transfer, sequence, ciphertext: toBase64(bytes) })
      sequence++
    }
    record++
  }
  await post(config.sourceApi, 'seal', { ...transfer, chunks: sequence })
  location.replace(`${config.targetOrigin}${BRIDGE}#ticket=${transfer.id}`)
}
async function importAtTarget(
  config: MigrationConfig,
  id: string,
  pending: Pending,
): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/.test(id) ||
    !/^[a-f0-9]{64}$/.test(pending.secret) ||
    Date.now() - pending.created > 60 * 60_000
  )
    throw new Error('migration_expired')
  const destination = new URL(pending.returnPath, config.targetOrigin)
  if (destination.origin !== config.targetOrigin || destination.pathname === BRIDGE)
    throw new Error('migration_invalid_return')
  const key = await keyFor(pending.secret)
  let text = '',
    record = 0,
    nextPart = 0,
    expectedParts = 0,
    total = 1
  for (let sequence = 0; sequence < total; sequence++) {
    const chunk = await post<{ chunks: number; ciphertext: string | null }>(
      config.targetApi,
      'read',
      { id, proof: pending.secret, sequence },
    )
    total = chunk.chunks
    if (total === 0) break
    if (!chunk.ciphertext) throw new Error('migration_incomplete')
    const bytes = fromBase64(chunk.ciphertext)
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.slice(0, 12),
        additionalData: new TextEncoder().encode(`${id}:${sequence}`),
      },
      key,
      bytes.slice(12),
    )
    const part = JSON.parse(new TextDecoder().decode(plain)) as {
      record: number
      part: number
      parts: number
      text: string
    }
    if (
      part.record !== record ||
      part.part !== nextPart ||
      part.parts < 1 ||
      (nextPart && part.parts !== expectedParts)
    )
      throw new Error('migration_incomplete')
    expectedParts = part.parts
    nextPart++
    text += part.text
    if (nextPart === expectedParts) {
      for (const entry of JSON.parse(text) as StorageEntry[]) await importEntry(entry)
      record++
      nextPart = 0
      text = ''
    }
  }
  if (nextPart) throw new Error('migration_incomplete')
  await post(config.targetApi, 'finish', { id, proof: pending.secret })
  localStorage.setItem(DONE, config.sourceOrigin)
  sessionStorage.removeItem(PENDING)
  location.replace(destination.href)
}
export function hasPendingDomainMigration(): boolean {
  if (location.pathname === BRIDGE) return true
  try {
    return Boolean(sessionStorage.getItem(PENDING))
  } catch {
    return false
  }
}

/** Returns true only when migration owns the page; normal application startup must wait. */
export async function migrateDomain(api: string): Promise<boolean> {
  const currentUrl = new URL(
    `${location.pathname}${location.search}${location.hash}`,
    location.origin,
  )
  if (currentUrl.searchParams.get('__migration_skip') === '1') {
    let destination = currentUrl
    try {
      const stored = JSON.parse(sessionStorage.getItem(PENDING) ?? '{}') as Partial<Pending>
      if (currentUrl.pathname === BRIDGE)
        destination = new URL(stored.returnPath ?? '/', location.origin)
      sessionStorage.setItem('muvloom.domain-migration.defer', '1')
    } catch {
      if (currentUrl.pathname === BRIDGE) destination = new URL('/', location.origin)
    }
    if (destination.origin !== location.origin) destination = new URL('/', location.origin)
    destination.searchParams.delete('__migration_skip')
    history.replaceState(
      null,
      '',
      `${destination.pathname}${destination.search}${destination.hash}`,
    )
    return false
  }
  let config: MigrationConfig | null
  try {
    const r = await fetch(`${api}/api/domain-migration/config`, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    if (r.status === 404) config = null
    else {
      if (!r.ok) throw new Error('migration_config_unavailable')
      config = await r.json()
    }
    if (!config && (location.pathname === BRIDGE || sessionStorage.getItem(PENDING)))
      throw new Error('migration_config_unavailable')
  } catch {
    const view = preparing()
    view.querySelector('p')!.textContent = '暂时无法连接服务，原数据仍保留。请重试。'
    const retry = document.createElement('button')
    retry.textContent = '重试'
    retry.onclick = () => location.reload()
    view.append(retry)
    return true
  }
  if (!config || ![config.sourceOrigin, config.targetOrigin].includes(location.origin)) return false
  const view = preparing()
  try {
    if (sessionStorage.getItem('muvloom.domain-migration.defer') === '1') return false
    if (
      location.origin === config.targetOrigin &&
      location.pathname !== BRIDGE &&
      localStorage.getItem(DONE) === config.sourceOrigin
    )
      return false
    if (location.origin === config.sourceOrigin) {
      const proof = new URLSearchParams(location.hash.slice(1)).get('proof')
      if (location.pathname === BRIDGE && proof) await exportAtSource(config, proof)
      else
        location.replace(
          `${config.targetOrigin}${location.pathname}${location.search}${location.hash}`,
        )
    } else {
      const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket')
      if (location.pathname === BRIDGE && ticket) {
        const stored = sessionStorage.getItem(PENDING)
        if (!stored) throw new Error('migration_missing_browser_state')
        await importAtTarget(config, ticket, JSON.parse(stored))
      } else {
        const saved = sessionStorage.getItem(PENDING)
        const previous = saved ? (JSON.parse(saved) as Pending) : null
        const pending: Pending = {
          secret: hex(crypto.getRandomValues(new Uint8Array(32))),
          returnPath:
            location.pathname === BRIDGE
              ? (previous?.returnPath ?? '/')
              : `${location.pathname}${location.search}${location.hash}`,
          created: Date.now(),
        }
        sessionStorage.setItem(PENDING, JSON.stringify(pending))
        location.replace(`${config.sourceOrigin}${BRIDGE}#proof=${pending.secret}`)
      }
    }
  } catch (error) {
    console.warn('[domain-migration]', error instanceof Error ? error.message : 'failed')
    view.querySelector('p')!.textContent = '暂时无法恢复旧站数据。原数据仍保留，请重试。'
    const retry = document.createElement('button')
    retry.className = 'auth-submit'
    retry.textContent = '重试'
    retry.onclick = () => {
      if (
        location.origin === config!.targetOrigin &&
        location.pathname === BRIDGE &&
        !(
          error instanceof Error &&
          [
            'migration_expired',
            'migration_missing_browser_state',
            'migration_session_expired',
          ].includes(error.message)
        )
      )
        location.reload()
      else location.replace(`${config!.targetOrigin}${BRIDGE}`)
    }
    const proceed = document.createElement('button')
    proceed.textContent = '稍后再试，先进入工作台'
    proceed.onclick = () => location.replace(`${config!.targetOrigin}${BRIDGE}?__migration_skip=1`)
    view.append(retry, proceed)
  }
  return true
}
