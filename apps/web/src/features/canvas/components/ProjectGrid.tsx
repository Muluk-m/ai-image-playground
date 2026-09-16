import { useState } from 'react'
import { PlusIcon, TrashIcon } from '../../../components/icons'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import NamingDialog from '../../library/components/NamingDialog'
import { useLibraryStore } from '../../library/store'
import { cloudProjectsEnabled } from '../lib/projectClient'
import type { CanvasProject } from '../lib/projectRepository'
import { useCanvasProjectStore } from '../projectStore'

export default function ProjectGrid({
  search = '',
  recent = false,
}: {
  search?: string
  recent?: boolean
}) {
  const projects = useCanvasProjectStore((state) => state.projects)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const cloudError = useCanvasProjectStore((state) => state.cloudError)
  const cloudLoading = useCanvasProjectStore((state) => state.cloudLoading)
  const cloudCursor = useCanvasProjectStore((state) => state.cloudCursor)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const [renaming, setRenaming] = useState<CanvasProject | null>(null)
  const [busy, setBusy] = useState(false)
  const visible = [...projects]
    .map((project) => {
      const remote = cloudCatalog[project.id]
      return remote && !project.cloud?.nameDirty
        ? {
            ...project,
            name: remote.name,
            updatedAt: Math.max(project.updatedAt, remote.updatedAt),
            hasContent: project.hasContent || remote.elementCount > 0,
          }
        : project
    })
    .filter(
      (project) =>
        project.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (!recent || project.hasContent),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, recent ? 5 : undefined)
  const enter = async (project?: CanvasProject) => {
    if (busy) return
    setBusy(true)
    try {
      const opened = project
        ? await useAgentStore.getState().selectProject(project.id)
        : await useAgentStore.getState().createProject()
      if (opened) {
        useStore.getState().setAppMode('create')
        useLibraryStore.getState().closePanel()
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {cloudProjectsEnabled() && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {cloudError && <span role="alert">{cloudError}</span>}
          <button
            type="button"
            disabled={cloudLoading}
            className="underline disabled:opacity-50"
            onClick={() => void useCanvasProjectStore.getState().refreshCloud()}
          >
            {cloudLoading ? '正在读取项目…' : cloudError ? '重试读取云端项目' : '刷新云端项目'}
          </button>
          {cloudCursor && (
            <button
              type="button"
              disabled={cloudLoading}
              className="underline disabled:opacity-50"
              onClick={() => void useCanvasProjectStore.getState().refreshCloud(true)}
            >
              加载更多项目
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!search && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enter()}
            className="group flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 text-muted-foreground transition hover:border-primary/60 hover:bg-muted disabled:opacity-50"
          >
            <PlusIcon className="h-8 w-8 transition group-hover:text-primary" />
            <span className="text-sm font-medium">新建项目</span>
          </button>
        )}
        {visible.map((project) => (
          <article
            key={project.id}
            className="group overflow-hidden rounded-2xl border border-border bg-card transition hover:border-primary/50"
          >
            <button
              type="button"
              disabled={busy}
              aria-label={`打开项目 ${project.name}`}
              onClick={() => void enter(project)}
              className="block w-full text-left disabled:opacity-50"
            >
              <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden bg-muted/50">
                {project.cover ? (
                  <img
                    src={project.cover}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="text-4xl text-muted-foreground/40" aria-hidden="true">
                    ✧
                  </span>
                )}
                {project.id === activeId && (
                  <span className="absolute left-3 top-3 rounded-full bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
                    当前项目
                  </span>
                )}
              </div>
              <h3
                className="truncate px-4 pt-3 text-sm font-medium text-foreground"
                title={project.name}
              >
                {project.name}
              </h3>
            </button>
            <div className="flex items-center gap-2 px-4 pb-3 pt-1.5 text-xs text-muted-foreground">
              <time
                className="min-w-0 flex-1 truncate"
                dateTime={new Date(project.updatedAt).toISOString()}
              >
                {new Date(project.updatedAt).toLocaleDateString('zh-CN')} 更新
              </time>
              <span>
                {project.cloud
                  ? project.cloud.revision > 0
                    ? '云端项目'
                    : '等待同步'
                  : '仅此设备'}
              </span>
              <button
                type="button"
                className="rounded px-1.5 py-1 hover:bg-muted hover:text-foreground"
                onClick={() => setRenaming(project)}
                aria-label={`重命名项目 ${project.name}`}
              >
                重命名
              </button>
              {!recent && !project.cloud && (
                <button
                  type="button"
                  className="rounded p-1 hover:bg-muted hover:text-destructive"
                  aria-label={`删除项目 ${project.name}`}
                  onClick={() =>
                    useStore.getState().setConfirmDialog({
                      title: '删除项目',
                      message: `删除“${project.name}”及其画布和会话？此操作无法撤销。`,
                      action: () => {
                        void useAgentStore.getState().deleteProject(project.id)
                      },
                    })
                  }
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {search && !visible.length && (
        <p className="py-16 text-center text-sm text-muted-foreground">没有找到匹配的项目</p>
      )}
      {renaming && (
        <NamingDialog
          title="重命名项目"
          placeholder="给项目起个名字"
          defaultName={renaming.name}
          onCancel={() => setRenaming(null)}
          onSave={(name) => {
            void useCanvasProjectStore
              .getState()
              .update(renaming.id, { name, customName: true })
              .then(
                () => setRenaming(null),
                () => useStore.getState().showToast('项目名称保存失败，请重试。', 'error'),
              )
          }}
        />
      )}
    </>
  )
}
