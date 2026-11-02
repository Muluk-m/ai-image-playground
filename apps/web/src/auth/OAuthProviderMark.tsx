import type { OAuthProviderView } from '@image-playground/shared'
import { PrivateWebOAuthProviderMarks } from '../lib/privateOverlay'

export function OAuthProviderMark({ provider }: { provider: OAuthProviderView }) {
  const Mark = PrivateWebOAuthProviderMarks[provider.id]
  if (Mark) return <Mark />
  if (provider.id === 'google')
    return (
      <span aria-hidden="true" className="auth-provider-google">
        G
      </span>
    )
  return (
    <span aria-hidden="true" className="auth-provider-generic">
      {provider.label.slice(0, 1)}
    </span>
  )
}
