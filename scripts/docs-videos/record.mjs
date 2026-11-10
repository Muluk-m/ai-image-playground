/**
 * 在测试站按 docs/plans/docs-site-rewrite/video-shot-list.md 录使用指南演示。
 *
 * 只允许 https://test.muvloom.online。凭据从环境变量读取，不写进仓库、不打印：
 *   DOCS_VIDEO_EMAIL  DOCS_VIDEO_PASSWORD
 *
 * 依赖本机 Playwright（不进 lockfile）：
 *   npm install --prefix /tmp/pw --no-package-lock --no-save playwright@1.58.2
 *   PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright node scripts/docs-videos/record.mjs 01
 *
 * 原始文件落在 scripts/docs-videos/raw/（gitignore）。1080p 母带再用 finish.py 剪成片，不要用 encode.mjs。
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { chromium } = playwright

const BASE = process.env.DOCS_VIDEO_BASE || 'https://test.muvloom.online'
if (new URL(BASE).hostname !== 'test.muvloom.online') {
  throw new Error('refusing to record against a non-test origin')
}
const email = process.env.DOCS_VIDEO_EMAIL
const password = process.env.DOCS_VIDEO_PASSWORD
if (!email || !password) throw new Error('DOCS_VIDEO_EMAIL and DOCS_VIDEO_PASSWORD are required')

const rawDir = resolve(root, 'scripts/docs-videos/raw')
const hdDir = resolve(rawDir, 'hd')
mkdirSync(hdDir, { recursive: true })
/** 1080p 逐帧采集。Playwright 自带录像锁在约 1 Mbps，界面文字会糊。 */
const HD = process.env.DOCS_VIDEO_HD !== '0'
const VIEW_W = HD ? 1920 : 1280
const VIEW_H = HD ? 1080 : 800
const mug1 = resolve(root, 'docs/plans/docs-site-rewrite/mug-1.png')
const mug2 = resolve(root, 'docs/plans/docs-site-rewrite/mug-2.png')

const CURSOR = `(() => {
  const id = 'docs-record-cursor'
  const paint = () => {
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.textContent = '#' + id + '{position:fixed;z-index:2147483647;width:18px;height:18px;margin-left:-2px;margin-top:-2px;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.55));}'
    const node = document.createElement('div')
    node.id = id
    node.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.5 L2 14.5 L5.6 11.2 L8.1 16.2 L10.2 15.2 L7.6 10.2 L12.6 10.2 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>'
    document.documentElement.append(style, node)
  }
  document.addEventListener('mousemove', (event) => {
    paint()
    const node = document.getElementById(id)
    if (!node) return
    node.style.left = event.clientX + 'px'
    node.style.top = event.clientY + 'px'
  }, true)
})()`

const sleep = (page, ms) => page.waitForTimeout(ms)

async function point(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 20000 })
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('missing box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps: 18 })
  await sleep(page, 420)
  return { x, y }
}

async function click(page, locator) {
  const { x, y } = await point(page, locator)
  await page.mouse.click(x, y, { delay: 60 })
  await sleep(page, 500)
}

async function typeInto(page, locator, text) {
  await click(page, locator)
  await locator.fill('')
  await locator.pressSequentially(text, { delay: 58 })
  await sleep(page, 400)
}

async function login(page) {
  await page.goto(`${BASE}/login/`, { waitUntil: 'domcontentloaded' })
  await sleep(page, 1200)
  await page.getByLabel('邮箱地址').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await click(page, page.getByRole('button', { name: '登录', exact: true }))
  await page.waitForURL(/\/image/, { timeout: 30000 })
  await page.getByRole('button', { name: /积分/ }).first().waitFor({ timeout: 20000 })
}

