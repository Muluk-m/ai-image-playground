import agent from './agent.json'
import auth from './auth.json'
import canvas from './canvas.json'
import common from './common.json'
import composer from './composer.json'
import errors from './errors.json'
import inspiration from './inspiration.json'
import lib from './lib.json'
import library from './library.json'
import productShots from './productShots.json'
import settings from './settings.json'
import shell from './shell.json'
import store from './store.json'
import task from './task.json'
import video from './video.json'

/**
 * 一个 locale 一个聚合入口：中文这份被 index.ts 静态 import（既是默认语言也是 fallback，
 * 必须随首屏一起到），英文那份只在切到英文时动态 import，Vite 会单独切出一个 chunk。
 */
export const zhCN = {
  common,
  auth,
  errors,
  task,
  settings,
  composer,
  shell,
  store,
  lib,
  productShots,
  video,
  library,
  canvas,
  agent,
  inspiration,
}

export default zhCN
