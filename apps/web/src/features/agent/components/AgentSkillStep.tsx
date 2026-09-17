import { useTranslation } from '../../../i18n'
import { INK_3 } from '../agentStyles'
import type { AgentToolMessage } from '../types'

/**
 * 读取技能在面板上只是一行脚注：它不生成任何东西，也不落画布，出一张结果卡会让用户
 * 以为刚才那一步产出了什么。
 *
 * 没读到的那次不能显示成读到了。判据是结果里的 `skill.found`——机器可读的一位，
 * 不去匹配工具返回的那段文案。还没跑完时没有这一位，先照起跑标题显示。
 */
export default function AgentSkillStep({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const outcome = message.skill
  const text =
    outcome && !outcome.found ? t('tool.skillNotFound', { name: outcome.label }) : message.title
  return (
    <p className={`text-[11px] leading-relaxed ${INK_3}`} data-tool="loadSkill">
      {text}
    </p>
  )
}
