const { createServer } = require('node:http')
const { readFile, realpath, mkdir, writeFile } = require('node:fs/promises')
const { resolve, sep, extname, join } = require('node:path')

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
}
const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const PATHS = ['/image', `/p/${PROJECT_ID}`]

// Serve the built bytes with Pages' explicit route rewrites; missing chunks never become HTML.
async function serveDist(dist) {
  const root = await realpath(dist)
  const redirects = (await readFile(join(root, '_redirects'), 'utf8'))
    .split('\n').filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const [source, target, status] = line.trim().split(/\s+/)
      const pattern = source.split('/').map((part) => part.startsWith(':')
        ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')
      return { pattern: new RegExp(`^${pattern}$`), target, status: Number(status) }
    })
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      const redirect = redirects.find((rule) => rule.pattern.test(path))
      if (redirect && redirect.status !== 200) {
        res.writeHead(redirect.status, { location: redirect.target }).end()
        return
      }
      if (redirect) path = redirect.target
      const cleanHtmlPath = path.endsWith('/index.html') ? path.slice(0, -10)
        : path.endsWith('.html') ? path.slice(0, -5) : undefined
      if (path.endsWith('/')) path += 'index.html'
      const file = await realpath(resolve(root, `.${path}`)).catch((error) => {
        if (error.code !== 'ENOENT' || extname(path)) throw error
        return realpath(resolve(root, `.${path}.html`))
      })
      if (!file.startsWith(root + sep)) throw new Error('Outside dist')
      // Pages canonicalizes explicit .html targets even after a 200 rewrite.
      if (cleanHtmlPath !== undefined) {
        res.writeHead(308, { location: cleanHtmlPath }).end()
        return
      }
      const bytes = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store' }).end(bytes)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Not found')
    }
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())),
  }
}

