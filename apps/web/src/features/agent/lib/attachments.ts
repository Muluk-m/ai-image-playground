import { AGENT_TURN_MAX_REFERENCES } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { compressInputImageDataUrls } from '../../../lib/compressInputImage'
import { attachReferences as admitReferences } from '../../../lib/referenceDraft'
import { useStore } from '../../../store'
import { assetViewImages, useLibraryStore } from '../../library/store'
import {
  AGENT_ADMISSION,
  type AgentDraft,
  type AgentReference,
  type AttachedReference,
  attachReference,
} from './references'

// 文案按调用时取，不在模块加载时定死：切语言之后新出的提示要跟着换语言。
const TOO_MANY = () =>
  i18next.t('composer.tooManyReferences', {
    ns: 'agent',
    count: AGENT_TURN_MAX_REFERENCES,
  })

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function fileStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim()
  return (stem || name).slice(0, 60)
}

/**
 * 拖进来 / 粘贴 / 选出来的图片文件 → 参考图。id 现造：它不是画布对象也不是素材，
 * 模型改图时靠它指认这一张。大图先压一道，别让一张手机原片撑爆一轮的请求体。
 */
export async function filesToReferences(files: readonly File[]): Promise<AgentReference[]> {
  const settled = await Promise.allSettled(files.map(fileToDataUrl))
  const readable = settled.flatMap((one, at) =>
    one.status === 'fulfilled' ? [{ file: files[at]!, dataUrl: one.value }] : [],
  )
  const compressed = await compressInputImageDataUrls(readable.map((one) => one.dataUrl))
  return readable.map(({ file }, at) => ({
    id: `file_${crypto.randomUUID()}`,
    dataUrl: compressed[at]!,
    name: fileStem(file.name),
  }))
}

/**
 * 素材 → 草稿。组里全部视角按序附加为参考图（按 `imageId` 去重，已在条里的复用原序号），
 * 提示词里只插一个指向封面的引用——一条素材在提示词里就是一个胶囊。图可能还没下到本机，
 * 先取回来；一张都取不到就什么都不做（`@` 落空，用户看到的还是刚才那句话）。
 * 引用的 id 用素材的 `imageId`：同一张图从画布进来还是从素材库进来都是同一条引用。
 */
export async function attachAssetToDraft(
  draft: AgentDraft,
  assetId: string,
  start: number,
  cursor: number,
): Promise<AttachedReference | null> {
  const asset = useLibraryStore.getState().assets.find((one) => one.id === assetId)
  if (!asset) return null

  const views = (await assetViewImages(asset)).map((image) => ({ ...image, name: asset.name }))
  const [cover, ...rest] = views
  if (!cover) return null

  // 读素材库工具按「最近用过」排序，不记这一笔它就永远看不见智能体这边的使用。
  void useLibraryStore.getState().noteAssetUsed(asset.id)
  return attachReference(draft, cover, start, cursor, rest)
}

/** 附到草稿末尾；这一把整组放不下就一张都不附，并提示一次。 */
export function attachReferences(draft: AgentDraft, added: readonly AgentReference[]): AgentDraft {
  const attached = admitReferences(draft, added, AGENT_ADMISSION)
  if (attached.ok) return attached.draft
  useStore.getState().showToast(TOO_MANY(), 'error')
  return draft
}

/**
 * 输入框登记的「收文件」入口。对话区整块都是落点，但草稿只归输入框管，
 * 面板把拖进来的文件从这里递过去。
 */
let attach: ((files: File[]) => void) | null = null

export function setAgentComposerAttach(next: ((files: File[]) => void) | null): void {
  attach = next
}

export function attachFilesToComposer(files: File[]): boolean {
  if (!attach) return false
  attach(files)
  return true
}
