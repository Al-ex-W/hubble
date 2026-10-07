import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { allowsNavigation, allowsSubresource, allowsUrl, createWebHost, isAllowed, isPrivateHost, policyFrom, type WebHost } from './web.ts'

/**
 * Web surfaces against a real headless Chromium and a local test site (no
 * internet). Label: synthetic (the site is written here: a link at a known
 * position, a long page to scroll, a text field, a link to a host that is
 * not allowed, and a page that never answers). Oracle: the page's own URL,
 * scroll position and field value, read back from the browser.
 */
const SIZE = { w: 640, h: 400 }
let site: Server
let base = ''
let blockedBase = ''
/** Every request the site served, as host + path: what really left the browser. */
const served: string[] = []
const page = (body: string) => `<!doctype html><html><head><title>${body.match(/<h1>(.*?)<\/h1>/)?.[1] ?? 'page'}</title><style>body{margin:0;font:20px sans-serif}a,input{position:absolute}</style></head><body>${body}</body></html>`

let canLaunch = false
/** The subresource test's page: set by that test (it needs the device server's port). */
let devicePage = ''
beforeAll(async () => {
  site = createServer((req, res) => {
    served.push(`${req.headers.host?.split(':')[0]}${req.url}`)
    if (req.url === '/hang') return // never answers: the deadline must end it
    // Answers after the open's deadline: the page commits on a dead entry.
    if (req.url === '/slow') return void setTimeout(() => res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('<h1>Slow</h1>')), 600)
    // Redirects (review #46: Playwright does not re-route a followed
    // redirect, so these must be checked before the browser follows them).
    if (req.url === '/redirect-out') return res.writeHead(302, { Location: `${blockedBase}/b` }).end()
    if (req.url === '/redirect-in') return res.writeHead(302, { Location: '/b' }).end()
    if (req.url === '/redirect-chain') return res.writeHead(302, { Location: '/redirect-out' }).end()
    // A redirect carrying a strict CSP, as real sites send (review #46 r2 N2).
    if (req.url === '/redirect-csp') return res.writeHead(302, { Location: '/b', 'Content-Security-Policy': "default-src 'self'" }).end()
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (req.url === '/b') return res.end(page('<h1>Page B</h1>'))
    // A page whose image points at an unlisted local address (the room's
    // devices are this kind of address), and one at its own listed host.
    // Written by the subresource test, which owns the "device" server.
    if (req.url === '/img-local') return res.end(devicePage)
    if (req.url === '/own.png') return res.end('')
    if (req.url === '/frame') return res.end(page(`<h1>Framed</h1><iframe id="f" src="${blockedBase}/b"></iframe>`))
    if (req.url === '/popup') return res.end(page(`<h1>Popup</h1><button id="go" style="position:absolute;left:0;top:0;width:200px;height:60px" onclick="window.open('/b')">open</button>`))
    if (req.url === '/popup-out') return res.end(page(`<h1>Popup out</h1><button id="go" style="position:absolute;left:0;top:0;width:200px;height:60px" onclick="window.open('${blockedBase}/b')">open</button>`))
    if (req.url === '/auto') return res.end(page(`<h1>Auto</h1><script>setTimeout(() => { location.href = '/b' }, 300)</script>`))
    res.end(
      page(
        `<h1>Page A</h1>
         <a id="next" href="/b" style="left:10px;top:60px;width:200px;height:40px;display:block">to page B</a>
         <a id="away" href="${blockedBase}/b" style="left:10px;top:120px;width:200px;height:40px;display:block">elsewhere</a>
         <input id="q" style="left:10px;top:180px;width:300px;height:30px">
         <div style="position:absolute;top:0;height:4000px;width:1px"></div>`,
      ),
    )
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const port = (site.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  // Same server, a hostname the allow-list doesn't name (resolves locally, no DNS).
  blockedBase = `http://localhost:${port}`
  try {
    await (await chromium.launch()).close()
    canLaunch = true
  } catch {
    console.warn('[web] headless Chromium could not launch: the web surface tests are skipped')
  }
}, 30_000)
afterAll(() => site?.close())

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('isAllowed', () => {
  const allow = ['en.wikipedia.org', '127.0.0.1']
  it.each([
    ['https://en.wikipedia.org/wiki/Pythagoras', true],
    ['https://EN.Wikipedia.ORG/wiki/X', true],
    ['http://127.0.0.1:5555/a', true],
    ['https://en.wikipedia.org.evil.com/', false],
    ['https://evilwikipedia.org/', false],
    ['https://wikipedia.org/', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
    // An allowed name as a suffix of another label, and an allowed host over
    // a non-web scheme: the two surviving mutants of the first version.
    ['https://xen.wikipedia.org/', false],
    ['ftp://127.0.0.1/', false],
    ['ws://127.0.0.1:5555/', false],
    // Userinfo before an allowed name: the host is what follows the @.
    ['http://127.0.0.1@evil.example/', false],
    ['http://evil.example@127.0.0.1/', true],
  ])('%s → %s', (url, want) => {
    // Break caught: a suffix match letting en.wikipedia.org.evil.com through,
    // or a non-http scheme reaching the browser.
    expect(isAllowed(url, allow)).toBe(want)
  })
})

it('an allow-list entry typed in capitals or with spaces still matches', () => {
  // Break caught: config written as " EN.Wikipedia.org" silently allowing nothing.
  expect(isAllowed('https://en.wikipedia.org/wiki/X', [' EN.Wikipedia.org '])).toBe(true)
})

describe('the public policy (any website, never the local network)', () => {
  const pub = policyFrom(['*'])
  it.each([
    ['https://www.amazon.se/', true],
    ['https://en.wikipedia.org/wiki/X', true],
    ['http://93.184.216.34/', true],
    ['https://[2606:4700::1111]/', true],
    // The room's devices and our own server (break: a page or a spoken
    // "open 192.168.42.21" reaching the projector Pi around the hardware gate).
    ['http://192.168.42.21/status', false],
    ['http://192.168.42.11/api', false],
    ['http://localhost:8787/api/runtime', false],
    ['http://127.0.0.1:5173/table', false],
    ['http://pi-projector.local/', false],
    ['http://router.lan/', false],
    ['http://10.0.0.1/', false],
    ['http://172.16.5.4/', false],
    ['http://172.31.255.255/', false],
    ['http://169.254.169.254/latest/meta-data', false],
    ['http://100.64.0.1/', false],
    ['http://0.0.0.0:8787/', false],
    ['http://[::1]:8787/', false],
    ['http://[fe80::1]/', false],
    ['http://[fd00::1]/', false],
    // Spellings that end up as 127.0.0.1 or 192.168.x (break: a check on the
    // raw text instead of the parsed hostname, or v4 hiding inside v6).
    ['http://2130706433/', false],
    ['http://0x7f.1/', false],
    ['http://[::ffff:127.0.0.1]/', false],
    ['http://[::ffff:c0a8:2a15]/', false],
    ['http://LOCALHOST./', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    // Look-alikes that are public (break: a prefix match on "10." or "172.").
    ['http://172.32.0.1/', true],
    ['http://11.0.0.1/', true],
    ['https://10.example.com/', true],
  ])('%s → %s', (url, want) => {
    expect(allowsUrl(url, pub)).toBe(want)
  })

  it('list mode is the old exact allow-list, untouched', () => {
    // Break caught: the policy rewrite loosening a locked-down room.
    const list = policyFrom([' EN.Wikipedia.org ', '127.0.0.1'])
    expect(list).toEqual({ mode: 'list', hosts: ['en.wikipedia.org', '127.0.0.1'] })
    expect(allowsUrl('https://en.wikipedia.org/wiki/X', list)).toBe(true)
    expect(allowsUrl('https://www.amazon.se/', list)).toBe(false)
    expect(allowsUrl('http://127.0.0.1:5555/a', list)).toBe(true) // listed on purpose
  })

  it('a public name that resolves to a private address is refused as a document', async () => {
    // Break caught: the literal check alone, which a name like localtest.me
    // (public DNS answering 127.0.0.1) or one pointed at 192.168.42.x walks past.
    const resolve = async (h: string) => (h === 'sneaky.example' ? ['192.168.42.21'] : h === 'mixed.example' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34'])
    expect(await allowsNavigation('https://sneaky.example/', pub, resolve)).toBe(false)
    expect(await allowsNavigation('https://mixed.example/', pub, resolve)).toBe(false)
    expect(await allowsNavigation('https://www.amazon.se/', pub, resolve)).toBe(true)
    // A failed lookup refuses (Chromium couldn't load it either).
    expect(await allowsNavigation('https://nx.example/', pub, async () => Promise.reject(new Error('ENOTFOUND')))).toBe(false)
    // List mode doesn't resolve: its hosts are named on purpose.
    expect(await allowsNavigation('http://127.0.0.1:1/', policyFrom(['127.0.0.1']), async () => ['127.0.0.1'])).toBe(true)
  })

  it('subresources: private literals refused in both modes, listed hosts exempt', () => {
    // Break caught: documents checked but <img src="http://192.168.42.21/..."> loaded.
    expect(allowsSubresource('http://192.168.42.21/camera/frame', pub)).toBe(false)
    expect(allowsSubresource('ws://localhost:8787/', pub)).toBe(false)
    expect(allowsSubresource('https://m.media-amazon.com/images/x.jpg', pub)).toBe(true)
    expect(allowsSubresource('data:image/png;base64,AAAA', pub)).toBe(true)
    const list = policyFrom(['127.0.0.1'])
    expect(allowsSubresource('http://127.0.0.1:5555/own.png', list)).toBe(true)
    expect(allowsSubresource('http://localhost:5555/secret.png', list)).toBe(false)
    expect(isPrivateHost('192.168.42.24')).toBe(true)
  })
})

describe('subresources in a real page', () => {
  it('an image at an unlisted local address is never fetched; the page\'s own one is', async (t) => {
    if (!canLaunch) t.skip()
    // The "device": its own server on IPv6 loopback, a private literal the
    // list doesn't name. Not the site's localhost alias: on macOS localhost
    // tries ::1 first and the site only listens on 127.0.0.1, so that image
    // failed to connect with or without the guard and the first version of
    // this test passed with the guard removed (mutation run, 7 Oct).
    const hits: string[] = []
    const device = createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'image/png' }).end('')
    })
    try {
      await new Promise<void>((r, j) => device.once('error', j).listen(0, '::1', () => r()))
    } catch {
      return console.warn('[web] no IPv6 loopback: subresource test skipped')
    }
    const devicePort = (device.address() as AddressInfo).port
    devicePage = page(`<h1>Images</h1><img src="http://[::1]:${devicePort}/camera/frame"><img src="/own.png">`)
    const host = createWebHost({ allow: ['127.0.0.1'], deadlines: { openMs: 4000, inputMs: 2000 } })
    try {
      const st = await host.open('w', `${base}/img-local`, SIZE)
      expect(st.status).toBe('ready')
      // The positive control proves the page's images did load.
      expect(await until(() => served.includes('127.0.0.1/own.png'))).toBe(true)
      // The outcome that matters: a page never reaches a local "device".
      // Not a proof of OUR guard on its own: today's Chromium also holds a
      // cross-origin request to a loopback address, waiting for a "local
      // network access" permission headless never grants (seen 7 Oct with
      // the guard removed: the request is issued, never answered). Our guard
      // is the layer that doesn't depend on that browser behaviour, and its
      // rule is proven by the allowsSubresource tests above.
      expect(await until(() => hits.length > 0, 1500)).toBe(false)
    } finally {
      await host.shutdown()
      device.close()
    }
  })
})

describe('a web surface in headless Chromium', () => {
  let host: WebHost
  beforeAll(() => {
    host = createWebHost({ allow: ['127.0.0.1'], deadlines: { openMs: 4000, inputMs: 2000 } })
  })
  afterAll(async () => host?.shutdown())

  it('opens a page at the surface size and streams a frame of it', async (t) => {
    if (!canLaunch) t.skip()
    const s = await host.open('w1', `${base}/a`, SIZE)
    expect(s).toMatchObject({ status: 'ready', title: 'Page A' })
    expect(await until(() => host.frame('w1') !== null)).toBe(true)
    // JPEG magic bytes: a real picture of the page, not an empty buffer.
    expect(host.frame('w1')!.subarray(0, 2).toString('hex')).toBe('ffd8')
    const vp = host.inspect('w1')!.viewportSize()
    expect(vp).toEqual({ width: SIZE.w, height: SIZE.h })
  })

  it('clicks a link where it is drawn, goes back and forward', async (t) => {
    if (!canLaunch) t.skip()
    await host.open('w2', `${base}/a`, SIZE)
    // The link's box is left 10..210, top 60..100: click its middle.
    const after = await host.click('w2', 110, 80)
    expect(after?.url).toBe(`${base}/b`)
    expect(after?.title).toBe('Page B')
    expect((await host.back('w2'))?.url).toBe(`${base}/a`)
    expect((await host.forward('w2'))?.url).toBe(`${base}/b`)
  })

  it('scrolls the page and types into a focused field', async (t) => {
    if (!canLaunch) t.skip()
    await host.open('w3', `${base}/a`, SIZE)
    await host.click('w3', 150, 195) // the text field
    await host.type('w3', 'pythagoras')
    expect(await host.inspect('w3')!.inputValue('#q')).toBe('pythagoras')
    await host.scroll('w3', 800)
    expect(await until(async () => (await host.inspect('w3')!.evaluate(() => window.scrollY)) > 0)).toBe(true)
  })

  it('refuses hosts that are not allowed: opening, navigating, and following a link', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: the table showing any site a model, a person or a link asks for.
    expect(await host.open('w4', `${blockedBase}/a`, SIZE)).toMatchObject({ status: 'error', error: 'host not allowed' })
    await host.open('w5', `${base}/a`, SIZE)
    expect(await host.navigate('w5', `${blockedBase}/b`)).toMatchObject({ error: 'host not allowed' })
    await host.click('w5', 110, 140) // the link to the blocked host
    expect(host.inspect('w5')!.url()).toBe(`${base}/a`)
  })

  it('a page that never answers becomes an error within the deadline, not a hang', async (t) => {
    if (!canLaunch) t.skip()
    const t0 = Date.now()
    const s = await host.open('w6', `${base}/hang`, SIZE)
    expect(s.status).toBe('error')
    expect(Date.now() - t0).toBeLessThan(8000)
  })

  it('a crashed browser is replaced on the next open', async (t) => {
    if (!canLaunch) t.skip()
    await host.open('w7', `${base}/a`, SIZE)
    await host.browser()!.close()
    expect(await until(() => host.state('w7')?.status === 'error')).toBe(true)
    expect(await host.open('w8', `${base}/a`, SIZE)).toMatchObject({ status: 'ready' })
  })
})