async function checkWorkspace(browser, origin, { local = false, nodeCanvas = false, exerciseNodes = false, exerciseCatalog = false, optionalStyles = [], outputDir, timeoutMs = 30000 } = {}) {
  for (const [index, path] of PATHS.entries()) {
    // Cold browser storage and module cache on each direct navigation, including the deep link.
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    const logs = []
    let rejectFailure
    const failure = new Promise((_, reject) => { rejectFailure = reject })
    failure.catch(() => {})
    const fail = (message) => {
      errors.push(message)
      rejectFailure(new Error(message))
    }
    page.on('pageerror', (error) => fail(error.stack || error.message))
    page.on('console', (entry) => { if (entry.type() === 'error') logs.push(entry.text()) })
    // `/cdn-cgi/` is the CDN's own injected code (bot challenge, analytics), not part of the build.
    const isRequiredAsset = (request) => {
      const url = new URL(request.url())
      return ['script', 'stylesheet'].includes(request.resourceType())
        && url.origin === new URL(origin).origin && !url.pathname.startsWith('/cdn-cgi/')
    }
    page.on('requestfailed', (request) => {
      if (isRequiredAsset(request))
        fail(`Asset request failed: ${request.url()} ${request.failure()?.errorText}`)
    })
    page.on('response', (response) => {
      if (isRequiredAsset(response.request()) && !response.ok())
        fail(`Asset HTTP ${response.status()}: ${response.url()}`)
    })
    if (local) {
      await context.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        // Explicitly optional font styles use the system font in this offline startup check.
        if (request.resourceType() === 'stylesheet' && optionalStyles.includes(url.href))
          return route.fulfill({ contentType: 'text/css', body: '' })
        const fixtures = {
          '/api/capabilities': {
            'accounts:login': true,
            'generation:byok': true,
            ...(nodeCanvas && exerciseNodes ? { 'agent:chat': true } : {}),
          },
          '/api/agent/conversations': { conversations: [] },
          '/api/channels': { channels: [] },
          '/api/agent/skills': { skills: [] },
          '/api/inspirations/manifest': {
            version: 1, updatedAt: '2026-01-01T00:00:00Z', items: [{
              id: 'startup-fixture', title: 'Startup fixture', prompt: 'Fixture',
              thumbnailUrl: '/pwa-icon.svg', params: { size: '1024x1024' },
              recommendedModel: 'fixture', recommendedProvider: 'openai-compat', category: 'Fixture',
            }],
          },
          '/api/auth/me': { error: 'unauthorized' },
        }
        if (Object.hasOwn(fixtures, url.pathname)) {
          if (request.method() !== 'GET') {
            fail(`Unexpected API write: ${request.method()} ${url.pathname}`)
            return route.abort()
          }
          return route.fulfill({ status: url.pathname === '/api/auth/me' ? 401 : 200,
            headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
            contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) })
        }
        if (url.origin !== origin || url.pathname.startsWith('/api/')) {
          fail(`Unexpected startup network request: ${request.method()} ${url.origin}${url.pathname}`)
          return route.abort()
        }
        return route.continue()
      })
    }
    const label = `${nodeCanvas ? 'nodes-' : ''}${index === 0 ? 'home' : 'project'}`
    try {
      if (local && exerciseCatalog && index === 0) {
        const fixtureUrl = new URL('/__catalog_fixture__', origin).href
        await context.route(fixtureUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }))
        await page.goto(fixtureUrl)
        await page.evaluate(() => new Promise((accept, reject) => {
          const request = indexedDB.open('image-playground-canvas', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('scene')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction('scene', 'readwrite')
            const store = transaction.objectStore('scene')
            const cloud = {
              id: 'catalog-cloud', name: 'Conversation catalog fixture', customName: true,
              conversationId: 'catalog-conversation', sceneKey: 'canvas:project:catalog-cloud',
              createdAt: 1, updatedAt: 2, hasContent: true, kind: 'image', experience: 'chat', cloud: { revision: 1 },
            }
            const legacy = { ...cloud, id: 'legacy:canvas:conversation:catalog-conversation',
              sceneKey: 'canvas:conversation:catalog-conversation', cloud: undefined }
            const separate = { ...cloud, id: 'catalog-separate',
              sceneKey: 'canvas:project:catalog-separate', conversationId: 'different-conversation' }
            for (const project of [cloud, legacy, separate])
              store.put(project, `canvas-project:project:${project.id}`)
            transaction.oncomplete = () => { db.close(); accept() }
            transaction.onabort = () => { db.close(); reject(transaction.error) }
          }
        }))
        await context.unroute(fixtureUrl)
      }
      // A known offline project exercises direct routing without an account or server writes.
      // The fixture document loads no app modules, so the subsequent navigation stays cold.
      if (index === 1) {
        const fixtureUrl = new URL('/__startup_fixture__', origin).href
        await context.route(fixtureUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }))
        await page.goto(fixtureUrl)
        await page.evaluate(({ id, exercise }) => new Promise((accept, reject) => {
          const request = indexedDB.open('image-playground-canvas', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('scene')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction('scene', 'readwrite')
            const store = transaction.objectStore('scene')
            store.put({
              id, name: 'Startup fixture', customName: true, conversationId: null,
              sceneKey: `canvas:project:${id}`, createdAt: 1, updatedAt: 1,
              hasContent: exercise, workspaceOpened: true, kind: 'image', experience: 'canvas',
            }, `canvas-project:project:${id}`)
            if (exercise) {
              const image = (id, x) => ({ id, type: 'image', fileId: 'fixture-pixel', x, y: 20, width: 120, height: 120, rotation: 0 })
              store.put({ version: 2, elements: [
                image('fixture-first', 20),
                { id: 'fixture-arrow', type: 'arrow', points: [50, 50, 240, 80], stroke: '#ff0000', strokeWidth: 3 },
                image('fixture-last', 420),
              ], files: { 'fixture-pixel': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j38sAAAAASUVORK5CYII=' }, camera: { x: 0, y: 0, zoom: 1 } }, `canvas:project:${id}`)
            }
            transaction.oncomplete = () => { db.close(); accept() }
            transaction.onabort = () => { db.close(); reject(transaction.error) }
          }
        }), { id: PROJECT_ID, exercise: nodeCanvas && exerciseNodes })
        await context.unroute(fixtureUrl)
      }
      await Promise.race([
        (async () => {
          const response = await page.goto(new URL(path, origin).href,
            { waitUntil: 'domcontentloaded', timeout: timeoutMs })
          if (!response?.ok()) throw new Error(`Page HTTP ${response?.status()}: ${path}`)
          const ready = index === 0 ? '[aria-label="创作"]'
            : nodeCanvas ? '[aria-label="创作画布"] .react-flow'
            : '[aria-label="创作画布"] canvas, [aria-label="创作画布"] .react-flow'
          await page.locator(ready).first().waitFor({ timeout: timeoutMs })
          if (nodeCanvas && index === 1) {
            await page.getByRole('button', { name: '显示小地图', exact: true }).click()
            await page.locator('.react-flow__minimap').waitFor({ timeout: timeoutMs })
          }
          await page.locator('#boot').waitFor({ state: 'detached', timeout: timeoutMs })
          // Let initialization effects and their asset requests finish before declaring readiness.
          await page.waitForLoadState('networkidle', { timeout: timeoutMs })
          if (local && exerciseCatalog && index === 0) {
            const count = await page.locator('nav span.truncate').filter({ hasText: 'Conversation catalog fixture' }).count()
            if (count !== 2) throw new Error(`Conversation catalog identity: expected 2 independent chats, received ${count}`)
            console.log('PASS conversation catalog: one cloud/legacy entry, separate same-title chat retained')
          }
          if (nodeCanvas && exerciseNodes && index === 1) {
            const first = page.locator('.react-flow__node[data-id="fixture-first"]')
            const arrow = page.locator('.react-flow__node[data-id="fixture-arrow"]')
            const last = page.locator('.react-flow__node[data-id="fixture-last"]')
            await first.waitFor({ timeout: timeoutMs })
            await arrow.waitFor({ timeout: timeoutMs })
            await last.waitFor({ timeout: timeoutMs })
            const stacking = await Promise.all([first, arrow, last].map((node) => node.evaluate((el) => Number(getComputedStyle(el).zIndex))))
            if (!(stacking[0] < stacking[1] && stacking[1] < stacking[2]))
              throw new Error(`Annotation stacking is incorrect: ${stacking}`)
            const drawing = await arrow.locator('svg').boundingBox()
            if (!drawing || drawing.width < 100 || drawing.height < 10)
              throw new Error('Annotation bounds do not describe its drawing')
            const before = await first.getAttribute('style')
            const database = `image-playground-nodes:canvas:project:${PROJECT_ID}`
            const updateCount = await page.evaluate((name) => new Promise((accept, reject) => {
              const request = indexedDB.open(name)
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const db = request.result
                const transaction = db.transaction('updates', 'readonly')
                const count = transaction.objectStore('updates').count()
                transaction.oncomplete = () => { db.close(); accept(count.result) }
                transaction.onabort = () => { db.close(); reject(transaction.error) }
              }
            }), database)
            const box = await first.boundingBox()
            if (!box) throw new Error('Migrated image is not visible')
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.down()
            await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 40, { steps: 8 })
            await page.mouse.up()
            const moved = await first.getAttribute('style')
            const transform = (style) => /transform:\s*([^;]+)/.exec(style || '')?.[1]
            if (!transform(moved) || transform(before) === transform(moved))
              throw new Error('Node drag did not change its position')
            console.log(`Node drag: ${transform(before)} -> ${transform(moved)}`)
            const selectedStacking = await Promise.all([first, arrow, last].map((node) => node.evaluate((el) => Number(getComputedStyle(el).zIndex))))
            if (selectedStacking.join(',') !== stacking.join(','))
              throw new Error(`Selection changed annotation stacking: ${stacking} -> ${selectedStacking}`)
            // Wait for the real IndexedDB write, rather than reloading while the browser is committing it.
            await page.waitForFunction(({ database, updateCount }) => new Promise((accept, reject) => {
              const request = indexedDB.open(database)
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const db = request.result
                const transaction = db.transaction('updates', 'readonly')
                const count = transaction.objectStore('updates').count()
                transaction.oncomplete = () => { db.close(); accept(count.result > updateCount) }
                transaction.onabort = () => { db.close(); reject(transaction.error) }
              }
            }), { database, updateCount }, { timeout: timeoutMs })
            await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
            await page.waitForFunction(({ movedTransform }) => {
              const node = document.querySelector('.react-flow__node[data-id="fixture-first"]')
              return node?.style.transform === movedTransform
            }, { movedTransform: transform(moved) }, { timeout: timeoutMs })
            await page.locator('#boot').waitFor({ state: 'detached', timeout: timeoutMs })
            await page.waitForLoadState('networkidle', { timeout: timeoutMs })
            const flow = page.locator('.react-flow')
            const flowBox = await flow.boundingBox()
            if (!flowBox || flowBox.width < 300 || flowBox.height < 240)
              throw new Error(`Node canvas viewport is too small: ${JSON.stringify(flowBox)}`)
            const navigation = page.getByRole('toolbar', { name: '画布工具', exact: true })
            const nodeTools = page.getByRole('toolbar', { name: '添加节点', exact: true })
            const zoomTrigger = navigation.getByRole('button', { name: '缩放画布', exact: true })
            await zoomTrigger.click()
            const zoomOut = page.getByRole('button', { name: '缩小', exact: true })
            const zoomIn = page.getByRole('button', { name: '放大', exact: true })
            for (let i = 0; i < 6; i++) await zoomOut.click()
            const zoomLabel = async () => Number.parseInt((await zoomTrigger.textContent())?.trim() ?? '', 10)
            const zoomBelow = await zoomLabel()
            if (!(zoomBelow < 50)) throw new Error(`Zoom-out control did not go below 50%: ${zoomBelow}`)
            for (let i = 0; i < 6; i++) await zoomIn.click()
            const zoomAbove = await zoomLabel()
            if (!(zoomAbove >= 50)) throw new Error(`Zoom-in control did not recover above 50%: ${zoomAbove}`)
            const caption = page.locator('.studio-node-caption').first()
            await caption.waitFor({ state: 'visible', timeout: timeoutMs })
            const captionAtLowZoom = await caption.boundingBox()
            for (let i = 0; i < 12; i++) await zoomIn.click()
            const captionAtHighZoom = await caption.boundingBox()
            if (!captionAtLowZoom || !captionAtHighZoom ||
              captionAtHighZoom.height > captionAtLowZoom.height * 1.5 ||
              captionAtLowZoom.height > captionAtHighZoom.height * 1.5)
              throw new Error(`Node caption scales with canvas zoom: ${JSON.stringify({
                low: captionAtLowZoom, high: captionAtHighZoom,
              })}`)
            await page.keyboard.press('Escape')
            const afterZoomBox = await flow.boundingBox()
            if (!afterZoomBox || Math.abs(afterZoomBox.width - flowBox.width) > 2 ||
              Math.abs(afterZoomBox.height - flowBox.height) > 2)
              throw new Error(`Canvas frame changed size during zoom: ${JSON.stringify({ flowBox, afterZoomBox })}`)
            const upload = page.locator(
              '.studio-node-canvas input.sr-only[type="file"][aria-hidden="true"][tabindex="-1"]',
            )
            await upload.waitFor({ state: 'attached', timeout: timeoutMs })
            const beforeIds = await page.locator('.react-flow__node').evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute('data-id')).filter(Boolean))
            await nodeTools.getByRole('button', { name: '上传', exact: true }).click()
            await upload.setInputFiles({
              name: 'smoke-upload.png',
              mimeType: 'image/png',
              buffer: Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j38sAAAAASUVORK5CYII=',
                'base64',
              ),
            })
            await page.waitForFunction(
              (ids) => [...document.querySelectorAll('.react-flow__node')].some(
                (node) => !ids.includes(node.getAttribute('data-id')),
              ),
              beforeIds,
              { timeout: timeoutMs },
            )
            const uploadedId = await page.locator('.react-flow__node').evaluateAll(
              (nodes, ids) => nodes.map((node) => node.getAttribute('data-id'))
                .find((id) => id && !ids.includes(id)),
              beforeIds,
            )
            if (!uploadedId) throw new Error('Upload did not create a node')
            const uploaded = page.locator(`.react-flow__node[data-id="${uploadedId}"]`)
            const uploadedImage = uploaded.locator('img').first()
            await uploadedImage.waitFor({ state: 'visible', timeout: timeoutMs })
            await page.waitForFunction(
              (id) => {
                const image = document.querySelector(`.react-flow__node[data-id="${id}"] img`)
                return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
              },
              uploadedId,
              { timeout: timeoutMs },
            )
            const desktopUploadBox = await uploaded.boundingBox()
            if (!desktopUploadBox || desktopUploadBox.width < 24 || desktopUploadBox.height < 24)
              throw new Error(`Uploaded node is not visible at desktop viewport: ${JSON.stringify(desktopUploadBox)}`)
            await uploaded.click()
            const previewButton = page.getByRole('button', { name: '全屏查看', exact: true })
            await previewButton.waitFor({ state: 'visible', timeout: timeoutMs })
            const previewBox = await previewButton.boundingBox()
            if (!previewBox) throw new Error('Uploaded-node composer controls have no hit target')
            const previewHit = await page.evaluate(({ x, y }) => {
              const target = document.elementFromPoint(x, y)
              return target?.closest('button')?.getAttribute('aria-label')
            }, { x: previewBox.x + previewBox.width / 2, y: previewBox.y + previewBox.height / 2 })
            if (previewHit !== '全屏查看') throw new Error(`Composer hit target missed: ${previewHit}`)
            await previewButton.click()
            await page.locator('[data-lightbox-root]').waitFor({ state: 'visible', timeout: timeoutMs })
            await page.keyboard.press('Escape')
            await page.setViewportSize({ width: 390, height: 844 })
            await navigation.getByRole('button', { name: '适应画布', exact: true }).click()
            await page.waitForFunction(
              (id) => {
                const flow = document.querySelector('.react-flow')?.getBoundingClientRect()
                const composer = document.querySelector('.studio-node-composer')?.getBoundingClientRect()
                const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect()
                const nodes = [...document.querySelectorAll('.react-flow__node')]
                return Boolean(flow && composer && node &&
                  node.x >= flow.x &&
                  node.y >= flow.y &&
                  node.right <= flow.right &&
                  node.bottom <= flow.bottom &&
                  nodes.every((element) => element.getBoundingClientRect().bottom <= composer.y + 1))
              },
              uploadedId,
              { timeout: timeoutMs },
            )
            const composerBox = await page.locator('.studio-node-composer').boundingBox()
            const mobileNodeGeometry = await page.locator('.react-flow__node').evaluateAll((nodes) =>
              nodes.map((node) => {
                const rect = node.getBoundingClientRect()
                return { id: node.getAttribute('data-id'), bottom: rect.bottom }
              }),
            )
            if (!composerBox || mobileNodeGeometry.some(({ bottom }) => bottom > composerBox.y + 1))
              throw new Error(`A mobile node is hidden below the composer: ${JSON.stringify({
                composerBox, nodes: mobileNodeGeometry,
              })}`)
            const mobileFlowBox = await flow.boundingBox()
            const mobileUploadBox = await uploaded.boundingBox()
            if (!mobileFlowBox || !mobileUploadBox ||
              mobileUploadBox.x < mobileFlowBox.x || mobileUploadBox.y < mobileFlowBox.y ||
              mobileUploadBox.x + mobileUploadBox.width > mobileFlowBox.x + mobileFlowBox.width ||
              mobileUploadBox.y + mobileUploadBox.height > mobileFlowBox.y + mobileFlowBox.height)
              throw new Error(`Uploaded node bounds are not fully visible on mobile: ${JSON.stringify({ mobileFlowBox, mobileUploadBox })}`)
            const mobileNodeHit = await page.evaluate(({ id, box }) => {
              const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              return target?.closest('.react-flow__node')?.getAttribute('data-id') === id
            }, { id: uploadedId, box: mobileUploadBox })
            if (!mobileNodeHit) throw new Error('Uploaded image center is obscured by mobile controls')
            const modeButton = navigation.getByRole('button', { name: /移动画布|选择/ }).first()
            await modeButton.click()
            await navigation.getByRole('button', { name: /选择 \(V\)/, exact: true }).click()
            await navigation.getByRole('button', { name: /移动画布 \(H\)/, exact: true }).waitFor({
              state: 'visible', timeout: timeoutMs,
            })
            await navigation.getByRole('button', { name: /移动画布 \(H\)/, exact: true }).click()
            await navigation.getByRole('button', { name: /选择 \(V\)/, exact: true }).waitFor({
              state: 'visible', timeout: timeoutMs,
            })
            const chatButton = page.getByRole('button', { name: '与 AI 对话', exact: true })
            await chatButton.click()
            await page.locator('.studio-chat-column').waitFor({ state: 'visible', timeout: timeoutMs })
            const title = page.locator('.studio-node-project-title, .studio-project-viewbar .studio-project-pill').first()
            const titleBox = await title.boundingBox()
            if (!titleBox) throw new Error('Project title is missing at mobile viewport')
            const titleHit = await page.evaluate(({ x, y }) => {
              const target = document.elementFromPoint(x, y)
              return Boolean(target?.closest('.studio-node-project-title, .studio-project-viewbar .studio-project-pill'))
            }, { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 })
            if (!titleHit) throw new Error('Project title is obscured by mobile canvas controls')
            console.log('PASS node canvas: viewport/zoom, uploaded image bounds and composer hit targets on desktop/mobile')
            console.log('PASS node canvas: legacy media/annotation migration, stacking, drag and persisted reload')
          }
          if (errors.length) throw new Error(errors.join('\n'))
        })(),
        failure,
      ])
      if (outputDir) {
        await mkdir(outputDir, { recursive: true })
        await page.screenshot({ path: join(outputDir, `${label}.png`) })
      }
      console.log(`PASS ${path}${nodeCanvas ? ' (node canvas)' : ''}: workspace mounted, boot removed, no JavaScript or asset errors`)
    } catch (error) {
      if (outputDir) {
        await mkdir(outputDir, { recursive: true })
        await page.screenshot({ path: join(outputDir, `${label}-failed.png`) }).catch(() => {})
        await writeFile(join(outputDir, `${label}-failed.json`), JSON.stringify({
          path, error: error.message, errors, consoleErrors: logs,
          html: await page.content().catch(() => ''),
        }, null, 2))
      }
      throw new Error(`Startup smoke failed at ${path}: ${error.message}`, { cause: error })
    } finally {
      await context.close()
    }
  }
}

