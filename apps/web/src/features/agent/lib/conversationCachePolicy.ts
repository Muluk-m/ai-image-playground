import policy from '../../../../conversation-cache.config.json'

if (
  Object.keys(policy).length !== 1 ||
  !Number.isSafeInteger(policy.maxBytes) ||
  policy.maxBytes <= 0
)
  throw new Error('Invalid conversation cache maxBytes')

export const cacheMaxBytes = policy.maxBytes