async function goImage(page) {
  await page.goto(`${BASE}/image`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('combobox', { name: '选择创作方式' }).waitFor({ timeout: 20000 })
  await sleep(page, 900)
}

async function pickTarget(page, name) {
  const trigger = page.getByRole('combobox', { name: '选择创作方式' })
  const current = ((await trigger.innerText()) || '').replace(/\s+/g, '')
  if (current.includes(name)) return
  await click(page, trigger)
  const option = page.getByRole('option', { name })
  await option.waitFor({ state: 'visible', timeout: 8000 })
  await click(page, option)
}

async function modelTrigger(page) {
  return page.getByRole('combobox', { name: /模型/ }).first()
}

async function pickModel(page, name) {
  const current = await modelTrigger(page)
  const label = `${(await current.getAttribute('aria-label')) || ''} ${await current.innerText()}`
  if (label.includes(name)) return
  await click(page, current)
  const option = page.getByRole('option', { name }).first()
  await option.waitFor({ timeout: 10000 })
  await click(page, option)
}

async function modelExists(page, name) {
  await click(page, await modelTrigger(page))
  const option = page.getByRole('option', { name }).first()
  const ok = await option.isVisible().catch(() => false)
  await page.keyboard.press('Escape')
  await sleep(page, 300)
  return ok
}

async function openSettings(page) {
  await click(page, page.getByRole('button', { name: /生成设置/ }).first())
  await page.getByRole('button', { name: '完成' }).waitFor({ timeout: 10000 })
  await sleep(page, 400)
}

async function choose(page, group, name) {
  const button = page.getByRole('group', { name: group }).getByRole('button', { name, exact: true })
  await click(page, button)
}

async function finishSettings(page) {
  await click(page, page.getByRole('button', { name: '完成', exact: true }))
}

function promptBox(page) {
  return page.getByRole('textbox', { name: '描述你的创意' })
}

async function taskSnapshot(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-task-id]')].map((card) => ({
      id: card.getAttribute('data-task-id') || '',
      text: card.innerText.replace(/\s+/g, ' ').slice(0, 240),
      images: card.querySelectorAll('img').length,
    }))
    return { cards }
  })
}

async function waitResult(page, before, timeout) {
  const known = new Set(before.cards.map((card) => card.id))
  const start = Date.now()
  let fresh = []
  while (Date.now() - start < timeout) {
    const snap = await taskSnapshot(page)
    fresh = snap.cards.filter((card) => card.id && !known.has(card.id))
    const failed = fresh.find((card) => /未能完成|生成服务异常|积分不足|积分不够|失败/.test(card.text))
    if (failed && !/生成中|排队/.test(failed.text)) {
      return { ok: false, note: failed.text.slice(0, 180) }
    }
    const done = fresh.find((card) => card.images > 0 && /完成|gif|svg|Image/.test(card.text) && !/生成中|排队|失败|未能完成/.test(card.text))
    if (done) {
      await sleep(page, 2200)
      return { ok: true, note: done.text.slice(0, 160) }
    }
    await sleep(page, 1000)
  }
  return { ok: false, note: `timeout fresh=${fresh.map((card) => card.text).join(' | ').slice(0, 180)}` }
}

async function submit(page) {
  const button = page.getByRole('button', { name: /^(生成|开始创作)/ }).last()
  await click(page, button)
}

async function promptText(page) {
  return page.getByRole('textbox', { name: '描述你的创意' }).innerText()
}

async function uploadReference(page, files) {
  const chooser = page.waitForEvent('filechooser', { timeout: 10000 })
  await click(page, page.getByRole('button', { name: '添加参考素材' }))
  const item = page.getByRole('menuitem', { name: '添加图片' }).or(page.getByText('添加图片', { exact: true })).first()
  await item.waitFor({ timeout: 8000 })
  await click(page, item)
  await (await chooser).setFiles(files)
  await sleep(page, 1200)
}

function watchTraffic(page) {
  const rows = []
  const logs = []
  page.on('response', (response) => {
    const url = response.url()
    const method = response.request().method()
    if (!/\/api\/|muvloom\.online/.test(url)) return
    if (method === 'GET' && !/media|job|task|queue|submit|generat/i.test(url)) return
    const path = url.split('?')[0].slice(0, 180)
    if (/\/content$/.test(path) || response.headers()['content-type']?.includes('video')) {
      rows.push({ status: response.status(), method, url: path, body: '' })
      return
    }
    response
      .text()
      .then((text) => {
        const body = text
          .replace(/"(token|access_token|refresh_token|password|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"…"')
          .slice(0, 360)
        rows.push({ status: response.status(), method, url: path, body })
      })
      .catch(() => {
        rows.push({ status: response.status(), method, url: path, body: '' })
      })
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`${msg.type()}: ${msg.text().slice(0, 300)}`)
  })
  page.on('pageerror', (error) => logs.push(`pageerror: ${String(error.message || error).slice(0, 300)}`))
  return { rows, logs }
}