/**
 * The host's lifecycle and the allow-list's every path (review #46). Same
 * synthetic site; a gated launch makes "the browser is still starting"
 * deterministic instead of timing-dependent. Oracle: what the browser
 * really loaded (its frames, pages and URL, and the site's request log),
 * and the states the host published.
 */
describe('every way a page can leave the allow-list', () => {
  let host: WebHost
  beforeAll(() => {
    host = createWebHost({ allow: ['127.0.0.1'], deadlines: { openMs: 4000, inputMs: 2000 } })
  })
  afterAll(async () => host?.shutdown())

  it('a redirect to a host that is not allowed is not followed; one to an allowed page is', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: an allowed URL 302-ing anywhere and that page being
    // streamed to the table as "ready".
    // Oracle: the site's own request log, i.e. whether the browser ever
    // asked the disallowed host for the page. A blocked first navigation
    // leaves no page, so the surface reports the error.
    served.length = 0
    // The surface says why: the host, not a timeout or a broken page.
    expect(await host.open('r1', `${base}/redirect-out`, SIZE)).toMatchObject({ status: 'error', error: 'host not allowed' })
    expect(await host.open('r2', `${base}/redirect-chain`, SIZE)).toMatchObject({ status: 'error', error: 'host not allowed' })
    expect(served.filter((r) => r.startsWith('localhost'))).toEqual([])
    expect(served).toContain('127.0.0.1/redirect-chain')
    // An allowed redirect lands on its target (through a self-replacing
    // document, so the published state settles a moment after the open).
    expect(await host.open('r3', `${base}/redirect-in`, SIZE)).toMatchObject({ status: 'ready' })
    expect(await until(() => host.state('r3')?.url === `${base}/b` && host.state('r3')?.title === 'Page B')).toBe(true)
  })

  it('a redirect carrying a strict CSP still reaches its target', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught (review #46 r2 N2): the self-replacing document kept the
    // redirect's CSP, which blocked its own script: the page stuck, blank.
    await host.open('csp1', `${base}/redirect-csp`, SIZE)
    expect(await until(() => host.state('csp1')?.url === `${base}/b` && host.state('csp1')?.title === 'Page B')).toBe(true)
  })

  it('a popup to a host that is not allowed is refused without taking the server down', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught (review #46 r2 N1): a popup's first request has no frame
    // yet; reading it threw inside the route and crashed the process (vitest
    // reports that as an unhandled error, failing the run).
    served.length = 0
    await host.open('po1', `${base}/popup-out`, SIZE)
    await host.click('po1', 100, 30)
    const ctx = host.inspect('po1')!.context()
    expect(await until(() => ctx.pages().length === 1)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(served.filter((r) => r.startsWith('localhost'))).toEqual([])
    expect(host.state('po1')).toMatchObject({ status: 'ready', url: `${base}/popup-out` })
  })

  it('an iframe of a host that is not allowed loads nothing', async (t) => {
    if (!canLaunch) t.skip()
    served.length = 0
    await host.open('f1', `${base}/frame`, SIZE)
    // Wait for the child document's navigation to settle before asserting.
    // open() returns at domcontentloaded, before the iframe's own request is
    // routed, so asserting there passed even with the child-document guard
    // removed (manager verification of #46: the mutation that let disallowed
    // child frames through the fetch path survived the whole host suite).
    await host.inspect('f1')!.waitForLoadState('load')
    await new Promise((r) => setTimeout(r, 200))
    expect(served.filter((r) => r.startsWith('localhost'))).toEqual([])
    const frames = host.inspect('f1')!.frames().map((f) => f.url())
    expect(frames.some((u) => u.includes('localhost'))).toBe(false)
  })

  it('a popup is closed, even one showing an allowed page', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: window.open creating a second page the host doesn't
    // track, showing (or running) anything.
    await host.open('p1', `${base}/popup`, SIZE)
    served.length = 0
    await host.click('p1', 100, 30)
    const ctx = host.inspect('p1')!.context()
    expect(await until(() => ctx.pages().length === 1)).toBe(true)
    expect(ctx.pages()[0]).toBe(host.inspect('p1'))
    expect(served.filter((r) => r.startsWith('localhost'))).toEqual([])
  })

  it('a page that navigates by itself updates its published url and title', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: the table's window list naming a page the browser left.
    const seen: string[] = []
    const h = createWebHost({ allow: ['127.0.0.1'], onState: (_id, s) => seen.push(`${s.url}|${s.title}`) })
    try {
      await h.open('a1', `${base}/auto`, SIZE)
      expect(await until(() => h.state('a1')?.url === `${base}/b` && h.state('a1')?.title === 'Page B')).toBe(true)
      expect(seen.at(-1)).toBe(`${base}/b|Page B`)
    } finally {
      await h.shutdown()
    }
  })
})

