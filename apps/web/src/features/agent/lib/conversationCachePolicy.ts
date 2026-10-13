import policy from '../../../../conversation-cache.config.json'

if (
  Object.keys(policy).sort().join(',') !== 'maxBytes,prefetch' ||
  !Number.isSafeInteger(policy.maxBytes) ||
  policy.maxBytes <= 0 ||
  Object.keys(policy.prefetch).sort().join(',') !== 'idleMs,maxAttempts,retryMs' ||
  Object.values(policy.prefetch).some((value) => !Number.isSafeInteger(value) || value <= 0)
)
  throw new Error('Invalid conversation cache policy')

export const cacheMaxBytes = policy.maxBytes
export const prefetchPolicy = policy.prefetch
