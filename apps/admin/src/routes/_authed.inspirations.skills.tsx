import { createFileRoute } from '@tanstack/react-router'
import { Layers3, Lock } from 'lucide-react'
import { useState } from 'react'

import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useAgentSkillCatalog, useInspirations } from '@/lib/inspirations'

export const Route = createFileRoute('/_authed/inspirations/skills')({
  component: SkillsPage,
})

const MODE_OPTIONS = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
] as const

function SkillsPage() {
  const [mode, setMode] = useState<'image' | 'video'>('image')
  const skills = useAgentSkillCatalog(mode)
  // 「被几条灵感挂着」只能从条目侧数：技能目录本身不知道谁引用了它。
  const items = useInspirations()

  return (
    <Page
      crumbs={[{ label: '灵感库', to: '/inspirations' }, { label: '技能目录' }]}
      description="当前部署带着哪些技能，只读"
      actions={
        <SegmentedControl
          label="按创作类型筛选"
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
        />
      }
    >
      <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
        <Lock className="mt-0.5 size-4 shrink-0" />
        <div>
          <strong>技能正文随 BFF 镜像发布（ADR 0007）</strong>
          <p className="mt-1 text-muted-foreground">
            每条技能是镜像里的 <code className="text-xs">SKILL.md</code> 加{' '}
            <code className="text-xs">meta.json</code>，后台只能查看和挂到灵感条目上；
            改正文要发新版镜像，这里没有编辑入口。
          </p>
        </div>
      </div>

      {skills.isPending ? (
        <PendingState label="加载技能目录" />
      ) : skills.isError ? (
        <ErrorState label="加载技能目录失败" error={skills.error} />
      ) : skills.data.length === 0 ? (
        <EmptyState label={mode === 'video' ? '这套部署没有视频技能' : '这套部署没有图片技能'} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {skills.data.map((skill) => {
            const linked = (items.data ?? []).filter((item) => item.skillName === skill.name).length
            return (
              <Card key={skill.name}>
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="rounded-lg bg-primary/15 p-2 text-primary">
                    <Layers3 className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <strong>{skill.title}</strong>
                      <code className="text-xs text-muted-foreground">/{skill.name}</code>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {skill.summary || skill.description.replace(/^何时用：/, '')}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge variant="outline">
                        {mode === 'video' ? '视频轮可用' : '图片轮可用'}
                      </Badge>
                      <Badge variant="secondary">关联 {linked} 条灵感</Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </Page>
  )
}
