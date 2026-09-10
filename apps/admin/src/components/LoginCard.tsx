import type { ReactNode } from 'react'

export interface LoginCardProps {
  error?: string | null
  children: ReactNode
}

export function LoginCard({ error, children }: LoginCardProps) {
  return (
    <div className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">登录</h1>
        <p className="text-xs text-muted-foreground">幕芽 Muvloom · 管理后台</p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {children}
    </div>
  )
}
