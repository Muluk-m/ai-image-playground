const registered = new Set<() => void>()
let installed = false

function flushAll() {
  // 一个冲不下去不该把后面的也一起丢了；各自的失败各自在登记方那边记。
  for (const flush of [...registered])
    try {
      flush()
    } catch {}
}

/**
 * 页面要被藏起来或关掉时，把登记过的东西冲一遍；返回值注销这一笔。
 * 冲盘的时机归这里，冲什么由登记方自己说了算。
 */
export function flushOnPageHide(flush: () => void): () => void {
  if (!installed) {
    installed = true
    window.addEventListener('pagehide', flushAll)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll()
    })
  }
  registered.add(flush)
  return () => {
    registered.delete(flush)
  }
}