describe('the host lifecycle', () => {
  const gated = () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    return { release, launch: () => gate.then(() => chromium.launch()) }
  }

  it('a stream asked for while the browser is still starting gets the frames when they come', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: a display that connected before the page existed got a
    // 404 and kept a broken picture forever (review #46).
    const g = gated()
    const h = createWebHost({ allow: ['127.0.0.1'], launch: g.launch })
    try {
      const opening = h.open('s1', `${base}/a`, SIZE)
      const chunks: Buffer[] = []
      const res = fakeRes(chunks)
      expect(h.stream('s1', res as never)).toBe(true)
      g.release()
      expect((await opening).status).toBe('ready')
      expect(await until(() => Buffer.concat(chunks).includes(Buffer.from([0xff, 0xd8])))).toBe(true)
    } finally {
      await h.shutdown()
    }
  })

  it('closing a surface while its browser is starting leaves no page behind', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: the open finishing after the close and keeping a live
    // page (and a browser) nobody owns.
    const g = gated()
    const h = createWebHost({ allow: ['127.0.0.1'], launch: g.launch })
    try {
      const opening = h.open('c1', `${base}/a`, SIZE)
      await h.close('c1')
      g.release()
      await opening
      expect(h.ids()).toEqual([])
      expect(await until(() => !h.browser()?.isConnected())).toBe(true)
    } finally {
      await h.shutdown()
    }
  })

  it('a browser that fails to start is reported as an error state, not left loading', async () => {
    const states: string[] = []
    const h = createWebHost({ allow: ['127.0.0.1'], launch: async () => { throw new Error('no chromium here') }, onState: (_id, s) => states.push(s.status) })
    expect(await h.open('e1', `${base}/a`, SIZE)).toMatchObject({ status: 'error' })
    // Published, so the surface the displays draw says so too.
    expect(states.at(-1)).toBe('error')
    expect(h.state('e1')).toMatchObject({ status: 'error' })
    await h.shutdown()
  })

  it('one deadline covers the whole open, browser start included', async () => {
    // Break caught: a browser that never finishes starting holding the
    // open (and the HTTP request) forever; the deadline only covered goto.
    const h = createWebHost({ allow: ['127.0.0.1'], launch: () => new Promise(() => {}), deadlines: { openMs: 300 } })
    const t0 = Date.now()
    expect(await h.open('d1', `${base}/a`, SIZE)).toMatchObject({ status: 'error' })
    expect(Date.now() - t0).toBeLessThan(1500)
    await h.shutdown()
  })

  it('a browser that finishes starting after shutdown is closed, not kept', async (t) => {
    if (!canLaunch) t.skip()
    let launched: import('playwright-core').Browser | null = null
    const g = gated()
    const h = createWebHost({ allow: ['127.0.0.1'], launch: () => g.launch().then((b) => (launched = b)), deadlines: { openMs: 100 } })
    await h.open('l1', `${base}/a`, SIZE)
    await h.shutdown()
    g.release()
    expect(await until(() => launched !== null && !launched.isConnected())).toBe(true)
  })

  it('closing a page closes its browser context, ends its viewers, and the last one closes the browser', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught (review #46 survivors): a context, a stream or the whole
    // browser kept alive for a surface that is gone.
    const h = createWebHost({ allow: ['127.0.0.1'] })
    try {
      await h.open('x1', `${base}/a`, SIZE)
      const pg = h.inspect('x1')!
      const chunks: Buffer[] = []
      const res = fakeRes(chunks)
      h.stream('x1', res as never)
      await h.close('x1')
      expect(pg.isClosed()).toBe(true)
      expect(res.ended).toBe(true)
      expect(h.browser()).toBeNull()
    } finally {
      await h.shutdown()
    }
  })

  it('a viewer that has fallen far behind is skipped, not buffered without end', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: an animated page and a slow display growing the
    // server's memory frame by frame (review #46 suspicion).
    const h = createWebHost({ allow: ['127.0.0.1'] })
    try {
      await h.open('b1', `${base}/a`, SIZE)
      const slow: Buffer[] = []
      const fast: Buffer[] = []
      const behind = { ...fakeRes(slow), writableLength: 3 * 1024 * 1024 }
      h.stream('b1', behind as never)
      h.stream('b1', fakeRes(fast) as never)
      await h.scroll('b1', 400) // a repaint, so a new frame is sent
      expect(await until(() => Buffer.concat(fast).includes(Buffer.from([0xff, 0xd8])))).toBe(true)
      expect(Buffer.concat(slow).includes(Buffer.from([0xff, 0xd8]))).toBe(false)
    } finally {
      await h.shutdown()
    }
  })

  it('reopening a surface keeps its viewers, which get the new page', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: a display's stream ending (and showing nothing) when its
    // surface is pointed at another page.
    const h = createWebHost({ allow: ['127.0.0.1'] })
    try {
      await h.open('v1', `${base}/a`, SIZE)
      const chunks: Buffer[] = []
      const res = fakeRes(chunks)
      h.stream('v1', res as never)
      await h.open('v1', `${base}/b`, SIZE)
      chunks.length = 0
      expect(res.ended).toBe(false)
      expect(await until(() => Buffer.concat(chunks).includes(Buffer.from([0xff, 0xd8])))).toBe(true)
    } finally {
      await h.shutdown()
    }
  })

  it('closing one page closes its context even while another page keeps the browser open', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught (review #46 survivor): the context never closed; it only
    // looked closed when the last page took the whole browser with it.
    const h = createWebHost({ allow: ['127.0.0.1'] })
    try {
      await h.open('k1', `${base}/a`, SIZE)
      await h.open('k2', `${base}/a`, SIZE)
      const pg = h.inspect('k1')!
      await h.close('k1')
      expect(h.browser()?.isConnected()).toBe(true)
      expect(pg.isClosed()).toBe(true)
      expect(h.browser()!.contexts()).toHaveLength(1)
    } finally {
      await h.shutdown()
    }
  })

  it('an open that timed out publishes nothing after its error, even when the page arrives late', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: the late page's url and title overwriting the error the
    // surface shows. What prevents it: a timed-out open closes its context
    // at once, so the late page never commits.
    const seen: string[] = []
    const h = createWebHost({ allow: ['127.0.0.1'], deadlines: { openMs: 300 }, onState: (_id, s) => seen.push(`${s.status}|${s.url}|${s.title}`) })
    try {
      expect(await h.open('late1', `${base}/slow`, SIZE)).toMatchObject({ status: 'error' })
      const n = seen.length
      await new Promise((r) => setTimeout(r, 1200))
      expect(seen.slice(n)).toEqual([])
    } finally {
      await h.shutdown()
    }
  })

  it('a replaced page\'s late title does not reach the surface that now shows another page', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught (review #46 r2 N3): a title already being read when the
    // page was replaced published the old page's url and title under the id.
    const seen: string[] = []
    const h = createWebHost({ allow: ['127.0.0.1'], onState: (_id, s) => seen.push(`${s.url}|${s.title}`) })
    try {
      await h.open('same', `${base}/a`, SIZE)
      const old = h.inspect('same')!
      const realTitle = old.title.bind(old)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      // The old page's title, read for real, delivered only after the replace.
      old.title = async () => {
        const t = await realTitle()
        await gate
        return t
      }
      void h.navigate('same', `${base}/b`)
      await until(async () => old.url() === `${base}/b`)
      await h.open('same', `${base}/a`, SIZE)
      const n = seen.length
      release()
      await new Promise((r) => setTimeout(r, 300))
      expect(seen.slice(n).filter((x) => x.includes('/b'))).toEqual([])
    } finally {
      await h.shutdown()
    }
  })

  it('a timed-out scroll does not move the page later', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught (review #46 r2): an op reported failed still acted when
    // its stalled step finished (the wheel after a slow mouse move).
    const h = createWebHost({ allow: ['127.0.0.1'], deadlines: { inputMs: 60 } })
    try {
      await h.open('ts1', `${base}/a`, SIZE)
      await h.click('ts1', 150, 195) // focus the field, for the queued type below
      await new Promise((r) => setTimeout(r, 100)) // the click's own navigation wait ends
      const pg = h.inspect('ts1')!
      const realMove = pg.mouse.move.bind(pg.mouse)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      pg.mouse.move = async (...a: Parameters<typeof realMove>) => {
        await gate
        return realMove(...a)
      }
      expect(await h.scroll('ts1', 800)).toMatchObject({ status: 'error' })
      // Queued behind the stalled scroll, this click on the link to page B
      // expires before it starts: it must never start (a late click would
      // navigate the page nobody asked to move any more).
      expect(await h.click('ts1', 110, 80)).toMatchObject({ status: 'error' })
      release()
      await new Promise((r) => setTimeout(r, 500))
      expect(await pg.evaluate(() => window.scrollY)).toBe(0)
      expect(pg.url()).toBe(`${base}/a`)
    } finally {
      await h.shutdown()
    }
  })

  it('a click that does not navigate neither times out nor holds up the next input', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: the click's wait for a navigation outliving the op, so
    // under a short budget the click reported a timeout and the type queued
    // behind it expired unstarted.
    const h = createWebHost({ allow: ['127.0.0.1'], deadlines: { inputMs: 300 } })
    try {
      await h.open('nv1', `${base}/a`, SIZE)
      expect(await h.click('nv1', 150, 195)).toMatchObject({ status: 'ready' })
      await h.type('nv1', 'k')
      expect(await h.inspect('nv1')!.inputValue('#q')).toBe('k')
    } finally {
      await h.shutdown()
    }
  })

  it('a closed page publishes nothing more, even if it was mid-navigation', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: a late url or title from a closed page (its listeners
    // fire until the context is really gone) reaching the surface set.
    const seen: string[] = []
    const h = createWebHost({ allow: ['127.0.0.1'], onState: (id, s) => seen.push(`${id}:${s.status}:${s.url}`) })
    try {
      await h.open('m1', `${base}/auto`, SIZE)
      const n = seen.length
      const closing = h.close('m1')
      await new Promise((r) => setTimeout(r, 700))
      await closing
      expect(seen.slice(n)).toEqual([])
    } finally {
      await h.shutdown()
    }
  })

  it('input is applied in order, and a timed-out op stops instead of finishing late', async (t) => {
    if (!canLaunch) t.skip()
    // Break caught: a type that timed out still running while the next one
    // types, interleaving the two texts in the field.
    const h = createWebHost({ allow: ['127.0.0.1'], deadlines: { inputMs: 40 } })
    try {
      await h.open('q1', `${base}/a`, SIZE)
      await h.click('q1', 150, 195)
      await new Promise((r) => setTimeout(r, 100)) // the click's own navigation wait ends
      // The longest text the route accepts: long enough that, uncancelled, it
      // is still typing well after its 40 ms deadline.
      const long = 'a'.repeat(500)
      expect(await h.type('q1', long)).toMatchObject({ status: 'error' }) // timed out: the rest is cancelled
      const pg = h.inspect('q1')!
      // The cancelled op stops at its next character; what it typed stays.
      await new Promise((r) => setTimeout(r, 30))
      const typed = (await pg.inputValue('#q')).length
      await new Promise((r) => setTimeout(r, 400))
      expect((await pg.inputValue('#q')).length - typed).toBeLessThanOrEqual(1) // nothing more arrives late
      expect(typed).toBeLessThan(500)
      await h.type('q1', 'Z')
      expect(await until(async () => (await pg.inputValue('#q')).endsWith('Z'), 2000)).toBe(true)
      // Some of the a's, then the Z: never a's after the Z (no interleaving),
      // and not all 120 (the expired op stopped).
      expect(await pg.inputValue('#q')).toMatch(/^a{0,119}Z$/)
      // A failed input op does not mark the page failed: it is still there.
      expect(h.state('q1')!.status).toBe('ready')
    } finally {
      await h.shutdown()
    }
  })
})

/** A stand-in for an Express response: records what is written. */
function fakeRes(chunks: Buffer[]) {
  const r = {
    ended: false,
    writableLength: 0,
    writeHead() {
      return r
    },
    write(c: string | Buffer) {
      chunks.push(Buffer.from(c))
      return true
    },
    end() {
      r.ended = true
    },
    on() {
      return r
    },
  }
  return r
}
