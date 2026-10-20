/** 截断后续写时塞给模型的那一句。用户界面上不单独显示。 */
export const AGENT_LENGTH_CONTINUE_NOTE =
  '上次输出被截断，请从断点继续，不要重写已经写过的部分。若是在写批量计划，先用 planImageBatch 保存已写好的部分，每次不超过 8 项。'

/** 自动续写一次之后仍然截断，给用户看的失败说明。 */
export function agentLengthFailureText(savedItems: number): string {
  if (savedItems > 0) {
    return `这次要生成的内容太多，已保存到第 ${savedItems} 项。可以回复「继续」接着做，或减少张数。`
  }
  return '这次要生成的内容太多，回复没有写完。可以回复「继续」接着做，或减少张数。'
}
