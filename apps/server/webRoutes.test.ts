import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import type { SurfacesLine } from '@hubble/stage'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createWebHost } from './web.ts'

/**
 * Web surfaces over HTTP (#31): the routes, their validation, and the
 * surface set and the browser staying one truth. Label: synthetic (a local
 * test site written here, no internet). Oracles: the page's own URL and
 * title as the browser reports them, the published surface set, and the
 * JPEG bytes on the stream.
 */
const config: ServerConfig = { port: 0, llm: { baseUrl: 'https://llm.example/v1', apiKey: undefined, model: 'aixia-labs' }, jevApiKey: undefined, webAllow: ['127.0.0.1'] }

let site: Server
let siteBase = ''
let app: ReturnType<typeof createApp>
let server: Server
let base = ''
let canLaunch = false

beforeAll(async () => {
  site = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (req.url === '/b') return res.end('<!doctype html><title>Page B</title><h1>B</h1>')
    res.end('<!doctype html><title>Page A</title><style>body{margin:0}</style><a href="/b" style="position:absolute;left:10px;top:10px;width:200px;height:40px;display:block">to B</a>')
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  siteBase = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  try {
    await (await chromium.launch()).close()
    canLaunch = true
  } catch {
    console.warn('[web] headless Chromium could not launch: the web route tests are skipped')
  }
  app = createApp(config)
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 30_000)
afterAll(async () => {
  await app?.web.shutdown()
  server?.closeAllConnections()
  server?.close()
  site?.close()
})

const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const webOf = async (id: string) => ((await (await fetch(`${base}/api/surfaces`)).json()) as SurfacesLine).surfaces.find((s) => s.id === id)

describe('web surface routes', () => {
  it('refuses a host that is not allowed and a body that is not a url, opening nothing', async () => {
    // Break caught: the open route putting any site on the table.
    expect((await post('/api/surfaces/web', { url: 'https://evil.example/' })).status).toBe(403)
    expect((await post('/api/surfaces/web', { url: 42 })).status).toBe(400)
    expect(((await (await fetch(`${base}/api/surfaces`)).json()) as SurfacesLine).surfaces.filter((s) => s.kind === 'web')).toEqual([])
    expect(app.web.ids()).toEqual([])
  })

  it('opens a page as a web surface at its real size, centred, and the browser page is that size', async (t) => {
    if (!canLaunch) t.skip()
    const r = (await (await post('/api/surfaces/web', { url: `${siteBase}/a` })).json()) as SurfacesLine & { id: string }
    const s = r.surfaces.find((x) => x.id === r.id)!
    // 760 x 475 mm at 1550/1920 mm/px = 941.4 x 588.4 px, rounded to whole px
    // (the viewport is whole px), centred on 1920 x 1200. (480 x 300 mm until
    // 7 Oct: phone-width pages, see WEB_SIZE.)
    expect(s).toMatchObject({ kind: 'web', box: { x: Math.round((1920 - 941) / 2), y: Math.round((1200 - 588) / 2), w: 941, h: 588 } })
    expect(s.state).toMatchObject({ url: `${siteBase}/a`, title: 'Page A', status: 'ready', stream: `/api/web/${r.id}/stream` })
    // Break caught: a page rendered at another size than its box, so every
    // click lands somewhere else on the page than where it was aimed.
    expect(app.web.inspect(r.id)!.viewportSize()).toEqual({ width: 941, height: 588 })
    // Break caught: index.ts not wiring onOpen to the runtime, so "open
    // Amazon" then SEND went to the brain instead of the page that opened.
    expect(app.runtime.focusedWeb()).toBe(r.id)
  })

  // Break caught (bench, 7 Oct, measured in Chrome): Chrome draws an MJPEG
  // part only once the next part starts arriving. A still page sends one
  // frame and then nothing, so its <img> stayed white (naturalWidth 0) while
  // the server held the frame. A viewer of a still page must get the frame
  // a second time, without the page repainting.
  it('a viewer of a still page gets its frame twice, so Chrome draws it', async (t) => {
    if (!canLaunch) t.skip()
    const r = (await (await post('/api/surfaces/web', { url: `${siteBase}/a` })).json()) as { id: string }
    // Let the page go still first, so a second frame can't come from painting.
    await new Promise((r2) => setTimeout(r2, 1500))
    const ctl = new AbortController()
    const res = await fetch(`${base}/api/web/${r.id}/stream`, { signal: ctl.signal })
    const reader = res.body!.getReader()
    let got = Buffer.alloc(0)
    const jpegs = () => {
      let n = 0
      for (let i = got.indexOf(Buffer.from([0xff, 0xd8])); i >= 0; i = got.indexOf(Buffer.from([0xff, 0xd8]), i + 2)) n++
      return n
    }
    const deadline = Date.now() + 1500
    while (jpegs() < 2 && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ value: undefined }>((r2) => setTimeout(() => r2({ value: undefined }), 500))])
      if (chunk.value) got = Buffer.concat([got, Buffer.from(chunk.value)])
    }
    ctl.abort()
    expect(jpegs()).toBeGreaterThanOrEqual(2)
  })

  it('streams the page as MJPEG', async (t) => {
    if (!canLaunch) t.skip()
    const r = (await (await post('/api/surfaces/web', { url: `${siteBase}/a` })).json()) as { id: string }
    const ctl = new AbortController()
    const res = await fetch(`${base}/api/web/${r.id}/stream`, { signal: ctl.signal })
    expect(res.headers.get('content-type')).toMatch(/^multipart\/x-mixed-replace/)
    const reader = res.body!.getReader()
    let got = Buffer.alloc(0)
    while (got.indexOf(Buffer.from([0xff, 0xd8])) < 0) got = Buffer.concat([got, Buffer.from((await reader.read()).value!)])
    ctl.abort()
    expect((await fetch(`${base}/api/web/web-999/stream`)).status).toBe(404)
  })

  it('validates every op, and refuses a navigation off the allow-list', async (t) => {
    if (!canLaunch) t.skip()
    const { id } = (await (await post('/api/surfaces/web', { url: `${siteBase}/a` })).json()) as { id: string }
    // Break caught: input from any page on the room network reaching the
    // browser unchecked (a click off the page, a 1 MB paste, F12, any URL).
    expect((await post(`/api/web/${id}/click`, { x: 1000, y: 10 })).status).toBe(400) // wider than the 941 px box
    expect((await post(`/api/web/${id}/click`, { x: -1, y: 10 })).status).toBe(400)
    expect((await post(`/api/web/${id}/click`, { x: '100', y: 10 })).status).toBe(400) // a number, not a string that looks like one
    expect((await post(`/api/web/${id}/scroll`, { dy: null })).status).toBe(400)
    expect((await post(`/api/web/${id}/scroll`, { dy: 1e6 })).status).toBe(400)
    expect((await post(`/api/web/${id}/type`, { text: 'x'.repeat(501) })).status).toBe(400)
    expect((await post(`/api/web/${id}/type`, { text: '' })).status).toBe(400)
    expect((await post(`/api/web/${id}/key`, { key: 'F12' })).status).toBe(400)
    expect((await post(`/api/web/${id}/navigate`, { url: 'https://evil.example/' })).status).toBe(403)
    expect((await post(`/api/web/${id}/print`)).status).toBe(404)
    expect((await post('/api/web/web-999/back')).status).toBe(404)
    // A surface that exists but is not a page: the answer.
    app.runtime.surfaces.onRenderLine({ kind: 'start', renderId: 'r-web', intent: 'x', model: 'm', t: 0 })
    expect(await webOf('answer')).toBeDefined()
    expect((await post('/api/web/answer/back')).status).toBe(404)
    expect(app.web.inspect(id)!.url()).toBe(`${siteBase}/a`)
  })

  it('a click that navigates updates the surface the displays see', async (t) => {
    if (!canLaunch) t.skip()
    const { id } = (await (await post('/api/surfaces/web', { url: `${siteBase}/a` })).json()) as { id: string }
    const st = await (await post(`/api/web/${id}/click`, { x: 110, y: 30 })).json()
    expect(st).toMatchObject({ url: `${siteBase}/b`, title: 'Page B', status: 'ready' })
    // Break caught: the browser moving on while the table's window list
    // still names the old page.
    expect((await webOf(id))!.state).toMatchObject({ url: `${siteBase}/b`, title: 'Page B' })
  })

  it('closing the surface closes its browser page', async (t) => {
    if (!canLaunch) t.skip()
    const { id } = (await (await post('/api/surfaces/web', { url: `${siteBase}/a` })).json()) as { id: string }
    expect(app.web.ids()).toContain(id)
    expect((await post(`/api/surfaces/${id}/close`)).status).toBe(200)
    // Break caught: a page kept rendering (and streaming) for a surface
    // nobody can see, and its late state reports re-opening it.
    const until = Date.now() + 3000
    while (app.web.ids().includes(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
    expect(app.web.ids()).not.toContain(id)
    expect(await webOf(id)).toBeUndefined()
  })
})

describe('a browser that cannot start', () => {
  it('the surface the displays draw says so, instead of loading forever', async () => {
    // Break caught (review #46): the open's error returned to the route and
    // dropped, so the published surface stayed "loading" with no stream.
    const a = createApp(config, { web: (onState) => createWebHost({ allow: ['127.0.0.1'], onState, launch: async () => { throw new Error('no chromium here') } }) })
    const srv = a.listen(0)
    await new Promise((r) => srv.once('listening', r))
    try {
      const r = (await (await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/surfaces/web`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:9/a' }) })).json()) as SurfacesLine & { id: string }
      expect(r.surfaces.find((s) => s.id === r.id)!.state).toMatchObject({ status: 'error', error: 'no chromium here' })
    } finally {
      await a.web.shutdown()
      srv.closeAllConnections()
      srv.close()
    }
  })
})
