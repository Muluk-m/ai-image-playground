// PROTOTYPE：模板详情——左大图（封面 / 参考图可切），右提示词全文 + 模型尺寸 + 动作。
import { Copy, Pencil, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import Overlay from '../components/Overlay'
import AgentMarkdown from '../features/agent/components/AgentMarkdown'
import { PURPOSE_TONE, type ProtoLook } from './data'

const ACTION =
  'inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium transition'

export default function LookDetailPrototype({
  look,
  onClose,
  onBatch,
  onAgent,
}: {
  look: ProtoLook
  onClose: () => void
  onBatch: (l: ProtoLook) => void
  onAgent: (command: string) => void
}) {
  const images = [
    { src: look.cover, label: look.origin === '自建' && look.refs.length ? '金样封面' : '封面' },
    ...look.refs.filter((r) => r !== look.cover).map((src, i) => ({ src, label: `参考图 ${i + 1}` })),
  ]
  const [index, setIndex] = useState(0)
  const sections = look.prompt
    .split(/\n(?=## )/)
    .map((block) => {
      const [head, ...body] = block.split('\n')
      const title = head.replace(/^## \d+\.\s*/, '').replace(/^## /, '')
      return { title, body: body.join('\n').trim() }
    })

  return (
    <Overlay onClose={onClose} layout="fill">
      <div className="mx-auto flex h-[min(92dvh,900px)] w-[min(96vw,1240px)] overflow-hidden rounded-2xl border border-border bg-background shadow-[var(--studio-shadow)]">
        {/* 左：图 */}
        <div className="flex min-w-0 flex-[3] flex-col bg-black/40">
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-6">
            <img
              src={images[index].src}
              alt=""
              className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
            />
            <span className="absolute left-8 top-8 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-white">
              {images[index].label}
            </span>
          </div>
          {images.length > 1 && (
            <div className="flex gap-2 px-6 pb-4">
              {images.map((img, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIndex(i)}
                  className={`overflow-hidden rounded-lg border-2 ${i === index ? 'border-primary' : 'border-transparent opacity-60'}`}
                >
                  <img src={img.src} alt="" className="h-16 w-12 object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 右：文 */}
        <div className="flex w-[400px] shrink-0 flex-col border-l border-border">
          <div className="flex items-start gap-2 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-medium">{look.name}</h2>
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${PURPOSE_TONE[look.purpose]}`}>
                  {look.purpose}
                </span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {look.origin}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{look.description}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {look.needsRetune && (
              <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                钉死的模型 {look.model} 已下线，需重新调试后才能出图。
              </div>
            )}
            <div className="space-y-4 text-[13px] leading-relaxed text-foreground">
              {sections.map((s) => (
                <section key={s.title}>
                  <h3 className={`mb-1 text-[12px] font-medium ${s.title.includes('输入') ? 'text-primary' : 'text-muted-foreground'}`}>
                    {s.title}
                  </h3>
                  <AgentMarkdown text={s.body} />
                </section>
              ))}
            </div>

            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
              <dt className="text-muted-foreground">模型</dt>
              <dd>{look.model}</dd>
              <dt className="text-muted-foreground">尺寸</dt>
              <dd>{look.size}</dd>
              <dt className="text-muted-foreground">素材位</dt>
              <dd>{look.slots} 个</dd>
              <dt className="text-muted-foreground">参考图</dt>
              <dd>{look.refs.length} 张</dd>
            </dl>
          </div>

          <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
            <div className="flex gap-2">
              <button
                type="button"
                disabled={look.needsRetune}
                onClick={() => onBatch(look)}
                className={`${ACTION} bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40`}
              >
                <Sparkles className="h-4 w-4" /> 用它出图
              </button>
              <button
                type="button"
                onClick={() => onAgent(`/create-look 继续调试模板「${look.name}」`)}
                className={`${ACTION} border border-border hover:bg-muted`}
              >
                <Pencil className="h-4 w-4" /> {look.origin === '自建' ? '继续调试' : '复制一份来改'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
