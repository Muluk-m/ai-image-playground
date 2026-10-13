/**
 * 页面级 dragstart 用来拦住图片被拖出工作台。
 * 事件目标在部分浏览器里是文本节点，文本节点没有 closest，直接调用会把整页打崩。
 */
export function dragTargetIsImage(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('img') !== null
}
