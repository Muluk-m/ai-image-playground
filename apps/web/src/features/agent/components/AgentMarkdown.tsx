import type { ComponentProps } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AgentReplyImage } from './AgentReplyImage'

/**
 * 助手回复用的 Markdown 渲染。模型习惯用列表、加粗、代码回答，原样显示星号与短横
 * 读起来像乱码。样式手写而不引 typography 插件：颜色跟随语义 token、字号以 xs 为主。
 */
const BLOCK = 'my-2 first:mt-0 last:mb-0'
const LIST =
  'my-2 flex list-outside flex-col gap-1 pl-5 first:mt-0 last:mb-0 marker:text-muted-foreground'
const HEADING = 'mb-1 mt-4 font-medium text-foreground first:mt-0'

const components: ComponentProps<typeof Markdown>['components'] = {
  p: ({ node: _node, ...props }) => <p className={BLOCK} {...props} />,
  ul: ({ node: _node, ...props }) => <ul className={`${LIST} list-disc`} {...props} />,
  ol: ({ node: _node, ...props }) => <ol className={`${LIST} list-decimal`} {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
  strong: ({ node: _node, ...props }) => (
    <strong className="font-medium text-foreground" {...props} />
  ),
  h1: ({ node: _node, ...props }) => <h2 className={HEADING} {...props} />,
  h2: ({ node: _node, ...props }) => <h3 className={HEADING} {...props} />,
  h3: ({ node: _node, ...props }) => <h4 className={HEADING} {...props} />,
  a: ({ node: _node, ...props }) => (
    <a
      className="text-primary underline decoration-primary/40 hover:text-primary"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) =>
    className ? (
      <code className={`${className} font-mono text-label-sm`} {...props} />
    ) : (
      <code className="rounded bg-muted px-1 py-px font-mono text-label-sm" {...props} />
    ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className={`${BLOCK} overflow-x-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-label-sm leading-relaxed`}
      {...props}
    />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className={`${BLOCK} border-l-2 border-border pl-2 text-foreground`} {...props} />
  ),
  // 模型偶尔用 Markdown 插图：只认本会话的图片，其余只留说明，不出裂图也不请求外链。
  img: ({ node: _node, src, alt }) => (
    <AgentReplyImage src={typeof src === 'string' ? src : undefined} alt={alt} />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-2 border-border" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className={`${BLOCK} overflow-x-auto`}>
      <table className="border-collapse text-label-sm" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border border-border px-1.5 py-0.5 text-left font-semibold" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border border-border px-1.5 py-0.5" {...props} />
  ),
}

// 默认净化会清空 `aip-media:`；图片引用要靠它对上会话里的图，其余地址照常净化。
const urlTransform: ComponentProps<typeof Markdown>['urlTransform'] = (url, key) =>
  key === 'src' && /^aip-media:[0-9a-f-]{36}$/i.test(url) ? url : defaultUrlTransform(url)

export default function AgentMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
      {text}
    </Markdown>
  )
}