const shots = {
  async '01'(page) {
    await goImage(page)
    await pickTarget(page, '图片生成')
    await pickModel(page, 'Image 2.5 Flare')
    await openSettings(page)
    await choose(page, '比例', '3:4')
    await choose(page, '质量', '中')
    await finishSettings(page)
    await typeInto(page, promptBox(page), '一杯冷萃咖啡放在浅色石台上，冰块透亮，午后自然光，商业摄影，3:4 竖构图')
    const before = await taskSnapshot(page)
    await submit(page)
    return waitResult(page, before, 120000)
  },
  async '02'(page) {
    await goImage(page)
    await pickTarget(page, '图片生成')
    await pickModel(page, 'Image 2.5 Flare')
    await uploadReference(page, mug1)
    await typeInto(page, promptBox(page), '@')
    const mention = page.getByRole('option', { name: /图1/ }).or(page.getByText('@图1', { exact: true })).first()
    if (await mention.isVisible().catch(() => false)) await click(page, mention)
    await promptBox(page).pressSequentially(' 的杯子放在干净的浅色石台上，柔和棚拍光，保留杯身纹理与比例，3:4', { delay: 48 })
    const before = await taskSnapshot(page)
    await submit(page)
    return waitResult(page, before, 120000)
  },
  async '03'(page) {
    await goImage(page)
    await pickTarget(page, '图片生成')
    await pickModel(page, 'Image 2.5 Flare')
    await openSettings(page)
    await choose(page, '比例', '3:4')
    await choose(page, '数量', '2')
    await choose(page, '质量', '中')
    await finishSettings(page)
    await typeInto(page, promptBox(page), '极简玫瑰精华液电商主图，透明玻璃瓶居中，柔和棚拍光，粉色与玫瑰金，标题文字“GLOW SERUM”')
    const before = await taskSnapshot(page)
    await submit(page)
    const result = await waitResult(page, before, 150000)
    await sleep(page, 2500)
    return result
  },
  async '04'(page) {
    await goImage(page)
    if (!(await modelExists(page, 'Image 2.6 Flare'))) return { ok: false, skip: true, note: 'Image 2.6 Flare 不在模型列表' }
    await pickModel(page, 'Image 2.6 Flare')
    await openSettings(page)
    await click(page, page.getByRole('button', { name: /动图 GIF/ }))
    await choose(page, '帧数', '6')
    await choose(page, '每帧时长', '0.2 秒')
    await choose(page, '尺寸', '768')
    await finishSettings(page)
    await typeInto(page, promptBox(page), '一只橘色小猫对着镜头挥手，循环动作，简洁白色背景，贴纸风格')
    const before = await taskSnapshot(page)
    await submit(page)
    const result = await waitResult(page, before, 150000)
    await sleep(page, 3000)
    return result
  },
  async '05'(page) {
    await goImage(page)
    if (!(await modelExists(page, 'Image 2.6 Flare'))) return { ok: false, skip: true, note: 'Image 2.6 Flare 不在模型列表' }
    await pickModel(page, 'Image 2.6 Flare')
    await openSettings(page)
    await click(page, page.getByRole('button', { name: /矢量 SVG/ }))
    await finishSettings(page)
    await typeInto(page, promptBox(page), '扁平矢量图标，一只简笔画小猫坐在咖啡杯旁，两色描边，干净背景，适合做 logo')
    const before = await taskSnapshot(page)
    await submit(page)
    return waitResult(page, before, 150000)
  },
  async '06'(page) {
    await goImage(page)
    await pickTarget(page, '图片生成')
    await pickModel(page, 'Image 2.5 Flare')
    await uploadReference(page, [mug1, mug2])
    const each = page.getByRole('group', { name: '参考图用法' }).getByRole('button', { name: '逐张生成' })
    await each.waitFor({ timeout: 15000 })
    await click(page, each)
    await typeInto(page, promptBox(page), '保留当前图片中商品的外形、颜色、材质和标识，将背景替换为纯白色。商品居中、完整可见，添加自然接触阴影，不添加文字或其他物体。')
    const before = await taskSnapshot(page)
    const send = page.getByRole('button', { name: /逐张生成/ }).last()
    await click(page, send)
    const result = await waitResult(page, before, 180000)
    const expand = page.getByRole('button', { name: /展开/ }).first()
    if (await expand.isVisible().catch(() => false)) await click(page, expand)
    await sleep(page, 1500)
    return result
  },
  async '07'(page) {
    await goImage(page)
    await pickTarget(page, '智能创作')
    await typeInto(page, promptBox(page), '为这款虚构的柑橘香水做 2 张小红书封面，风格清爽，不要出现真实品牌名')
    const before = await taskSnapshot(page)
    await submit(page)
    const known = new Set(before.cards.map((card) => card.id))
    const start = Date.now()
    while (Date.now() - start < 90000) {
      const snap = await taskSnapshot(page)
      const fresh = snap.cards.filter((card) => !known.has(card.id))
      const plan = page.getByRole('heading', { name: '生成计划' })
      if (fresh.length > 0 || (await plan.isVisible().catch(() => false))) {
        await sleep(page, 4000)
        return { ok: true, note: fresh.length ? fresh[0].text.slice(0, 120) : 'plan visible' }
      }
      const body = await page.locator('body').innerText()
      if (/积分不够|积分不足/.test(body)) return { ok: false, note: '积分不足' }
      await sleep(page, 1000)
    }
    return { ok: false, note: 'agent timeout' }
  },
  async '08'(page) {
    const trace = watchTraffic(page)
    await goImage(page)
    await pickTarget(page, '视频生成')
    await sleep(page, 800)
    const model = page.getByRole('combobox', { name: /模型/ }).first()
    const modelName = ((await model.getAttribute('aria-label').catch(() => '')) || (await model.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 80)
    const settings = page.getByRole('button', { name: /视频设置/ }).first()
    if (await settings.isVisible().catch(() => false)) {
      await click(page, settings)
      const five = page.getByRole('group', { name: '时长' }).getByRole('button', { name: '5 秒' })
      if (await five.isVisible().catch(() => false)) await click(page, five)
      const ratio = page.getByRole('group', { name: '比例' }).getByRole('button', { name: '16:9' })
      if (await ratio.isVisible().catch(() => false)) await click(page, ratio)
      const res = page.getByRole('button', { name: /^720p/ }).first()
      if (await res.isVisible().catch(() => false)) await click(page, res)
      const done = page.getByRole('button', { name: '完成', exact: true })
      if (await done.isVisible().catch(() => false)) await click(page, done)
    }
    const box = page.getByRole('textbox', { name: /描述/ }).first()
    await typeInto(page, box, '冰块在玻璃杯里轻轻晃动，镜头缓慢推近')
    await submit(page)
    await page.waitForURL(/\/p\//, { timeout: 30000 }).catch(() => {})
    await sleep(page, 1500)
    const chat = page.getByRole('button', { name: '与 AI 对话' })
    if (await chat.isVisible().catch(() => false)) {
      await click(page, chat)
      await sleep(page, 2000)
    }
    // 首页这条会先交给智能体。智能体若不出视频节点，再在画布上加一个视频节点直接提交。
    if ((await page.locator('video').count()) === 0) {
      await page.mouse.dblclick(1100, 520)
      await sleep(page, 700)
      const addVideo = page.locator('.studio-node-menu').getByText('视频', { exact: true })
      if (await addVideo.isVisible().catch(() => false)) {
        await click(page, addVideo)
        await sleep(page, 800)
        const nodeBox = page.getByRole('textbox', { name: /描述画面/ }).first()
        if (await nodeBox.isVisible().catch(() => false)) {
          await typeInto(page, nodeBox, '冰块在玻璃杯里轻轻晃动，镜头缓慢推近')
          const mode = page.getByRole('combobox', { name: '生成方式' })
          if (await mode.isVisible().catch(() => false)) {
            await click(page, mode)
            const textMode = page.getByRole('option', { name: '文生视频' })
            if (await textMode.isVisible().catch(() => false)) await click(page, textMode)
          }
          const settings = page.getByRole('button', { name: /视频设置/ }).last()
          if (await settings.isVisible().catch(() => false)) {
            await click(page, settings)
            const five = page.getByRole('group', { name: '时长' }).getByRole('button', { name: '5 秒' })
            if (await five.isVisible().catch(() => false)) await click(page, five)
            const ratio = page.getByRole('group', { name: '比例' }).getByRole('button', { name: '16:9' })
            if (await ratio.isVisible().catch(() => false)) await click(page, ratio)
            const res = page.getByRole('button', { name: /^720p/ }).first()
            if (await res.isVisible().catch(() => false)) await click(page, res)
            const done = page.getByRole('button', { name: '完成', exact: true })
            if (await done.isVisible().catch(() => false)) await click(page, done)
          }
          await click(page, page.getByRole('button', { name: '生成', exact: true }).last())
        }
      }
    }
    const start = Date.now()
    let taskId = ''
    let errorText = ''
    while (Date.now() - start < 240000) {
      const state = await page.evaluate(() => {
        const videos = [...document.querySelectorAll('video')]
        const live = videos.find((node) => node.videoWidth > 0 && node.readyState >= 2)
        const task = document.querySelector('[data-task-id]')
        const body = document.body.innerText.replace(/\s+/g, ' ')
        const fail = body.match(/未能完成|生成服务异常|生成失败|积分不足|积分不够|暂时没有可用的视频模型|不支持视频生成/)
        return {
          playing: Boolean(live && !live.paused && live.currentTime > 0.2),
          ready: Boolean(live),
          current: live ? Number(live.currentTime.toFixed(2)) : 0,
          taskId: task?.getAttribute('data-task-id') || '',
          fail: fail ? fail[0] : '',
          body: body.slice(0, 500),
        }
      })
      if (state.taskId) taskId = state.taskId
      const fromNet = trace.rows.find((row) => /"id"\s*:/.test(row.body) && /task|job|video/i.test(row.url + row.body))
      if (!taskId && fromNet) {
        const match = fromNet.body.match(/"id"\s*:\s*"([^"]+)"/)
        if (match) taskId = match[1]
      }
      if (state.playing) {
        await sleep(page, 4000)
        writeFileSync(resolve(rawDir, '08-trace.json'), JSON.stringify({ ok: true, taskId, modelName, rows: trace.rows.slice(-30) }, null, 2))
        return { ok: true, note: `played task=${taskId || 'unknown'} model=${modelName}` }
      }
      if (state.ready && !state.playing) {
        const play = page.getByRole('button', { name: '播放' }).first()
        if (await play.isVisible().catch(() => false)) await click(page, play)
        else {
          await page.evaluate(() => {
            const node = [...document.querySelectorAll('video')].find((video) => video.videoWidth > 0)
            if (node) node.play().catch(() => {})
          })
        }
      }
      if (state.fail && !/生成中|排队|上传中/.test(state.body)) {
        errorText = state.fail
        if (Date.now() - start > 12000) {
          writeFileSync(resolve(rawDir, '08-trace.json'), JSON.stringify({ ok: false, taskId, errorText, body: state.body, rows: trace.rows.slice(-40), console: trace.logs.slice(-20) }, null, 2))
          return { ok: false, note: `error=${errorText} task=${taskId || 'none'} ${state.body.slice(0, 220)}` }
        }
      }
      await sleep(page, 1000)
    }
    const body = await page.locator('body').innerText().catch(() => '')
    writeFileSync(resolve(rawDir, '08-trace.json'), JSON.stringify({ ok: false, taskId, errorText, body: body.replace(/\s+/g, ' ').slice(0, 500), rows: trace.rows.slice(-40), console: trace.logs.slice(-20) }, null, 2))
    return { ok: false, note: `timeout task=${taskId || 'none'} error=${errorText || 'none'} ${body.replace(/\s+/g, ' ').slice(0, 180)}` }
  },
  async '09'(page) {
    const trace = watchTraffic(page)
    await goImage(page)
    if (process.env.DOCS_VIDEO_HOLD === '1') {
      const project = page.getByText('一只陶瓷咖啡杯放在木', { exact: false }).first()
      await click(page, project)
      await page.waitForURL(/\/p\//, { timeout: 20000 })
      await page.getByText('1086', { exact: false }).first().waitFor({ timeout: 20000 })
      const mug = await page.evaluate(() => {
        const img = [...document.querySelectorAll('img')].find((node) => node.naturalWidth >= 700)
        if (!img) return null
        const rect = img.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })
      if (mug) await page.mouse.move(mug.x, mug.y, { steps: 20 })
      await sleep(page, 5000)
      return { ok: true, note: 'result hold' }
    }
    const project = page.getByText('一只陶瓷咖啡杯放在木', { exact: false }).first()
    if (!(await project.isVisible().catch(() => false))) {
      return { ok: false, note: '没有已上传的咖啡杯项目，未再生成新图' }
    }
    await click(page, project)
    await page.waitForURL(/\/p\//, { timeout: 20000 })
    await sleep(page, 1500)
    const imageBox = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((img) => img.naturalWidth >= 700)
      const big = imgs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
      if (!big) return null
      const rect = big.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    if (!imageBox) return { ok: false, note: '画布上没有已解码的杯子图' }
    await page.mouse.move(imageBox.x + imageBox.width * 0.55, imageBox.y + 48, { steps: 12 })
    await sleep(page, 300)
    await page.mouse.click(imageBox.x + imageBox.width * 0.55, imageBox.y + 48)
    await sleep(page, 800)
    const edit = page.getByRole('button', { name: '编辑图片' })
    if (!(await edit.isVisible().catch(() => false))) {
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
      const uploads = trace.rows.filter((row) => /\/api\/media\/uploads|\/complete/.test(row.url))
      writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ stuck: /图片上传中/.test(text), uploads, body: text.slice(0, 400), console: trace.logs.slice(-20) }, null, 2))
      return { ok: false, note: /图片上传中/.test(text) ? '仍显示图片上传中，编辑图片未出现' : '选中图片后没有编辑图片按钮' }
    }
    await click(page, edit)
    const local = page.getByRole('button', { name: '局部重绘', exact: true })
    await local.waitFor({ timeout: 15000 })
    await click(page, local)
    await sleep(page, 600)
    const alert = page.getByRole('alert')
    if (await alert.isVisible().catch(() => false)) {
      const reason = (await alert.innerText()).replace(/\s+/g, ' ')
      writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ ok: false, reason, rows: trace.rows.slice(-20), console: trace.logs.slice(-20) }, null, 2))
      return { ok: false, note: `局部重绘不可用：${reason}` }
    }
    const rectTool = page.getByRole('button', { name: '框选', exact: true })
    await click(page, rectTool)
    const stage = page.locator('canvas').last()
    const box = await stage.boundingBox()
    if (!box) return { ok: false, note: '局部重绘画布没有出现' }
    await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.34, { steps: 10 })
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.72, { steps: 16 })
    await page.mouse.up()
    await sleep(page, 500)
    await typeInto(page, page.getByRole('textbox', { name: '描述希望修改的内容…' }), '把杯身釉色换成雾面墨绿，杯把保持原样')
    const send = page.getByRole('button', { name: '生成新候选' })
    if (await send.isDisabled()) {
      const reason = await page.getByRole('alert').innerText().catch(() => '')
      writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ ok: false, reason, rows: trace.rows.slice(-20), console: trace.logs.slice(-20) }, null, 2))
      return { ok: false, note: `生成新候选仍禁用。${reason.replace(/\s+/g, ' ')}` }
    }
    await click(page, send)
    const sent = Date.now()
    while (Date.now() - sent < 90000) {
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
      if (/生成失败|积分不足|积分不够|未能完成|生成服务异常|当前模型不支持/.test(text) && Date.now() - sent > 3000) {
        const errorText = text.match(/生成失败|积分不足|积分不够|未能完成|生成服务异常|当前模型不支持遮罩重绘，请切到 GPT Image 系列/)?.[0] || ''
        writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ ok: false, errorText, body: text.slice(0, 500), rows: trace.rows.slice(-30), console: trace.logs.slice(-20) }, null, 2))
        return { ok: false, note: `局部重绘已提交后失败：${errorText}` }
      }
      if (!(await local.isVisible().catch(() => false)) && Date.now() - sent > 4000) {
        const closed = Date.now()
        while (Date.now() - closed < 90000) {
          const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
          if (/生成失败|积分不足|积分不够|未能完成|生成服务异常/.test(after)) {
            const errorText = after.match(/生成失败|积分不足|积分不够|未能完成|生成服务异常/)?.[0] || ''
            writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ ok: false, errorText, body: after.slice(0, 500), rows: trace.rows.slice(-30), console: trace.logs.slice(-20) }, null, 2))
            return { ok: false, note: `局部重绘任务失败：${errorText}` }
          }
          const images = await page.evaluate(() => [...document.querySelectorAll('img')].filter((img) => img.naturalWidth >= 700).length)
          if (images >= 2) {
            await sleep(page, 2500)
            writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ ok: true, rows: trace.rows.slice(-30), console: trace.logs.slice(-20) }, null, 2))
            return { ok: true, note: '局部重绘结果已出现' }
          }
          await sleep(page, 1000)
        }
        writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ ok: false, rows: trace.rows.slice(-30), console: trace.logs.slice(-20) }, null, 2))
        return { ok: false, note: '编辑器已关闭，90 秒内没有第二张结果图' }
      }
      await sleep(page, 1000)
    }
    writeFileSync(resolve(rawDir, '09-trace.json'), JSON.stringify({ ok: false, rows: trace.rows.slice(-30), console: trace.logs.slice(-20) }, null, 2))
    return { ok: false, note: '局部重绘提交后 90 秒编辑器仍未关闭' }
  },
  async '10'(page) {
    await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' })
    await sleep(page, 4000)
    const empty = page.getByText('没有符合条件的灵感')
    if (await empty.isVisible().catch(() => false)) return { ok: false, skip: true, note: '测试环境灵感库为空' }
    const card = page.getByTestId('inspiration-card').first()
    if (!(await card.isVisible().catch(() => false))) return { ok: false, skip: true, note: '探索页没有案例卡片' }
    await point(page, card)
    await sleep(page, 2500)
    const apply = card.getByRole('button', { name: /做同款/ })
    await click(page, apply)
    const replace = page.getByRole('button', { name: '替换并应用' })
    if (await replace.isVisible().catch(() => false)) await click(page, replace)
    await page.waitForURL(/\/image/, { timeout: 20000 })
    await promptBox(page).waitFor({ timeout: 15000 })
    const value = await promptText(page)
    await sleep(page, 14000)
    if (!value.trim()) return { ok: false, note: '做同款后输入框仍为空' }
    return { ok: true, note: 'remix applied' }
  },
  async '11'(page) {
    await page.goto(`${BASE}/tools`, { waitUntil: 'domcontentloaded' })
    await sleep(page, 3500)
    await click(page, page.getByRole('link', { name: '裁剪' }).or(page.getByRole('button', { name: '裁剪' })).first())
    await page.waitForURL(/\/tools\/crop/, { timeout: 15000 }).catch(() => {})
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 })
    await click(page, page.getByRole('button', { name: '添加图片' }).first())
    await (await chooser).setFiles(mug1)
    await sleep(page, 2500)
    await click(page, page.getByRole('button', { name: /小红书 1242×1660/ }).or(page.getByText('小红书 1242×1660')).first())
    await sleep(page, 5000)
    await point(page, page.getByRole('button', { name: '下载' }).last())
    await sleep(page, 12000)
    const text = await page.locator('body').innerText()
    if (!/1242/.test(text) && !/1660/.test(text)) return { ok: false, note: '裁剪尺寸未显示' }
    return { ok: true, note: 'crop preset applied' }
  },
}

