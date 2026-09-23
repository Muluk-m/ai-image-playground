import {
  type CloudProjectSummary,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectKind,
} from '@image-playground/shared'
import { create } from 'zustand'
import { accountRequired, promptLogin } from '../../auth/loginPrompt'
import { i18next } from '../../i18n'
import { pathAppMode } from '../../lib/appPaths'
import {
  AGENT_CONVERSATION_KEY,
  accountScope,
  CANVAS_PROJECT_KEY,
  safeLocalStorage,
  scopedStorageName,
} from '../../lib/authScope'
import type { CanvasDoc } from './lib/canvasDoc'
import { getLoadedImage } from './lib/imageCache'
import {
  cloudProjectsEnabled,
  ensureCloudProjectConversation,
  getCloudProject,
  listCloudProjects,
  PROJECT_REQUEST_TIMEOUT_MS,
  ProjectRequestError,
} from './lib/projectClient'
import { type CanvasProject, projectRepository, UNTITLED_PROJECT } from './lib/projectRepository'
import { readProjectRoute, resolveProjectRoute, writeProjectRoute } from './lib/projectRoute'
import { canvasSceneKey } from './lib/workspaceKeys'

interface ProjectState {
  projects: CanvasProject[]
  activeId: string | null
  loaded: boolean
  error: string | null
  routeError: string | null
  cloudError: string | null
  cloudLoading: boolean
  cloudCursor: string | null
  cloudCatalog: Record<string, CloudProjectSummary>
  refreshCloud(more?: boolean): Promise<void>
  load(): Promise<void>
  /** 画布类型建出来就定死；除了视频入口，其余新建都是图片画布。 */
  create(kind?: ProjectKind): Promise<CanvasProject>
  activate(id: string, replaceRoute?: boolean): void
  resolve(id: string): Promise<CanvasProject>
  update(id: string, patch: Parameters<typeof projectRepository.update>[1]): Promise<void>
  /** 目录里这一项换成新的（没有就补进去），云端摘要的名字与时间跟着走。 */
  updateListed(project: CanvasProject): void
  markDeleted(ids: readonly string[]): Promise<void>
  remove(id: string): Promise<void>
  recordScene(sceneKey: string, doc: CanvasDoc): Promise<void>
}

let loading: Promise<void> | undefined

/**
 * 深链接指向的云端项目在这台机器上取不到。原因是「这个部署有账号体系而访客还没登录」时，
 * 先把登录框叫起来——顺着分享链接进来的人要的是登录后接着看这个项目，
 * 而不是一句「本机没有这个项目」。其余原因照旧只报错。
 */
function cloudProjectUnavailable(): Error {
  if (accountRequired()) promptLogin('gated-action')
  return new Error('Project not available on this device')
}

function coverImage(doc: CanvasDoc): string | undefined {
  const element = [...doc.elements].reverse().find((one) => one.type === 'image')
  if (element?.type !== 'image') return
  const image = getLoadedImage(element.fileId, doc.files[element.fileId])
  if (!image) return
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 400 / Math.max(image.naturalWidth, image.naturalHeight))
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/webp', 0.7)
}

