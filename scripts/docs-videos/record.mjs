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
 * 原始 webm 落在 scripts/docs-videos/raw/（gitignore）。再用 encode.mjs 压成指南成片。
 */
import { createRequire } from 'node:module'
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
mkdirSync(rawDir, { recursive: true })
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
  await page.getByRole('button', { name: /积分/ }).waitFor({ timeout: 20000 })
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
    await goImage(page)
    await pickTarget(page, '视频生成')
    await sleep(page, 800)
    const model = await modelTrigger(page)
    const modelName = ((await model.getAttribute('aria-label')) || '').replace(/^模型\s*/, '')
    await openSettings(page)
    const five = page.getByRole('group', { name: '时长' }).getByRole('button', { name: '5 秒' })
    if (await five.isVisible().catch(() => false)) await click(page, five)
    const ratio = page.getByRole('group', { name: '比例' }).getByRole('button', { name: '16:9' })
    if (await ratio.isVisible().catch(() => false)) await click(page, ratio)
    const res = page.getByRole('button', { name: '720p' }).first()
    if (await res.isVisible().catch(() => false)) await click(page, res)
    await finishSettings(page)
    await typeInto(page, promptBox(page), '一杯冷萃咖啡放在石台上，冰块轻微融化，午后窗光缓慢扫过杯壁，镜头稍微推近')
    await submit(page)
    const start = Date.now()
    while (Date.now() - start < 80000) {
      if (/\/p\//.test(page.url())) {
        await sleep(page, 5000)
        return { ok: true, note: `model=${modelName}; entered canvas project` }
      }
      const text = await page.locator('body').innerText()
      if (/积分不够|积分不足|暂时没有可用的视频模型/.test(text)) {
        return { ok: false, note: 'video unavailable or credits' }
      }
      await sleep(page, 1000)
    }
    return { ok: false, note: `video timeout model=${modelName}` }
  },
  async '09'(page) {
    await goImage(page)
    const existing = page.getByRole('link', { name: /陶瓷咖啡杯|窗光下的陶瓷/ }).first()
    if (await existing.isVisible().catch(() => false)) {
      await click(page, existing)
    } else {
      await pickTarget(page, '画布创作')
      await typeInto(page, promptBox(page), '一只陶瓷咖啡杯放在木桌上，侧面能看到杯把，自然窗光')
      await submit(page)
    }
    try {
      await page.waitForURL(/\/p\//, { timeout: 25000 })
    } catch {
      const link = page.getByRole('link', { name: /陶瓷咖啡杯/ }).first()
      if (await link.isVisible().catch(() => false)) await click(page, link)
      await page.waitForURL(/\/p\//, { timeout: 20000 })
    }
    const start = Date.now()
    let imageBox = null
    while (Date.now() - start < 120000) {
      if (!/\/p\//.test(page.url())) {
        await sleep(page, 500)
        continue
      }
      imageBox = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')].filter((img) => {
          const rect = img.getBoundingClientRect()
          return img.naturalWidth > 200 && rect.width > 160 && rect.x > 200
        })
        const big = imgs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
        if (!big || big.clientWidth < 80) return null
        const rect = big.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      if (imageBox) break
      const text = await page.locator('body').innerText()
      if (/积分不够|积分不足|生成失败/.test(text)) return { ok: false, note: 'canvas generate failed' }
      await sleep(page, 1000)
    }
    if (!imageBox) return { ok: false, note: 'canvas image did not land' }
    await page.keyboard.press('v')
    await sleep(page, 300)
    await page.mouse.move(imageBox.x + imageBox.width / 2, imageBox.y + imageBox.height / 2, { steps: 12 })
    await sleep(page, 400)
    await page.mouse.click(imageBox.x + imageBox.width / 2, imageBox.y + imageBox.height / 2)
    await sleep(page, 700)
    const inpaint = page.getByRole('button', { name: '智能改图' })
    if (!(await inpaint.isVisible().catch(() => false))) {
      return { ok: false, note: '智能改图按钮未出现' }
    }
    if (await inpaint.isDisabled()) return { ok: false, note: '智能改图置灰，未改走整图编辑' }
    await click(page, inpaint)
    const rect = page.getByRole('radio', { name: '框选区域' })
    if (await rect.isVisible().catch(() => false)) await click(page, rect)
    const layer = page.getByRole('application', { name: '智能改图标记区' })
    await layer.waitFor({ timeout: 10000 })
    const box = await layer.boundingBox()
    if (!box) return { ok: false, note: 'no inpaint layer' }
    await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.28, { steps: 10 })
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.78, { steps: 16 })
    await page.mouse.up()
    await sleep(page, 500)
    await typeInto(page, page.getByRole('textbox', { name: '修改要求' }), '把杯身釉色换成雾面墨绿，杯把保持原样')
    const send = page.getByRole('button', { name: '发送给智能体' })
    if (await send.isDisabled()) return { ok: false, note: '改图发送按钮仍禁用' }
    await click(page, send)
    await sleep(page, 4000)
    return { ok: true, note: 'inpaint submitted' }
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
  args: ['--disable-dev-shm-usage'],
})
const boot = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
const bootPage = await boot.newPage()
await login(bootPage)
await boot.storageState({ path: resolve(rawDir, 'storage.json') })
await boot.close()

const report = []
for (const id of ids) {
  const fn = shots[id]
  if (!fn) throw new Error(`unknown shot ${id}`)
  const context = await browser.newContext({
    storageState: resolve(rawDir, 'storage.json'),
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    recordVideo: { dir: rawDir, size: { width: 1280, height: 800 } },
  })
  await context.addInitScript(CURSOR)
  const page = await context.newPage()
  page.setDefaultTimeout(25000)
  let result = { ok: false, note: '' }
  try {
    result = await fn(page)
  } catch (error) {
    const detail = error instanceof Error ? (error.stack || error.message) : 'failed'
    const buttons = await page
      .getByRole('button')
      .evaluateAll((nodes) => nodes.slice(0, 25).map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40)))
      .catch(() => [])
    result = { ok: false, note: `${detail.split('\n').slice(0, 3).join(' | ')} | buttons=${buttons.join(',')}` }
    await page.screenshot({ path: resolve(rawDir, `${id}-error.png`) }).catch(() => {})
  }
  await sleep(page, 800)
  const video = page.video()
  await context.close()
  const src = video ? await video.path() : ''
  const dest = resolve(rawDir, `${id}.webm`)
  if (src) {
    const { renameSync } = await import('node:fs')
    renameSync(src, dest)
  }
  const row = { id, ok: Boolean(result.ok), skip: Boolean(result.skip), note: result.note || '', file: dest }
  report.push(row)
  console.log(`${id} ok=${row.ok} skip=${row.skip} ${row.note}`)
  writeFileSync(resolve(rawDir, 'report.json'), JSON.stringify(report, null, 2))
}
await browser.close()
