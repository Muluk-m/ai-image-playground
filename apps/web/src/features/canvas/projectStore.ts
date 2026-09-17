import type { AgentConversationView, CloudProjectSummary } from '@image-playground/shared'
import { create } from 'zustand'
import { i18next } from '../../i18n'
import {
  AGENT_CONVERSATION_KEY,
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
  create(): Promise<CanvasProject>
  activate(id: string, replaceRoute?: boolean): void
  resolve(id: string): Promise<CanvasProject>
  update(id: string, patch: Parameters<typeof projectRepository.update>[1]): Promise<void>
  remove(id: string): Promise<void>
  importConversations(
    conversations: readonly AgentConversationView[],
    isCurrent?: () => boolean,
  ): Promise<void>
  recordScene(sceneKey: string, doc: CanvasDoc): Promise<void>
}

let loading: Promise<void> | undefined

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
    const scope = scopedStorageName(CANVAS_PROJECT_KEY)
    set({ cloudLoading: true, cloudError: null })
    try {
      const page = await listCloudProjects(more ? (get().cloudCursor ?? undefined) : undefined)
      if (scopedStorageName(CANVAS_PROJECT_KEY) !== scope) return
      set((state) => ({
        cloudCatalog: {
          ...state.cloudCatalog,
          ...Object.fromEntries(page.projects.map((one) => [one.id, one])),
        },
      }))
      for (const summary of page.projects) {
        const project = await restoreCloudProject(summary)
        if (scopedStorageName(CANVAS_PROJECT_KEY) !== scope) return
        set((state) => ({
          projects: state.projects.some((one) => one.id === project.id)
            ? state.projects.map((one) => (one.id === project.id ? project : one))
            : [...state.projects, project],
        }))
      }
      set({ cloudCursor: page.nextCursor })
    } catch {
      if (scopedStorageName(CANVAS_PROJECT_KEY) === scope)
        set({ cloudError: i18next.t('project.cloudListFailed', { ns: 'canvas' }) })
    } finally {
      if (scopedStorageName(CANVAS_PROJECT_KEY) === scope) set({ cloudLoading: false })
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
          if (!cloudProjectsEnabled()) throw new Error('Project not available on this device')
          projects.push(
            await restoreCloudProject(await getCloudProject(routeId, AbortSignal.timeout(10000))),
          )
        }
        let active =
          projects.find((one) => one.id === routeId) ??
          projects.find((one) => one.id === remembered) ??
          projects.find((one) => conversationId && one.conversationId === conversationId)
        active ??= projects.find((one) => one.sceneKey === canvasSceneKey(conversationId))
        active ??= projects[0]
        if (!active) {
          active =
            cloudProjectsEnabled() && !conversationId
              ? await projectRepository.create(UNTITLED_PROJECT, undefined, true)
              : await projectRepository.create(UNTITLED_PROJECT, {
                  sceneKey: canvasSceneKey(conversationId),
                  conversationId,
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
  async create() {
    await get().load()
    const project = await projectRepository.create(
      UNTITLED_PROJECT,
      undefined,
      cloudProjectsEnabled(),
      true,
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
    if (!cloudProjectsEnabled()) throw new Error('Project not available on this device')
    const project = await restoreCloudProject(await getCloudProject(id, AbortSignal.timeout(10000)))
    set((state) => ({ projects: [...state.projects, project] }))
    return project
  },
  activate(id, replaceRoute = false) {
    const project = get().projects.find((one) => one.id === id)
    if (!project) return
    set({ activeId: id })
    writeProjectRoute(id, replaceRoute)
    safeLocalStorage.setItem(scopedStorageName(CANVAS_PROJECT_KEY), id)
    if (project.conversationId)
      safeLocalStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), project.conversationId)
    else safeLocalStorage.removeItem(scopedStorageName(AGENT_CONVERSATION_KEY))
  },
  async update(id, patch) {
    const current = get().projects.find((one) => one.id === id)
    if (current?.cloud && patch.name !== undefined && cloudProjectsEnabled()) {
      const { renameCloudProject } = await import('./lib/workspaces')
      await renameCloudProject(current, patch.name)
      return
    }
    const project = await projectRepository.update(id, {
      ...patch,
      ...(current?.cloud && patch.name !== undefined
        ? { cloud: { ...current.cloud, nameDirty: true } }
        : {}),
    })
    set((state) => ({ projects: state.projects.map((one) => (one.id === id ? project : one)) }))
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
  async importConversations(conversations, isCurrent = () => true) {
    await get().load()
    for (const conversation of conversations) {
      if (!isCurrent()) return
      const existing = get().projects.find((one) => one.conversationId === conversation.id)
      if (existing) {
        if (!existing.customName && conversation.title && existing.name !== conversation.title)
          await get().update(existing.id, { name: conversation.title, hasContent: true })
        continue
      }
      const project = await projectRepository.create(conversation.title || UNTITLED_PROJECT, {
        sceneKey: canvasSceneKey(conversation.id),
        conversationId: conversation.id,
      })
      set((state) => ({
        projects: state.projects.some((one) => one.id === project.id)
          ? state.projects
          : [...state.projects, project],
      }))
    }
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
  const scope = scopedStorageName('canvas')
  const local = useCanvasProjectStore.getState().projects.find((one) => one.id === summary.id)
  if (summary.conversationId === null && local?.cloud && local.conversationId) {
    const { conversation } = await ensureCloudProjectConversation(summary.id, local.conversationId)
    if (scopedStorageName('canvas') !== scope) throw new Error('account_changed')
    summary = { ...summary, conversationId: conversation.id }
  }
  return projectRepository.importCloud(summary)
}