async function checkMarketing(browser, origin, { local = false, accountsLogin = true, outputDir } = {}) {
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  let loginEnabled = accountsLogin
  let observedCapabilities = local
  if (!local) await context.route('**/api/capabilities', async route => {
    const response = await route.fetch()
    loginEnabled = (await response.json())['accounts:login'] === true
    observedCapabilities = true
    await route.fulfill({response})
  })
  page.on('pageerror', error => errors.push(error.message))
  const requiredAsset = request => {
    const url = new URL(request.url())
    return ['script','stylesheet'].includes(request.resourceType()) && url.origin === origin && !url.pathname.startsWith('/cdn-cgi/')
  }
  page.on('requestfailed', request => { if (requiredAsset(request)) errors.push(`Asset request failed: ${request.url()}`) })
  page.on('response', response => { if (requiredAsset(response.request()) && !response.ok()) errors.push(`Asset HTTP ${response.status()}: ${response.url()}`) })
  if (local) await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/runtime-config.json') return route.fulfill({contentType:'application/json', body:JSON.stringify({bff:{enabled:true,baseUrl:origin}})})
    const fixtures = {
      '/api/capabilities': {'accounts:login':accountsLogin,'accounts:self-register':accountsLogin},
      '/api/auth/oauth/providers': {providers:[]},
    }
    if (!accountsLogin && request.isNavigationRequest() && url.pathname === '/image') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Workbench destination</body></html>'})
    if (request.method() === 'GET' && Object.hasOwn(fixtures,url.pathname)) return route.fulfill({contentType:'application/json',body:JSON.stringify(fixtures[url.pathname])})
    if (url.origin !== origin || url.pathname.startsWith('/api/')) throw new Error(`Unexpected marketing request: ${request.method()} ${url.href}`)
    return route.continue()
  })
  try {
    await page.goto(origin + '/', {waitUntil:'networkidle'})
    if (!observedCapabilities) throw new Error('Marketing entry did not load capabilities')
    if (loginEnabled) {
      await page.getByRole('heading',{name:/说出你要的画面\s*剩下的交给幕芽/}).waitFor()
      await page.locator('.nav').getByRole('button',{name:'免费开始',exact:true}).click()
      await page.getByRole('dialog',{name:'登录',exact:true}).waitFor()
      await page.getByRole('button',{name:'关闭登录框',exact:true}).click()
      if (!(await page.title()).includes('AI 图片、视频与画布创作平台')) throw new Error('Auth changed the marketing title')
    } else {
      await page.waitForURL(origin + '/image')
    }
    const paths = [['/guide/create/composer/','zh-CN'],['/guide/en/create/composer/','en']]
    if (loginEnabled) paths.push(['/en/','en'],['/login/','zh-CN'])
    for (const [path,lang] of paths) {
      const response=await page.goto(origin+path,{waitUntil:'networkidle'})
      if (!response?.ok()) throw new Error(`Static page failed: ${path}`)
      await page.locator('h1').waitFor()
      if (new URL(page.url()).pathname !== path) throw new Error(`Hydration changed the static URL: ${path}`)
      if (await page.locator('html').getAttribute('lang') !== lang) throw new Error(`Wrong locale: ${path}`)
      if (path === '/en/') {
        await page.getByRole('heading',{name:/Say the picture you want\s*Muvloom handles the rest/}).waitFor()
        if (!(await page.title()).includes('AI Image, Video and Canvas Creation')) throw new Error('English marketing title drifted')
      }
      if (path === '/login/') await page.getByRole('form',{name:'用户登录'}).waitFor()
    }
    // 旧章节地址是跳转页：跳走时会中断它自己的脚本请求，所以单开一页检查，不计入资源失败。
    const redirect = await context.newPage()
    await redirect.goto(origin+'/guide/create/#models-params')
    await redirect.waitForURL(origin+'/guide/create/settings/#models-params')
    await redirect.close()
    await page.setViewportSize({width:390,height:844})
    if (await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw new Error('Login overflows narrow viewport')
    if (outputDir) {
      await mkdir(outputDir,{recursive:true})
      await page.screenshot({path:join(outputDir,'marketing-login-narrow.png')})
    }
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(`PASS marketing, guide locales, ${loginEnabled ? 'login entry' : 'login-disabled redirect'} and narrow layout`)
  } finally { await context.close() }
}

