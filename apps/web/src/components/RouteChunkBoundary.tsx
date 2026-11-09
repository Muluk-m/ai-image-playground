import { Component, type ReactNode } from 'react'
import { Button } from './ui/button'

interface RouteChunkBoundaryProps {
  children: ReactNode
  title: string
  description: string
  retryLabel: string
  onRetry?: () => void
}

interface RouteChunkBoundaryState {
  error: Error | null
}

/** 路由 chunk 下载失败时保留工作台外壳，并给用户一个明确的恢复动作。 */
export class RouteChunkBoundary extends Component<
  RouteChunkBoundaryProps,
  RouteChunkBoundaryState
> {
  state: RouteChunkBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RouteChunkBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Route chunk failed to load', error)
  }

  handleRetry = () => {
    this.setState({ error: null })
    if (this.props.onRetry) this.props.onRetry()
    else window.location.reload()
  }

  render() {
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
