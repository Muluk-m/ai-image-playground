import { AGENT_TURN_MAX_REFERENCES } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { compressInputImageDataUrls } from '../../../lib/compressInputImage'
import { useStore } from '../../../store'
import type { AgentDraft, AgentReference } from './references'

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

/** 附到草稿末尾；超出上限的丢掉并提示一次。 */
export function attachReferences(draft: AgentDraft, added: readonly AgentReference[]): AgentDraft {
  const room = Math.max(0, AGENT_TURN_MAX_REFERENCES - draft.references.length)
  if (added.length > room) useStore.getState().showToast(TOO_MANY(), 'error')
  const kept = added.slice(0, room)
  return kept.length ? { ...draft, references: [...draft.references, ...kept] } : draft
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
