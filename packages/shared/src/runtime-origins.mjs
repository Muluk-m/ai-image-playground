/** Shared by the browser parser and the plain-Node static release script. */
export function parseRuntimeOrigins(input) {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('bff.baseUrlsByOrigin must be an object')
  const result = {}
  for (const [site, api] of Object.entries(input)) {
    const origin = parseOrigin(site)
    const baseUrl = parseOrigin(api)
    if (Object.hasOwn(result, origin))
      throw new Error('bff.baseUrlsByOrigin contains duplicate origins')
    result[origin] = baseUrl
  }
  return result
}

function parseOrigin(value) {
  if (typeof value !== 'string') throw new Error('Runtime origin must be a string')
  let url
  try {
    url = new URL(value.replace(/\/+$/, ''))
  } catch {
    throw new Error('Runtime origin must be an absolute HTTP(S) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash
  )
    throw new Error('Runtime origin must not contain credentials, a path, a query or a fragment')
  return url.origin
}
