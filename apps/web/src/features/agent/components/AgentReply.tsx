import { REPLY } from '../agentStyles'
import AgentMarkdown from './AgentMarkdown'

interface Props {
  text: string
  streaming: boolean
}

/** 助手回复整段展示、按 Markdown 渲染；对话面板不折叠回复，折叠只会让人多点一下。 */
export default function AgentReply({ text, streaming }: Props) {
  return (
    <div className={`${REPLY} break-words`} data-streaming={streaming || undefined}>
      <AgentMarkdown text={text} />
    </div>
  )
}
