import { bootstrapClientCapabilities } from '../../../features/billing/../../lib/privateHost'

// 少一个 client-exposed key，parseManifest 就整份作废、静默关掉所有能力，所以这里必须列全。
const ALL_DISABLED = {
  'accounts:login': false,
  'accounts:self-register': false,
  'accounts:sync': false,
  'billing:credits': false,
  'generation:byok': false,
  'generation:video': false,
  'quota:daily': false,
  'remix:analyze': false,
  'remix:listing': false,
}

export async function bootstrapCapabilities(
  overrides: Partial<typeof ALL_DISABLED>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({ ...ALL_DISABLED, ...overrides })) as unknown as typeof fetch
  await bootstrapClientCapabilities(true, '')
  globalThis.fetch = originalFetch
}
