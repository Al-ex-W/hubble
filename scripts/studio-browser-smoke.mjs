import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

// Run against the already-running Studio servers: node scripts/studio-browser-smoke.mjs.
// This is a real browser/API smoke, not a recording of model generation. Adding
// uses the real example-library UI; the edit is a mechanical mutation of that
// example. Keeping every write on the newly inserted document lets finally
// restore the original server snapshot without advancing anyone else's revision.
const base = process.env.STUDIO_URL ?? 'http://localhost:5173'
const artifacts = '/var/folders/k0/pdhlzksn3y9dpkrn1zm7cb5w0000gn/T/opencode'
const run = `studio-smoke-${Date.now()}`
const failures = []
const diagnostics = []
const screenshots = []
let insertedId
let originalDocuments
let browser
let context

async function check(name, operation) {
  try {
    await operation()
    console.log(`PASS ${name}`)
    return true
  } catch (error) {
    failures.push({ name, error: error.message })
    console.error(`FAIL ${name}: ${error.message}`)
    return false
  }
}

async function eventually(read, predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let value
  do {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(`${message}; last observation: ${JSON.stringify(value)}`)
}

async function api(path = '', method = 'GET', data) {
  const response = await context.request.fetch(`${base}/api/studio${path}`, { method, data })
  assert.ok(response.ok(), `${method} ${path}: HTTP ${response.status()} ${await response.text()}`)
  return response.json()
}

async function observe(page, label) {
  page.on('pageerror', error => diagnostics.push(`${label} pageerror: ${error.message}`))
  page.on('console', message => {
    // Warnings are included because CSP and font failures sometimes surface as
    // warnings instead of pageerror. The intentional rejected PUT is reported
    // separately; only that exact HTTP response may produce an expected error.
    if (['error', 'warning'].includes(message.type())) {
      const location = message.location().url
      if (message.text().includes('422') && location === `${base}/api/studio/components/${insertedId}`) return
      diagnostics.push(`${label} ${message.type()}: ${message.text()} (${location})`)
    }
  })
  await page.addInitScript(() => {
    window.__studioSmokeMessages = []
    window.addEventListener('message', event => {
      if (event.data?.channel !== 'hubble-component') return
      const index = [...document.querySelectorAll('iframe')].findIndex(frame => frame.contentWindow === event.source)
      window.__studioSmokeMessages.push({ index, type: event.data.type, revision: event.data.revision, message: event.data.message })
    })
  })
}

const surfaces = page => page.locator('.studio-surface')
async function frameAt(page, index) {
  const handle = await surfaces(page).nth(index).locator('iframe').elementHandle()
  assert.ok(handle, `Missing iframe ${index}`)
  const frame = await handle.contentFrame()
  assert.ok(frame, `Missing browsing context ${index}`)
  await frame.locator('#component h2').waitFor({ state: 'visible' })
  return { handle, frame }
}
async function readyCount(page, count) {
  await eventually(() => surfaces(page).count(), value => value === count, `Expected ${count} surfaces`)
  for (let index = 0; index < count; index++) await frameAt(page, index)
}
async function messages(page) { return page.evaluate(() => window.__studioSmokeMessages) }
async function mountCounts(page) {
  const events = await messages(page)
  return [0, 1, 2].map(index => events.filter(event => event.index === index && event.type === 'mounted').length)
}
async function timerSeconds(frame) {
  const text = (await frame.locator('.liquid-stat > div').textContent()).trim()
  assert.match(text, /^\d+:\d{2}$/, 'Timer must render a minutes:seconds value')
  const [minutes, seconds] = text.split(':').map(Number)
  return minutes * 60 + seconds
}
async function keepsTicking(frame, before) {
  await frame.getByRole('button', { name: 'Pause', exact: true }).waitFor({ state: 'visible' })
  const after = await eventually(() => timerSeconds(frame), value => value < before, 'Existing timer stopped or reset')
  assert.ok(after < 1500, 'Timer reset to its initial state')
}
async function originalsUnchanged(page, retained, initialMounts) {
  // Node equality catches React replacing the iframe; a per-document token
  // catches navigation/reload that preserves the iframe element. Mounted
  // messages catch a React remount inside an otherwise unchanged document.
  for (let index = 0; index < retained.length; index++) {
    assert.ok(await retained[index].handle.evaluate((node, i) => node.isConnected && node === document.querySelectorAll('.studio-surface iframe')[i], index), `Original iframe ${index} was replaced`)
    assert.equal(await retained[index].frame.evaluate(() => window.__studioSmokeIdentity), `${run}-${index}`, `Original iframe ${index} reloaded`)
  }
  assert.deepEqual(await mountCounts(page), initialMounts, 'An original component was remounted')
}
async function noOverflow(page, label) {
  const measure = target => target.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  const outer = await measure(page)
  assert.ok(outer.scroll <= outer.width + 1, `${label} horizontal overflow: ${JSON.stringify(outer)}`)
  for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
    const inner = await measure(frame)
    assert.ok(inner.scroll <= inner.width + 1, `${label} iframe horizontal overflow: ${JSON.stringify(inner)}`)
  }
}
async function screenshot(page, label) {
  const path = `${artifacts}/${run}-${label}.png`
  await page.screenshot({ path, fullPage: true })
  screenshots.push(path)
}