const wanted = process.argv.slice(2)
const ids = wanted.length ? wanted : Object.keys(shots)
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-dev-shm-usage', '--window-size=1920,1080'],
})
const boot = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
const bootPage = await boot.newPage()
await login(bootPage)
await boot.storageState({ path: resolve(rawDir, 'storage.json') })
await boot.close()

/**
 * 把 Chrome 的高画质截帧收成 30fps H.264。静态画面浏览器会停发帧，这里按墙钟补帧。
 * 母带用 CRF 16，成片再另压，避免从已经压过的文件二次压缩。
 */
async function attachCapture(page, dest) {
  const client = await page.context().newCDPSession(page)
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      '30',
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-an',
      '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '16',
      '-preset',
      'veryfast',
      '-movflags',
      '+faststart',
      dest,
    ],
    { stdio: ['pipe', 'ignore', 'inherit'] },
  )
  ffmpeg.stdin.on('error', () => {})
  const fps = 30
  const step = 1000 / fps
  let nextDue = 0
  let last = null
  let closed = false
  let exitCode = null
  const closedPromise = new Promise((resolveClose) => {
    ffmpeg.on('error', () => {
      exitCode = 1
      resolveClose()
    })
    ffmpeg.on('close', (code) => {
      exitCode = code ?? 1
      resolveClose()
    })
  })
  client.on('Page.screencastFrame', (evt) => {
    if (closed || exitCode !== null) return
    const frame = Buffer.from(evt.data, 'base64')
    // 先应答，避免补帧堵住事件循环时 Chrome 停发下一帧。
    client.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => {})
    const now = Date.now()
    if (!nextDue) nextDue = now
    // 错过的槽位用上一帧补，新画面只写当前槽，避免把变化提前到缺口开头。
    while (last && nextDue <= now - step) {
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.write(last)
      nextDue += step
    }
    last = frame
    if (nextDue <= now + 1 && !ffmpeg.stdin.destroyed) {
      ffmpeg.stdin.write(frame)
      nextDue += step
    }
  })
  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: VIEW_W,
    maxHeight: VIEW_H,
    everyNthFrame: 1,
  })
  return async () => {
    closed = true
    await client.send('Page.stopScreencast').catch(() => {})
    const now = Date.now()
    while (last && nextDue <= now && exitCode === null && !ffmpeg.stdin.destroyed) {
      ffmpeg.stdin.write(last)
      nextDue += step
    }
    if (exitCode === null && !ffmpeg.stdin.destroyed) ffmpeg.stdin.end()
    await closedPromise
    if (exitCode !== 0) throw new Error(`ffmpeg exited ${exitCode}`)
  }
}

