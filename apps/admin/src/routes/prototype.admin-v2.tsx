import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

import { PrototypeSwitcher, type VariantMeta } from '@/prototype/admin-v2/PrototypeSwitcher'
import { VariantA } from '@/prototype/admin-v2/VariantA'
import { VariantB } from '@/prototype/admin-v2/VariantB'
import { VariantC } from '@/prototype/admin-v2/VariantC'

/**
 * PROTOTYPE — 后台 v2 交互稿。A 已定稿；B/C 仅作为设计决策对照保留。
 * `?variant=A|B|C` 可回看三版结构；默认进入 A。
 * 不经 `_authed`，不打任何 API；只用 `prototype/admin-v2/mock-data.ts`。
 *
 * 起：`pnpm --filter @image-playground/admin dev` → http://localhost:5174/prototype/admin-v2?variant=A
 */

const VARIANTS = [
  { key: 'A', name: '运营台', summary: '左侧分组导航 + 右侧检视抽屉，⌘K 直达任何对象' },
  { key: 'B', name: '指挥中心', summary: '顶栏页签，首页经营 / 部署双栏，内容按状态成看板' },
  { key: 'C', name: '收件箱', summary: '三栏 master-detail，先把该处理的事排成队' },
] as const satisfies readonly VariantMeta<'A' | 'B' | 'C'>[]

type VariantKey = (typeof VARIANTS)[number]['key']

export const Route = createFileRoute('/prototype/admin-v2')({
  validateSearch: (search: Record<string, unknown>): { variant: VariantKey } => ({
    variant: search.variant === 'B' || search.variant === 'C' ? search.variant : 'A',
  }),
  component: PrototypePage,
})

function PrototypePage() {
  const { variant } = Route.useSearch()
  const navigate = useNavigate()
  const setVariant = useCallback(
    (next: VariantKey) => {
      void navigate({ to: '.', search: { variant: next }, replace: true })
    },
    [navigate],
  )

  return (
    <>
      {variant === 'A' && <VariantA />}
      {variant === 'B' && <VariantB />}
      {variant === 'C' && <VariantC />}
      <PrototypeSwitcher variants={VARIANTS} current={variant} onChange={setVariant} />
    </>
  )
}
