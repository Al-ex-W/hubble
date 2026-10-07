import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser } from 'playwright-core'

/**
 * The display's safety rule, proven in real Chrome: an SVG shown the way
 * apps/web drawingRenderer shows it (an <img> with a data: URL) runs no
 * script and fetches nothing, whatever the SVG contains. This is the layer
 * that holds even if the server's check (drawing.ts) ever misses something,
 * so it gets a real browser, not a DOM imitation.
 *
 * Fixture: synthetic, a hostile drawing written for this test (script,
 * onload, external <image>, CSS url(), @import, foreignObject), all aimed at
 * a local counting server. Oracle: that server's hit count, and the page's
 * own flag a script would set. Skipped, with a warning, when Chromium can't
 * launch (npx playwright-core install chromium).
 */
let browser: Browser | null = null
let server: Server
let hits = 0
let base = ''
beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++
    res.end('x')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    browser = await chromium.launch({ headless: true })
  } catch (e) {
    console.warn(`drawingInert: Chromium unavailable, skipping (${e instanceof Error ? e.message.split('\n')[0] : e})`)
  }
})
afterAll(async () => {
  await browser?.close()
  await new Promise((r) => server.close(r))
})

describe('a drawing shown as <img src="data:image/svg+xml,…">', () => {
  it('runs no script and loads nothing, in real Chrome', async () => {
    if (!browser) return
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100" onload="fetch('${base}/onload')">
<style>@import url(${base}/import.css); rect { fill: url(${base}/fill.png) }</style>
<script>top.document.title = 'pwned'; fetch('${base}/script')</script>
<image href="${base}/image.png" width="10" height="10"/>
<foreignObject width="50" height="50"><img xmlns="http://www.w3.org/1999/xhtml" src="${base}/fo.png"/></foreignObject>
<circle cx="50" cy="50" r="40" stroke="yellow" stroke-width="8" fill="none"/><rect width="5" height="5"/></svg>`
    const page = await browser.newPage()
    // Exactly the renderer's src (drawingRenderer.tsx).
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(hostile)}`
    await page.setContent(`<!doctype html><title>clean</title><img id="d" src="${src}" width="100" height="100">`)
    await page.waitForFunction(() => (document.getElementById('d') as HTMLImageElement).complete)
    await page.waitForTimeout(500)
    // The image did load (so the test isn't passing on a broken image)...
    expect(await page.evaluate(() => (document.getElementById('d') as HTMLImageElement).naturalWidth)).toBe(100)
    // Break caught: drawings shown in a way that executes them (inlined
    // markup, <object>, <iframe>): the script would retitle the page and
    // every reference would hit the server.
    expect(await page.title()).toBe('clean')
    expect(hits).toBe(0)
    await page.close()
  })
})
