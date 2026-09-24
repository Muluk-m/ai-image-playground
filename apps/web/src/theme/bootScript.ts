/**
 * 首帧主题脚本。它被内联进 index.html 的 head，在样式表与应用脚本之前同步执行，
 * 否则固定了暗色的人每次刷新都会先看到一帧亮色。
 *
 * 它排在 head 最前面，那一刻 head 里还什么都没有，所以 theme-color 这个 meta 由它自己建，
 * index.html 里不再写死一个。
 *
 * 这个文件会被 vite.config.ts 直接 import，所以不能依赖 DOM 类型之外的任何应用代码。
 * 解析规则与 `resolveTheme` 是同一条，各写一遍是因为这里只能是一段自包含的 ES5 字符串；
 * 两者的一致性由 theme.test.ts 逐格比对。
 */
export const THEME_STORAGE_KEY = 'aip.theme'

/** 浏览器地址栏与系统状态栏的颜色，对应两套主题的 `--background` 与既有的暗色值。 */
export const THEME_COLORS = { light: '#f8f8f7', dark: '#23282b' } as const

export const THEME_BOOT_SCRIPT = `(function(){try{var s=null;try{s=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}var d=s!=='light';document.documentElement.classList.toggle('dark',d);var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement('meta');m.name='theme-color';document.head.appendChild(m)}m.setAttribute('content',d?${JSON.stringify(
  THEME_COLORS.dark,
)}:${JSON.stringify(THEME_COLORS.light)})}catch(e){}})()`
