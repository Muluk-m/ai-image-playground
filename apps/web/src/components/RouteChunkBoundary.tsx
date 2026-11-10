import { Component, type ReactNode } from 'react'
import { signalBootReady } from '../boot/ready'
import { hardReload, isChunkLoadError } from '../lib/chunkLoad'
import { Button } from './ui/button'

interface RouteChunkBoundaryProps {
  children: ReactNode
  title: string
  description: string
  retryLabel: string
  onRetry?: () => void
}

interface RouteChunkBoundaryState {
  error: unknown | null
  unhandledError: unknown
  hasUnhandledError: boolean
}

/** 路由 chunk 下载失败时保留工作台外壳，并给用户一个明确的恢复动作。 */
export class RouteChunkBoundary extends Component<
  RouteChunkBoundaryProps,
  RouteChunkBoundaryState
> {
  state: RouteChunkBoundaryState = { error: null, unhandledError: null, hasUnhandledError: false }

  static getDerivedStateFromError(error: unknown): RouteChunkBoundaryState {
    if (isChunkLoadError(error)) return { error, unhandledError: null, hasUnhandledError: false }
    return { error: null, unhandledError: error, hasUnhandledError: true }
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) return
    console.error('Route chunk failed to load', error)
    // App 自己还没挂上时，闪屏会一直盖到超时。故障页先出来，用户才能点重新加载。
    signalBootReady()
  }

  handleRetry = () => {
    if (this.props.onRetry) {
      this.setState({ error: null, unhandledError: null, hasUnhandledError: false })
      this.props.onRetry()
      return
    }
    hardReload()
  }

  render() {
    if (this.state.hasUnhandledError) throw this.state.unhandledError
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-[min(32rem,calc(100dvh-8rem))] items-center justify-center p-6">
        <div className="max-w-md text-center">
          <p role="alert" className="text-sm text-destructive">
            {this.props.title}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{this.props.description}</p>
          <Button className="mt-4" onClick={this.handleRetry}>
            {this.props.retryLabel}
          </Button>
        </div>
      </div>
    )
  }
}
export default RouteChunkBoundary

export function RouteLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-[min(32rem,calc(100dvh-8rem))] items-center justify-center p-6">
      <p role="status" className="text-sm text-muted-foreground">
        {label}
      </p>
    </div>
  )
}