export const useCanvasProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeId: null,
  loaded: false,
  error: null,
  routeError: null,
  cloudError: null,
  cloudLoading: false,
  cloudCursor: null,
  cloudCatalog: {},
  async refreshCloud(more = false) {
    if (!cloudProjectsEnabled() || get().cloudLoading) return
    const isCurrent = accountScope()
    set({ cloudLoading: true, cloudError: null })
    try {
      const page = await listCloudProjects(more ? (get().cloudCursor ?? undefined) : undefined)
      if (!isCurrent()) return
      await get().markDeleted(page.deletedIds ?? [])
      if (!isCurrent()) return
      set((state) => ({
        cloudCatalog: {
          ...state.cloudCatalog,
          ...Object.fromEntries(page.projects.map((one) => [one.id, one])),
        },
      }))
      for (const summary of page.projects) {
        const project = await restoreCloudProject(summary)
        if (!isCurrent()) return
        get().updateListed(project)
      }
      set({ cloudCursor: page.nextCursor })
    } catch {
      if (isCurrent()) set({ cloudError: i18next.t('project.cloudListFailed', { ns: 'canvas' }) })
    } finally {
      if (isCurrent()) set({ cloudLoading: false })
    }
  },
  async load() {
    if (get().loaded) return
    if (loading) return loading
    loading = (async () => {
      try {
        let projects = await projectRepository.list()
        for (const legacy of await projectRepository.legacyScenes()) {
          if (!projects.some((one) => one.sceneKey === legacy.sceneKey))
            projects.push(await projectRepository.create(UNTITLED_PROJECT, legacy))
        }
        set({ projects })
        await get().refreshCloud()
        projects = [...get().projects]
        const remembered = safeLocalStorage.getItem(scopedStorageName(CANVAS_PROJECT_KEY))
        const conversationId = safeLocalStorage.getItem(scopedStorageName(AGENT_CONVERSATION_KEY))
        const route = readProjectRoute()
        const routeId = route ? resolveProjectRoute(route, projects) : null
        if (routeId && !projects.some((one) => one.id === routeId)) {
          if (!cloudProjectsEnabled()) throw cloudProjectUnavailable()
          // 云端那份取不回来（链路抖、超时）不该把整个目录判死：本机项目照常列出来，
          // 只标一句云端列表没刷上，用户还能接着用离线的那些。
          try {
            projects.push(
              await restoreCloudProject(
                await getCloudProject(routeId, AbortSignal.timeout(PROJECT_REQUEST_TIMEOUT_MS)),
              ),
            )
          } catch (error) {
            if (error instanceof ProjectRequestError && error.status === 404) throw error
            set({ cloudError: i18next.t('project.cloudListFailed', { ns: 'canvas' }) })
          }
        }
        const available = projects.filter((one) => !one.cloud?.deleted || one.id === routeId)
        // `/` 是首页，不是「上次那个项目」：既不恢复 remembered，也不接上次那条对话，
        // 挑一个干净的空工作区起手。已有的空项目优先复用，否则才新建——
        // 每次回首页都建一个会刷出一堆未命名项目。
        let active = route
          ? available.find((one) => one.id === routeId)
          : available.find((one) => !one.hasContent && !one.workspaceOpened && !one.conversationId)
        if (route) {
          active ??= available.find((one) => one.id === remembered)
          active ??= available.find(
            (one) => conversationId && one.conversationId === conversationId,
          )
          active ??= available.find((one) => one.sceneKey === canvasSceneKey(conversationId))
          active ??= available[0]
        }
        if (!active) {
          // 首页那条不挂上次那段会话：挂上去就等于把它又拉回来了。场景键仍取未绑定会话的那把，
          // 首次发送前留下的草稿才认得出自己属于这个起手工作区。
          const bound = route ? conversationId : null
          active =
            cloudProjectsEnabled() && !bound
              ? await projectRepository.create(UNTITLED_PROJECT, undefined, true)
              : await projectRepository.create(UNTITLED_PROJECT, {
                  sceneKey: canvasSceneKey(bound),
                  conversationId: bound,
                })
          projects.push(active)
        }
        set({ projects, loaded: true, error: null })
        if (readProjectRoute() === route) get().activate(active.id, true)
      } catch {
        set({ error: i18next.t('project.loadFailed', { ns: 'canvas' }) })
        throw new Error('Project catalog unavailable')
      } finally {
        loading = undefined
      }
    })()
    return loading
  },
  async create(kind = 'image' as ProjectKind) {
    await get().load()
    const project = await projectRepository.create(
      UNTITLED_PROJECT,
      undefined,
      cloudProjectsEnabled(),
      true,
      kind,
    )
    set((state) => ({ projects: [project, ...state.projects] }))
    get().activate(project.id)
    return project
  },
  async resolve(id) {
    await get().load()
    id = resolveProjectRoute(id, get().projects)
    const existing = get().projects.find((one) => one.id === id)
    if (existing) return existing
    if (!cloudProjectsEnabled()) throw cloudProjectUnavailable()
    const project = await restoreCloudProject(
      await getCloudProject(id, AbortSignal.timeout(PROJECT_REQUEST_TIMEOUT_MS)),
    )
    get().updateListed(project)
    return project
  },
  activate(id, replaceRoute = false) {
    const project = get().projects.find((one) => one.id === id)
    if (!project) return
    set({ activeId: id })
    // 只有人已经在画布上（项目地址）才改地址。根地址属于创作入口，活动项目不该把它劫持成 `/p/<项目>`。
    if (readProjectRoute(globalThis.location?.pathname ?? '/') !== null)
      writeProjectRoute(id, replaceRoute)
    safeLocalStorage.setItem(scopedStorageName(CANVAS_PROJECT_KEY), id)
    if (project.conversationId)
      safeLocalStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), project.conversationId)
    else safeLocalStorage.removeItem(scopedStorageName(AGENT_CONVERSATION_KEY))
  },
  async update(id, patch) {
    const current = get().projects.find((one) => one.id === id)
    if (
      patch.name !== undefined &&
      (!patch.name.trim() || patch.name.length > PROJECT_NAME_MAX_LENGTH)
    )
      throw new Error('invalid_project_name')
    // 云端项目的名字也先落本机：改名不必等网络，`nameDirty` 保证它不被远端那份盖回去。
    // 推给云端那份是「当前项目」的事（activeProject.renameProject），目录只管落本机。
    const renaming = patch.name === undefined ? undefined : current?.cloud
    get().updateListed(
      await projectRepository.update(id, {
        ...patch,
        ...(renaming ? { cloud: { ...renaming, nameDirty: true } } : {}),
      }),
    )
  },
  updateListed(project) {
    set((state) => ({
      projects: state.projects.some((one) => one.id === project.id)
        ? state.projects.map((one) => (one.id === project.id ? project : one))
        : [...state.projects, project],
      cloudCatalog: state.cloudCatalog[project.id]
        ? {
            ...state.cloudCatalog,
            [project.id]: {
              ...state.cloudCatalog[project.id],
              name: project.name,
              updatedAt: project.updatedAt,
            },
          }
        : state.cloudCatalog,
    }))
  },
  async markDeleted(ids) {
    const isCurrent = accountScope()
    for (const id of ids) {
      const project = get().projects.find((one) => one.id === id)
      if (project?.cloud && !project.cloud.deleted) {
        const updated = await projectRepository.update(id, {
          cloud: { ...project.cloud, deleted: true },
        })
        if (!isCurrent()) return
        get().updateListed(updated)
      }
    }
    if (isCurrent())
      set((state) => ({
        cloudCatalog: Object.fromEntries(
          Object.entries(state.cloudCatalog).filter(([id]) => !ids.includes(id)),
        ),
      }))
  },
  async remove(id) {
    if (get().projects.find((one) => one.id === id)?.cloud)
      throw new Error('cloud_project_delete_unavailable')
    await projectRepository.remove(id)
    set((state) => ({
      projects: state.projects.filter((one) => one.id !== id),
      activeId: state.activeId === id ? null : state.activeId,
    }))
  },
  async recordScene(sceneKey, doc) {
    const project = get().projects.find((one) => one.sceneKey === sceneKey)
    if (!project) return
    let cover: string | undefined
    try {
      cover = coverImage(doc)
    } catch {
      /* 预览不可用不影响原场景保存。 */
    }
    await get().update(project.id, {
      updatedAt: Date.now(),
      hasContent: doc.elements.length > 0 || project.hasContent,
      ...(cover ? { cover } : {}),
    })
  },
}))

export function currentCanvasProject(): CanvasProject | undefined {
  const state = useCanvasProjectStore.getState()
  return state.projects.find((one) => one.id === state.activeId)
}

export async function restoreCloudProject(summary: CloudProjectSummary): Promise<CanvasProject> {
  const isCurrent = accountScope()
  const local = useCanvasProjectStore.getState().projects.find((one) => one.id === summary.id)
  if (summary.conversationId === null && local?.cloud && local.conversationId) {
    const { conversation } = await ensureCloudProjectConversation(summary.id, local.conversationId)
    if (!isCurrent()) throw new Error('account_changed')
    summary = { ...summary, conversationId: conversation.id }
  }
  return projectRepository.importCloud(summary)
}
