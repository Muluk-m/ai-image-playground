import type { ComponentProps } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 助手回复用的 Markdown 渲染。模型习惯用列表、加粗、代码回答，原样显示星号与短横
 * 读起来像乱码。样式手写而不引 typography 插件：面板恒定深色、字号只有 xs 一档。
 */
const BLOCK = 'my-1.5 first:mt-0 last:mb-0'
const LIST = `${BLOCK} flex flex-col gap-0.5 pl-4`

const components: ComponentProps<typeof Markdown>['components'] = {
  p: ({ node: _node, ...props }) => <p className={BLOCK} {...props} />,
  ul: ({ node: _node, ...props }) => <ul className={`${LIST} list-disc`} {...props} />,
  ol: ({ node: _node, ...props }) => <ol className={`${LIST} list-decimal`} {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold text-[#e8e8ea]" {...props} />
  ),
  h1: ({ node: _node, ...props }) => (
    <p className={`${BLOCK} font-semibold text-[#e8e8ea]`} {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <p className={`${BLOCK} font-semibold text-[#e8e8ea]`} {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <p className={`${BLOCK} font-semibold text-[#e8e8ea]`} {...props} />
  ),
  a: ({ node: _node, ...props }) => (
    <a
      className="text-blue-300 underline decoration-blue-300/40 hover:text-blue-200"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) =>
    className ? (
      <code className={`${className} font-mono text-[11px]`} {...props} />
    ) : (
      <code className="rounded bg-white/[0.08] px-1 py-px font-mono text-[11px]" {...props} />
    ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className={`${BLOCK} overflow-x-auto rounded-lg bg-white/[0.06] px-2.5 py-2 font-mono text-[11px] leading-relaxed`}
      {...props}
    />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className={`${BLOCK} border-l-2 border-white/[0.14] pl-2 text-[#9a9aa3]`}
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-2 border-white/[0.09]" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className={`${BLOCK} overflow-x-auto`}>
      <table className="border-collapse text-[11px]" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border border-white/[0.12] px-1.5 py-0.5 text-left font-semibold" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border border-white/[0.12] px-1.5 py-0.5" {...props} />
  ),
}

export default function AgentMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Markdown>
  )
}