try {
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  context.setDefaultTimeout(10_000)
  const studio = await context.newPage()
  await observe(studio, 'studio desktop')
  originalDocuments = (await api()).documents
  // Pin the real seeded canvas: silently accepting two examples would miss a
  // broken seed, and accepting pre-existing extra documents would risk editing
  // someone else's work. This precondition fails before any write.
  assert.deepEqual(originalDocuments.map(document => document.title), ['Wave laboratory', 'Focus timer', 'Room atmosphere'])
  await studio.goto(`${base}/studio`, { waitUntil: 'domcontentloaded' })
  const initialReady = await check('initial three real React frames render', async () => {
    await readyCount(studio, 3)
    const headings = ['A little change. A new wave.', 'A moment to focus.', 'Set the feeling.']
    for (let index = 0; index < 3; index++) assert.equal(await (await frameAt(studio, index)).frame.locator('h2').textContent(), headings[index])
    await studio.getByText('Surface connected', { exact: true }).waitFor()
    await eventually(() => mountCounts(studio), counts => counts.every(count => count === 1), 'Each original must mount exactly once')
  })
  if (!initialReady) throw new Error('Cannot exercise interactive flows because the initial frames did not render')
  const retained = await Promise.all([0, 1, 2].map(index => frameAt(studio, index)))
  for (let index = 0; index < retained.length; index++) await retained[index].frame.evaluate(token => { window.__studioSmokeIdentity = token }, `${run}-${index}`)
  const initialMounts = await mountCounts(studio)
  const timer = retained[1].frame
  await check('Begin session starts a ticking timer', async () => {
    assert.equal(await timerSeconds(timer), 1500)
    await timer.getByRole('button', { name: 'Begin session', exact: true }).click()
    await keepsTicking(timer, 1500)
  })
  const wave = retained[0].frame
  let changedPoints
  await check('wave slider changes the actual SVG geometry', async () => {
    const points = await wave.locator('svg polyline').getAttribute('points')
    const slider = wave.getByRole('slider', { name: /^Frequency/ })
    await slider.focus()
    await slider.press('ArrowRight')
    changedPoints = await eventually(() => wave.locator('svg polyline').getAttribute('points'), value => value !== points, 'Frequency changed without changing SVG')
    assert.equal(await slider.inputValue(), '2.1')
  })
  const beforeAdd = await timerSeconds(timer)
  await check('add example through UI preserves original iframe identities and timer state', async () => {
    const responsePromise = studio.waitForResponse(response => response.url() === `${base}/api/studio/examples` && response.request().method() === 'POST')
    await studio.locator('.studio-library').getByRole('button', { name: /Wave laboratory/ }).click()
    const response = await responsePromise
    assert.ok(response.ok(), `Adding example returned ${response.status()}`)
    insertedId = (await response.json()).id
    await readyCount(studio, 4)
    await originalsUnchanged(studio, retained, initialMounts)
    await keepsTicking(timer, beforeAdd)
    if (changedPoints) assert.equal(await wave.locator('svg polyline').getAttribute('points'), changedPoints, 'Existing slider state was reset by add')
  })
  assert.ok(insertedId, 'No inserted example available for edit/remove checks')
  const projector = await context.newPage()
  await observe(projector, 'projector desktop')
  await check('GET projector page mirrors all four documents', async () => {
    const response = await projector.goto(`${base}/studio/projector`, { waitUntil: 'domcontentloaded' })
    assert.equal(response.status(), 200)
    await readyCount(projector, 4)
    assert.deepEqual(await projector.locator('iframe').evaluateAll(frames => frames.map(frame => frame.title)), (await api()).documents.map(document => document.title))
  })
  const added = await frameAt(studio, 3)
  const beforeEdit = (await api()).documents
  const inserted = beforeEdit.find(document => document.id === insertedId)
  const editedHeading = 'Browser smoke: edited wave.'
  const editedSource = inserted.source.replace('A little change. A new wave.', editedHeading)
  assert.notEqual(editedSource, inserted.source, 'Mechanical source mutation did not match the real example')
  const beforeEditTimer = await timerSeconds(timer)
  await check('UI compile changes only the edited revision/component while timer keeps running', async () => {
    await surfaces(studio).nth(3).getByRole('button', { name: 'Edit source for Wave laboratory', exact: true }).click()
    await studio.getByRole('dialog').waitFor()
    await studio.locator('#studio-source').fill(editedSource)
    await studio.getByRole('button', { name: 'Compile & update', exact: true }).click()
    await studio.getByRole('dialog').waitFor({ state: 'hidden' })
    await eventually(() => added.frame.locator('h2').textContent(), value => value === editedHeading, 'Edited React component never updated')
    const after = (await api()).documents
    assert.deepEqual(after.filter(document => document.id !== insertedId), beforeEdit.filter(document => document.id !== insertedId), 'Compile changed unrelated documents')
    assert.equal(after.find(document => document.id === insertedId).revision, inserted.revision + 1)
    await originalsUnchanged(studio, retained, initialMounts)
    await keepsTicking(timer, beforeEditTimer)
    if (changedPoints) assert.equal(await wave.locator('svg polyline').getAttribute('points'), changedPoints)
    await eventually(() => messages(studio), events => events.filter(event => event.index === 3 && event.type === 'mounted').length === 2, 'Edited component must remount exactly once')
    const projected = (await frameAt(projector, 3)).frame
    await eventually(() => projected.locator('h2').textContent(), value => value === editedHeading, 'Projector did not receive edited source')
  })
  await check('malformed source PUT is refused and preserves the full last-good snapshot', async () => {
    const before = await api()
    const mountedBefore = await messages(studio)
    // Mechanical truncation of the working example is deliberately invalid,
    // unlike a runtime throw that would compile and legitimately update state.
    const response = await context.request.put(`${base}/api/studio/components/${insertedId}`, { data: { title: inserted.title, source: editedSource.slice(0, editedSource.indexOf('return <UI.Stack>') + 17) } })
    assert.equal(response.status(), 422)
    assert.ok((await response.json()).error)
    assert.deepEqual(await api(), before)
    assert.equal(await added.frame.locator('h2').textContent(), editedHeading)
    assert.deepEqual(await messages(studio), mountedBefore, 'Rejected compile sent a mount/update')
    await originalsUnchanged(studio, retained, initialMounts)
  })
  await check('desktop Studio and projector have no horizontal overflow', async () => {
    await noOverflow(studio, '1440px Studio')
    await noOverflow(projector, '1440px projector')
  })
  await screenshot(studio, 'desktop')
  await screenshot(projector, 'projector-desktop')
  const mobile = await context.newPage()
  await observe(mobile, '390px mobile')
  await mobile.setViewportSize({ width: 390, height: 844 })
  await check('390px mobile Studio and projector render without horizontal overflow', async () => {
    await mobile.goto(`${base}/studio`, { waitUntil: 'domcontentloaded' })
    await readyCount(mobile, 4)
    await noOverflow(mobile, '390px Studio')
    await screenshot(mobile, 'mobile')
    await mobile.goto(`${base}/studio/projector`, { waitUntil: 'domcontentloaded' })
    await readyCount(mobile, 4)
    await noOverflow(mobile, '390px projector')
    await screenshot(mobile, 'projector-mobile')
  })
  const beforeRemove = await timerSeconds(timer)
  await check('UI remove propagates to both pages and keeps the original timer alive', async () => {
    await surfaces(studio).nth(3).getByRole('button', { name: 'Remove Wave laboratory', exact: true }).click()
    await readyCount(studio, 3)
    await readyCount(projector, 3)
    await readyCount(mobile, 3)
    assert.deepEqual((await api()).documents, originalDocuments)
    await originalsUnchanged(studio, retained, initialMounts)
    await keepsTicking(timer, beforeRemove)
  })
  await check('no runtime, CSP, console, or reported component errors', async () => {
    for (const page of [studio, projector, mobile]) {
      const errors = (await messages(page)).filter(event => event.type === 'error')
      assert.deepEqual(errors, [], `Component runtime errors on ${page.url()}`)
      assert.equal(await page.locator('.studio-error').count(), 0, `Visible error on ${page.url()}`)
    }
    assert.deepEqual(diagnostics, [])
  })
} catch (error) {
  failures.push({ name: 'scenario setup/continuation', error: error.message })
  console.error(`FAIL scenario setup/continuation: ${error.message}`)
} finally {
  if (context && insertedId) {
    await check('cleanup restores original documents exactly', async () => {
      await api(`/components/${insertedId}`, 'DELETE')
      assert.deepEqual((await api()).documents, originalDocuments)
    })
  }
  if (browser) await browser.close()
}

console.log(JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', generation: 'Not exercised: real example-library add and mechanically edited source; no synthetic generator or model claim.', failures, diagnostics, screenshots }, null, 2))
process.exitCode = failures.length ? 1 : 0
