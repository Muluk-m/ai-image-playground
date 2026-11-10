import { Component, type ReactNode } from 'react'
import { Button } from './ui/button'

interface RouteChunkBoundaryProps {
  children: ReactNode
  title: string
  description: string
  retryLabel: string
  onRetry?: () => void
  /** 默认判定较宽；包住整个工作台时传严格判定，免得把普通运行时错误当成分片失败。 */
  isChunkError?: (error: unknown) => boolean
  /** 失败画面出现时调用，例如通知启动守卫撤下闪屏。 */
  onChunkError?: () => void
}

interface RouteChunkBoundaryState {
  error: unknown | null
  unhandledError: unknown
  hasUnhandledError: boolean
}

function isRouteChunkError(error: unknown) {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'ChunkLoadError') {
    return true
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return [
    /failed to fetch(?: dynamically imported module)?/i,
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    /failed to load module script/i,
    /loading chunk .* failed/i,
    /\bload failed\b/i,
    /unable to preload (?:css|js) for/i,
  ].some((pattern) => pattern.test(message))
}

/** 路由 chunk 下载失败时保留工作台外壳，并给用户一个明确的恢复动作。 */
export class RouteChunkBoundary extends Component<
  RouteChunkBoundaryProps,
  RouteChunkBoundaryState
> {
  state: RouteChunkBoundaryState = { error: null, unhandledError: null, hasUnhandledError: false }

  static getDerivedStateFromError(error: unknown): RouteChunkBoundaryState {
    if (isRouteChunkError(error)) return { error, unhandledError: null, hasUnhandledError: false }
    return { error: null, unhandledError: error, hasUnhandledError: true }
  }

  componentDidCatch(error: unknown) {
    if (this.isChunkError(error)) {
      console.error('Route chunk failed to load', error)
      this.props.onChunkError?.()
    }
  }

  isChunkError(error: unknown) {
    return this.props.isChunkError ? this.props.isChunkError(error) : isRouteChunkError(error)
  }

  handleRetry = () => {
    this.setState({ error: null, unhandledError: null, hasUnhandledError: false })
    if (this.props.onRetry) this.props.onRetry()
    else window.location.reload()
  }

  render() {
    if (this.state.hasUnhandledError) throw this.state.unhandledError
    if (!this.state.error) return this.props.children
    // getDerivedStateFromError 拿不到 props：只有默认判定在那里分流，自定义判定在这里补上。
    if (!this.isChunkError(this.state.error)) throw this.state.error
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
