import type { AgentConversationView } from '@image-playground/shared'
import { create } from 'zustand'
import {
  AGENT_CONVERSATION_KEY,
  CANVAS_PROJECT_KEY,
  safeLocalStorage,
  scopedStorageName,
} from '../../lib/authScope'
import type { CanvasDoc } from './lib/canvasDoc'
import { getLoadedImage } from './lib/imageCache'
import { type CanvasProject, projectRepository } from './lib/projectRepository'
import { canvasSceneKey } from './lib/workspaceKeys'

interface ProjectState {
  projects: CanvasProject[]
  activeId: string | null
  loaded: boolean
  error: string | null
  load(): Promise<void>
  create(): Promise<CanvasProject>
  activate(id: string): void
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
  async load() {
    if (get().loaded) return
    if (loading) return loading
    loading = (async () => {
      try {
        const projects = await projectRepository.list()
        for (const legacy of await projectRepository.legacyScenes()) {
          if (!projects.some((one) => one.sceneKey === legacy.sceneKey))
            projects.push(await projectRepository.create('未命名项目', legacy))
        }
        const remembered = safeLocalStorage.getItem(scopedStorageName(CANVAS_PROJECT_KEY))
        const conversationId = safeLocalStorage.getItem(scopedStorageName(AGENT_CONVERSATION_KEY))
        let active =
          projects.find((one) => one.id === remembered) ??
          projects.find((one) => conversationId && one.conversationId === conversationId)
        active ??= projects.find((one) => one.sceneKey === canvasSceneKey(conversationId))
        active ??= projects[0]
        if (!active) {
          active = await projectRepository.create('未命名项目', {
            sceneKey: canvasSceneKey(conversationId),
            conversationId,
          })
          projects.push(active)
        }
        set({ projects, loaded: true, error: null })
        get().activate(active.id)
      } catch {
        set({ error: '项目读取失败，原内容已保留，请重新加载。' })
        throw new Error('Project catalog unavailable')
      } finally {
        loading = undefined
      }
    })()
    return loading
  },
  async create() {
    await get().load()
    const project = await projectRepository.create()
    set((state) => ({ projects: [project, ...state.projects] }))
    get().activate(project.id)
    return project
  },
  activate(id) {
    const project = get().projects.find((one) => one.id === id)
    if (!project) return
    set({ activeId: id })
    safeLocalStorage.setItem(scopedStorageName(CANVAS_PROJECT_KEY), id)
    if (project.conversationId)
      safeLocalStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), project.conversationId)
    else safeLocalStorage.removeItem(scopedStorageName(AGENT_CONVERSATION_KEY))
  },
  async update(id, patch) {
    const project = await projectRepository.update(id, patch)
    set((state) => ({ projects: state.projects.map((one) => (one.id === id ? project : one)) }))
  },
  async remove(id) {
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
      const project = await projectRepository.create(conversation.title || '未命名项目', {
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
