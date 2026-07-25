import { createFileRoute } from '@tanstack/react-router'
import { Loader2, Plus } from 'lucide-react'
import { useState } from 'react'

import { UserFormDialog } from '@/components/UserFormDialog'
import { UserTable } from '@/components/UserTable'
import { Button } from '@/components/ui/button'
import { useUsers } from '@/lib/queries'
import type { AdminUserRow } from '@/lib/types'

export const Route = createFileRoute('/_authed/users')({
  component: UsersPage,
})

function UsersPage() {
  const query = useUsers()
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<AdminUserRow | undefined>()

  if (query.isPending) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
        加载用户失败：{(query.error as Error).message}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">用户</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            共 {query.data.users.length} 个账号 · 管理经营站点登录；图片额度将在后续接入这里
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          创建账号
        </Button>
      </div>

      {query.data.truncated ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          结果已截断到最新的 1000 个账号
        </div>
      ) : null}
      <UserTable users={query.data.users} onResetPassword={setResetting} />

      <UserFormDialog mode="create" open={creating} onOpenChange={setCreating} />
      <UserFormDialog
        mode="reset"
        user={resetting}
        open={Boolean(resetting)}
        onOpenChange={(open) => {
          if (!open) setResetting(undefined)
        }}
      />
    </div>
  )
}