async function main() {
  const { chromium } = require('playwright')
  const local = process.argv[2] === '--dist'
  const target = local ? process.argv[3] : process.argv[2]
  if (!target) throw new Error('Usage: pages-browser-smoke.cjs --dist <directory> | <origin>')
  const html = local ? await readFile(join(resolve(target), 'workbench.html'), 'utf8') : ''
  const optionalStyles = (html.match(/<link\b[^>]*data-optional-style[^>]*>/g) || [])
    .map((tag) => /href=["']([^"']+)["']/.exec(tag)?.[1]).filter(Boolean)
  const server = local ? await serveDist(resolve(target)) : null
  let browser
  try {
    browser = await chromium.launch()
    await checkMarketing(browser, server?.origin || target, {local, outputDir:process.env.PAGES_SMOKE_OUTPUT_DIR})
    if (local) await checkMarketing(browser, server.origin, {local:true,accountsLogin:false})
    await checkWorkspace(browser, server?.origin || target, {
      local, exerciseCatalog: local, optionalStyles, timeoutMs: local ? 30000 : 60000,
      outputDir: process.env.PAGES_SMOKE_OUTPUT_DIR,
    })
    if (local) await checkWorkspace(browser, server.origin, {
      local, nodeCanvas: true, exerciseNodes: true, exerciseCatalog: true, optionalStyles, timeoutMs: 30000,
      outputDir: process.env.PAGES_SMOKE_OUTPUT_DIR,
    })
  } finally {
    await browser?.close()
    await server?.close()
  }
}

module.exports = { serveDist, checkWorkspace, checkMarketing }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
