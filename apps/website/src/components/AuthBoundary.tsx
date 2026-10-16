import { Component, type ReactNode } from 'react'
import Overlay from '../../../web/src/components/patterns/Overlay'
import { Button } from '../../../web/src/components/ui/button'
import { copy, type Locale } from '../catalog'

/** A stale or offline auth chunk must not take down the pre-rendered website. */
export class AuthBoundary extends Component<
  {
    children: ReactNode
    locale: Locale
    visible: boolean
    onClose: () => void
  },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    if (!this.props.visible) return null
    const text = copy[this.props.locale]
    return (
      <Overlay label={text.loginTitle} onClose={this.props.onClose}>
        <div className="site-auth-status" role="alert">
          <p>{text.unavailable}</p>
          <Button onClick={() => location.reload()}>{text.retry}</Button>
          <Button variant="ghost" onClick={this.props.onClose}>
            {text.close}
          </Button>
        </div>
      </Overlay>
    )
  }
}