const report = []
for (const id of ids) {
  const fn = shots[id]
  if (!fn) throw new Error(`unknown shot ${id}`)
  const context = await browser.newContext({
    storageState: resolve(rawDir, 'storage.json'),
    viewport: { width: VIEW_W, height: VIEW_H },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    ...(HD ? {} : { recordVideo: { dir: rawDir, size: { width: VIEW_W, height: VIEW_H } } }),
  })
  await context.addInitScript(CURSOR)
  const page = await context.newPage()
  page.setDefaultTimeout(25000)
  const dest = resolve(HD ? hdDir : rawDir, HD ? `${id}.mp4` : `${id}.webm`)
  const stopCapture = HD ? await attachCapture(page, dest) : null
  let result = { ok: false, note: '' }
  try {
    result = await fn(page)
  } catch (error) {
    const detail = error instanceof Error ? (error.stack || error.message) : 'failed'
    const buttons = await page
      .getByRole('button')
      .evaluateAll((nodes) =>
        nodes
          .slice(0, 25)
          .map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40)),
      )
      .catch(() => [])
    result = {
      ok: false,
      note: `${detail.split('\n').slice(0, 3).join(' | ')} | buttons=${buttons.join(',')}`,
    }
    await page.screenshot({ path: resolve(rawDir, `${id}-error.png`) }).catch(() => {})
  }
  await sleep(page, 800)
  if (stopCapture) await stopCapture()
  const video = page.video()
  await context.close()
  if (!HD && video) {
    const src = await video.path()
    if (src) {
      const { renameSync } = await import('node:fs')
      renameSync(src, dest)
    }
  }
  const row = { id, ok: Boolean(result.ok), skip: Boolean(result.skip), note: result.note || '', file: dest }
  report.push(row)
  console.log(`${id} ok=${row.ok} skip=${row.skip} ${row.note}`)
  writeFileSync(resolve(rawDir, 'report.json'), JSON.stringify(report, null, 2))
}
await browser.close()
