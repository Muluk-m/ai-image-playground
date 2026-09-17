import { INK_3 } from '../agentStyles'
import type { AgentToolMessage } from '../types'

/**
 * 读取技能在面板上只是一行脚注：它不生成任何东西，也不落画布，出一张结果卡会让用户
 * 以为刚才那一步产出了什么。标题由服务端写好（`读取技能：<name>`），这里只负责排版。
 */
export default function AgentSkillStep({ message }: { message: AgentToolMessage }) {
  return (
    <p className={`text-[11px] leading-relaxed ${INK_3}`} data-tool="loadSkill">
      {message.title}
    </p>
  )
}
