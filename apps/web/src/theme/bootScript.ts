/**
 * 首帧主题脚本。它被内联进 index.html 的 head，在样式表与应用脚本之前同步执行，
 * 否则已经选过亮色或跟随系统的人每次刷新都会先闪一帧默认暗色。
 *
 * 它排在 head 最前面，那一刻 head 里还什么都没有，所以 theme-color 这个 meta 由它自己建，
 * index.html 里不再写死一个。
 *
 * 这个文件会被 vite.config.ts 直接 import，所以不能依赖 DOM 类型之外的任何应用代码。
 * 解析规则与 `resolveTheme` 是同一条，各写一遍是因为这里只能是一段自包含的 ES5 字符串；
 * 两者的一致性由 theme.test.ts 逐格比对。样式表仍然只认 `.dark`，不写
 * `@media (prefers-color-scheme)`；只有保存的选择是 `system` 时才读一次系统明暗。
 */
export const THEME_STORAGE_KEY = 'aip.theme'

/** 浏览器地址栏与系统状态栏的颜色，与两套主题的 `--background` 一致。 */
export const THEME_COLORS = { light: '#f8f8f7', dark: '#111311' } as const

export const THEME_BOOT_SCRIPT = `(function(){try{var s=null;try{s=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}var choice=s==="light"||s==="dark"||s==="system"?s:"dark";var systemDark=true;if(choice==="system"){try{systemDark=window.matchMedia("(prefers-color-scheme: dark)").matches}catch(e){}}var d=choice==="system"?systemDark:choice!=="light";document.documentElement.classList.toggle("dark",d);var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m)}m.setAttribute("content",d?${JSON.stringify(
  THEME_COLORS.dark,
)}:${JSON.stringify(THEME_COLORS.light)})}catch(e){}})()`
