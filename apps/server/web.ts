import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Response as ExpressResponse } from 'express'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Route } from 'playwright-core'

/**
 * Real webpages on the table (#31): one headless Chromium page per `web`
 * surface, streamed to displays, driven by clicks, scrolls and text.
 *
 * Why a server-side browser and not an iframe: most sites refuse to be
 * framed (X-Frame-Options / CSP frame-ancestors), so an iframe shows a grey
 * box exactly where the demo needs the page (ledger decision D3).
 *
 * The page's viewport is the surface's box in projector px (device scale 1),
 * so a point on the surface IS the point on the page: a click needs no
 * coordinate mapping, and the stream is drawn 1:1 into the box.
 *
 * Nothing here may take the table down: every call has a deadline, failures
 * become an `error` state on that one surface, a dead browser is relaunched
 * on the next open, and no method throws to its caller.
 *
 * Lifecycle (reshaped by review #46): a page's entry exists from the first
 * line of `open`, before any await, so a display asking for the stream and a
 * close arriving while the browser is still starting both find it. Every
 * step of the open re-checks that its entry is still the live one (not
 * closed, replaced, timed out or shut down) and disposes what it created if
 * not, so work that finishes late never leaves a page or a browser behind.
 */
export interface WebState {
  url: string
  title: string
  status: 'loading' | 'ready' | 'error'
  error?: string
}

export interface WebHostOptions {
  /**
   * What may be shown: a policy, or the config's list (`['*']` = public,
   * otherwise exact hostnames). The one source: config.ts webAllow.
   */
  allow: readonly string[] | WebPolicy
  /** Hostname → addresses, for the public policy's DNS check. Injected by tests; the default is the system resolver. */
  resolve?: Resolve
  /** Called whenever a page's url, title or status changes (the surface manager publishes it). */
  onState?: (id: string, state: WebState) => void
  launch?: () => Promise<Browser>
  deadlines?: { openMs?: number; inputMs?: number }
}

/**
 * Whether a URL may be shown: http(s) only, and the hostname exactly one on
 * the list. Exact, not suffix: `en.wikipedia.org.evil.com` and
 * `evilwikipedia.org` must not pass because they end in an allowed name.
 * Ports are ignored (the hostname is what identifies the site).
 */
export function isAllowed(raw: string, allow: readonly string[]): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  // URL already lowercases the hostname (and punycodes it); the allow-list
  // is what a person typed into config, so that side is normalised here.
  return allow.some((a) => a.trim().toLowerCase() === u.hostname)
}

/**
 * Which pages may be shown (2026-10-07, docs/plans/2026-10-07-web-browsing.md).
 *
 * `public`: any http(s) site the visitor names ("open up Amazon"), except
 * local and private addresses. `list`: the old exact allow-list, kept for a
 * locked-down room (HUBBLE_WEB_ALLOW=host,host).
 *
 * Why private addresses are the line, not a nicety: this browser runs on the
 * demo laptop, on the room's network. The room's devices are 192.168.42.x
 * (projector, TVs, lidar, Hue), reachable only through packages/room's pool
 * inside the hardware window; a page that could load 192.168.42.21 would
 * reach them around that gate. And our own API listens on every interface
 * (:8787, :5173), so localhost is just as off limits.
 */
export type WebPolicy = { mode: 'public' } | { mode: 'list'; hosts: readonly string[] }
export type Resolve = (hostname: string) => Promise<string[]>

/** The config's list as a policy: `*` anywhere in it means public. */
export function policyFrom(allow: readonly string[] | WebPolicy): WebPolicy {
  if (!Array.isArray(allow)) return allow as WebPolicy
  const hosts = (allow as readonly string[]).map((h) => h.trim().toLowerCase()).filter(Boolean)
  return hosts.includes('*') ? { mode: 'public' } : { mode: 'list', hosts }
}

const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** An IPv4 address as four numbers, or null. Only dotted-decimal: WHATWG URL already turns 2130706433, 0x7f.1 and friends into it. */
function v4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const o = m.slice(1).map(Number)
  return o.every((n) => n <= 255) ? o : null
}

function privateV4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"; 0.0.0.0 reaches the local machine
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local (also cloud metadata)
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) || // the room: 192.168.42.x
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  )
}

/**
 * True for an address or name that points into the local machine or a
 * private network. Names: localhost and the suffixes that only resolve on a
 * LAN. Literals: the private, loopback and link-local ranges, IPv6 included
 * (::1, fc00::/7, fe80::/10, and IPv4-mapped ::ffff:a.b.c.d, which is how a
 * v4 address hides inside a v6 literal).
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === '' || h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true
  const four = v4(h)
  if (four) return privateV4(four)
  if (isIP(h) === 6) {
    if (h === '::' || h === '::1') return true
    const mapped = /^::ffff:(.+)$/.exec(h)
    if (mapped) {
      const m4 = v4(mapped[1]!)
      if (m4) return privateV4(m4)
      // ::ffff:7f00:1 is the hex spelling of ::ffff:127.0.0.1.
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped[1]!)
      if (hex) {
        const hi = parseInt(hex[1]!, 16)
        const lo = parseInt(hex[2]!, 16)
        return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255])
      }
      return true
    }
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
  }
  return false
}

const parse = (raw: string): URL | null => {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/**
 * May this URL be shown? Synchronous: the routes' and the page's quick check.
 * A public-mode name can still resolve privately; documents get that check
 * too (allowsNavigation), on the way into the browser.
 */
export function allowsUrl(raw: string, policy: WebPolicy): boolean {
  const u = parse(raw)
  if (!u) return false
  if (policy.mode === 'list') return isAllowed(raw, policy.hosts)
  return !isPrivateHost(u.hostname)
}

/**
 * A document navigation: allowsUrl plus, in public mode, where the name
 * resolves. Without it `localtest.me`-style names (public DNS answering
 * 127.0.0.1) and any name pointed at 192.168.42.x walk past the literal
 * check. A failed lookup refuses: Chromium couldn't load it either.
 */
export async function allowsNavigation(raw: string, policy: WebPolicy, resolve: Resolve = systemResolve): Promise<boolean> {
  if (!allowsUrl(raw, policy)) return false
  if (policy.mode === 'list') return true
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return true // a literal was already checked
  try {
    const addrs = await resolve(host)
    return addrs.length > 0 && addrs.every((a) => !isPrivateHost(a))
  } catch {
    return false
  }
}

/**
 * A subresource (image, script, fetch, WebSocket…), in either mode: refused
 * only when it names a local or private address literally, unless list mode
 * lists that host (a locked-down room may serve its own pages). Not
 * DNS-checked: a lookup per image would stall every page; see the plan's
 * ruling on the residual risk. Non-network schemes (data:, blob:) pass.
 * Why this exists at all: the old guard checked documents only, so any
 * allowed page could <img src="http://192.168.42.21/camera/frame">.
 */
export function allowsSubresource(raw: string, policy: WebPolicy): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return true
  if (policy.mode === 'list' && policy.hosts.includes(u.hostname)) return true
  return !isPrivateHost(u.hostname)
}

/** Keys the table may send: enough to submit a search and fix a typo, nothing that reaches the browser's own UI. */
export const WEB_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp'] as const

interface Entry {
  /** False once closed, replaced, timed out or shut down: late work checks it and disposes itself. */
  live: boolean
  context: BrowserContext | null
  page: Page | null
  cdp: CDPSession | null
  size: { w: number; h: number }
  state: WebState
  frame: Buffer | null
  viewers: Set<ExpressResponse>
  /** Input ops run one after another (see `op`). */
  chain: Promise<unknown>
  /** Set when the guard refused a main-frame document, so a failed open can say why. */
  blocked: boolean
}

const BOUNDARY = 'hubbleframe'
/**
 * A viewer this far behind is skipped for a frame rather than buffered: an
 * animated page and a slow display would otherwise grow memory without
 * bound (review #46). Newer frames replace older ones, so a skip loses
 * nothing a viewer would still want.
 */
const MAX_BUFFERED = 2 * 1024 * 1024

class Cancelled extends Error {}

export function createWebHost(opts: WebHostOptions) {
  const policy = policyFrom(opts.allow)
  const resolve = opts.resolve ?? systemResolve
  const openMs = opts.deadlines?.openMs ?? 10_000
  const inputMs = opts.deadlines?.inputMs ?? 3_000
  const launch = opts.launch ?? (() => chromium.launch({ headless: true }))
  let browser: Browser | null = null
  let launching: Promise<Browser> | null = null
  let shut = false
  const pages = new Map<string, Entry>()

  const withDeadline = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      )
    })
  const message = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0]! : String(err))

  /**
   * The one place a page's state is published. A dead entry (closed,
   * replaced, timed out) publishes nothing but its own error. Closing its
   * context stops new events, but not a result already on its way: a title
   * read just before a replace arrived after it and was published under the
   * id, as the new page's (review #46 round 2; round 1 removed this check
   * believing it unreachable).
   */
  const setState = (id: string, e: Entry, patch: Partial<WebState>) => {
    if ((!e.live || pages.get(id) !== e) && patch.status !== 'error') return
    e.state = { ...e.state, ...patch }
    // A navigation or title update alone doesn't clear an error; a status
    // that isn't an error does.
    if (patch.status && patch.status !== 'error') delete e.state.error
    opts.onState?.(id, e.state)
  }

  /** No page left: no browser idling on the demo laptop. */
  const closeIdleBrowser = async () => {
    if (pages.size > 0 || !browser) return
    const b = browser
    browser = null
    await withDeadline(b.close(), inputMs, 'browser close').catch(() => undefined)
  }

  const ensureBrowser = async (): Promise<Browser> => {
    if (browser?.isConnected()) return browser
    // A browser that finishes starting after shutdown (its open timed out
    // first) is closed by the build that asked for it: its next check sees
    // the host shut down and closes the idle browser (review #46). The build
    // always awaits this, so that is the one place it is decided.
    launching ??= launch().then((b) => {
      browser = b
      // A crashed browser takes every page with it: mark them, and let the
      // next open start a fresh one.
      b.on('disconnected', () => {
        if (browser === b) browser = null
        for (const [id, e] of pages) {
          if (!e.page) continue
          e.page = null
          e.context = null
          setState(id, e, { status: 'error', error: 'browser closed' })
        }
      })
      return b
    })
    try {
      return await launching
    } finally {
      launching = null
    }
  }

  // Each part ends with the *next* boundary, written at once. Why: Chrome
  // draws an MJPEG part only when it sees the boundary after it. With the
  // boundary written before each frame, the newest frame stayed undrawn
  // until the page repainted; a still page (a cookie dialog, a loaded
  // article) sends one frame and then nothing, so the <img> stayed white on
  // the bench (7 Oct) while the server had the frame. stream() writes the
  // opening boundary, so every part here is already "inside" one.
  const sendFrame = (res: ExpressResponse, jpeg: Buffer) => {
    if (res.writableLength > MAX_BUFFERED) return
    res.write(`Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`)
    res.write(jpeg)
    res.write(`\r\n--${BOUNDARY}\r\n`)
  }

  // Chrome shows an MJPEG part only once the *next* part starts arriving
  // (measured on the bench, 7 Oct: a still YouTube page's <img> stayed at
  // naturalWidth 0 with the frame and its closing boundary received, and
  // drew the moment a scroll produced a second frame). A still page sends
  // one frame and then nothing, so its newest frame is never drawn. So the
  // newest frame is sent again once the page has been quiet for REPEAT_MS:
  // the part Chrome then holds back is a copy of the one it shows.
  // REPEAT_MS: long enough that a page that is painting (scrolling, a video)
  // never pays for copies, short enough that a click's result shows at once.
  const REPEAT_MS = 150
  const repeats = new Map<Entry, ReturnType<typeof setTimeout>>()
  const broadcast = (e: Entry, jpeg: Buffer) => {
    for (const v of e.viewers) sendFrame(v, jpeg)
    clearTimeout(repeats.get(e))
    repeats.set(
      e,
      setTimeout(() => {
        repeats.delete(e)
        if (!e.live || e.frame !== jpeg) return
        for (const v of e.viewers) sendFrame(v, jpeg)
      }, REPEAT_MS),
    )
  }

  /** Free everything an entry holds. Safe to call twice, and on a half-built entry. */
  const dispose = async (e: Entry) => {
    e.live = false
    clearTimeout(repeats.get(e))
    repeats.delete(e)
    for (const v of e.viewers) v.end()
    e.viewers.clear()
    const ctx = e.context
    e.context = null
    e.page = null
    if (ctx) await withDeadline(ctx.close(), inputMs, 'close').catch(() => undefined)
  }

  const close = async (id: string) => {
    const e = pages.get(id)
    if (!e) return
    pages.delete(id)
    await dispose(e)
    await closeIdleBrowser()
  }

  /**
   * Every document navigation, in every frame and every page of the context,
   * against the policy (with the public mode's DNS check). Subresources get
   * the cheaper private-address check only: sites load them from CDNs on
   * any host, so a host list would break every page.
   *
   * Redirects are why this fetches instead of continuing: Playwright does
   * not route the request a followed redirect makes, so `continue()` let an
   * allowed URL 302 to any site (review #46). The document is fetched here
   * without following redirects and the target checked. An allowed
   * redirect is NOT handed to the browser as a 3xx either: tried first, and
   * the browser followed it unrouted, so allowed → allowed → disallowed
   * loaded the last page (the chain test). Instead the browser gets a
   * one-line document that replaces itself with the target: a new
   * navigation, which comes back through this guard. The redirect's own
   * headers (cookies) are kept.
   *
   * A blocked navigation is answered 204, not aborted: an abort replaces
   * the page with Chromium's error page (chrome-error://), a 204 leaves the
   * browser on the document it had.
   */
  const guard = async (route: Route, e: Entry) => {
    const r = route.request()
    // Subresources: only the private-address check (see allowsSubresource).
    // Aborted, not 204'd: nothing is showing them, and an abort is cheaper.
    if (!r.isNavigationRequest()) return (allowsSubresource(r.url(), policy) ? route.continue() : route.abort('blockedbyclient')).catch(() => undefined)
    // Refused in our page's main frame: remembered, so an open that fails on
    // it reports "host not allowed" instead of Chromium's net::ERR_ABORTED.
    // A popup's first request has no frame yet and `frame()` throws (review
    // #46 round 2: that throw escaped the route and crashed the server). The
    // try around the whole handler contains it: the request is aborted,
    // which for a popup we close anyway is as good as refused.
    const refuse = () => {
      if (r.frame() === e.page?.mainFrame()) e.blocked = true
      return route.fulfill({ status: 204 }).catch(() => undefined)
    }
    try {
      if (!(await allowsNavigation(r.url(), policy, resolve))) return await refuse()
      const res = await route.fetch({ maxRedirects: 0 })
      const location = res.headers()['location']
      if (res.status() >= 300 && res.status() < 400 && location) {
        const next = new URL(location, r.url()).href
        if (!(await allowsNavigation(next, policy, resolve))) return await refuse()
        // Only the redirect's cookies carry over. Its other headers describe
        // a response that no longer exists: a CSP kept here blocked this
        // document's own script, and the page stuck blank (review #46 round 2).
        const headers: Record<string, string> = {}
        const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value)
        if (cookies.length) headers['set-cookie'] = cookies.join('\n')
        // `<` escaped so a URL can't close the script element.
        const target = JSON.stringify(next).replace(/</g, '\\u003c')
        return await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><script>location.replace(${target})</script>` })
      }
      return await route.fulfill({ response: res })
    } catch {
      // Nothing in here may reject: a route handler's rejection is unhandled
      // and takes the whole server (and the demo) down.
      return route.abort().catch(() => undefined)
    }
  }

  /**
   * Builds the page behind `e`, step by step, checking after every await that
   * `e` is still wanted. Throws Cancelled when it isn't, after disposing
   * what it made.
   */
  const build = async (id: string, e: Entry, url: string) => {
    const check = async () => {
      if (e.live && pages.get(id) === e && !shut) return
      await dispose(e)
      await closeIdleBrowser()
      throw new Cancelled('closed while opening')
    }
    const b = await ensureBrowser()
    await check()
    e.context = await b.newContext({ viewport: { width: e.size.w, height: e.size.h }, deviceScaleFactor: 1 })
    await check()
    await e.context.route('**/*', (route) => guard(route, e))
    const page = await e.context.newPage()
    e.page = page
    await check()
    // Popups (window.open, target=_blank) are closed on sight: the host
    // tracks one page per surface, and a second page is something nobody
    // sees but that still runs (review #46). Their requests went through
    // the context's guard too, so they never showed a disallowed site.
    page.on('popup', (p) => void p.close().catch(() => undefined))
    // The page can move by itself (a client-side redirect, a search that
    // loads results): its url and title are published as they change, not
    // only after one of our ops (review #46). A main-frame document outside
    // the list (which the guard should have stopped) is left for a blank page.
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return
      const u = f.url()
      if (u !== 'about:blank' && !allowsUrl(u, policy)) {
        setState(id, e, { status: 'error', error: 'host not allowed' })
        void page.goto('about:blank').catch(() => undefined)
        return
      }
      setState(id, e, { url: u })
    })
    page.on('domcontentloaded', () => {
      void page
        .title()
        .then((title) => setState(id, e, { title }))
        .catch(() => undefined)
    })
    e.cdp = await e.context.newCDPSession(page)
    await check()
    // Chromium's own screencast: a JPEG per repaint, nothing while the page
    // is still. It runs while the page is open (not only while someone
    // watches) so a viewer that joins later gets the latest frame at once.
    e.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      const jpeg = Buffer.from(data, 'base64')
      e.frame = jpeg
      broadcast(e, jpeg)
      void e.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
    })
    await e.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: e.size.w, maxHeight: e.size.h })
    await check()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: openMs })
    await check()
    // A blocked redirect leaves the browser where it was, which on a first
    // load is about:blank: "ready" would put an empty white box on the
    // table, so it is reported as what it is.
    if (!allowsUrl(page.url(), policy)) throw new Error('host not allowed')
    return page.title()
  }

  /**
   * Runs one input op under a deadline. Ops on one page run strictly one
   * after another: a deadline can't cancel a Playwright call already under
   * way, so an op that timed out may still finish, and without the queue it
   * would interleave with the next one (two texts typed into one another,
   * review #46). A failed op is the caller's error, not the page's: the page
   * is still there, so the published state stays as it was.
   */
  const op = async (id: string, what: string, ms: number, fn: (page: Page, e: Entry, alive: () => boolean) => Promise<unknown>): Promise<WebState | null> => {
    const e = pages.get(id)
    if (!e) return null
    const page = e.page
    if (!page) return e.state // still opening, or failed: nothing to drive
    // Expired: an op reported failed must not act later (review #46 round
    // 2: a scroll whose mouse move stalled still wheeled the page once the
    // move finished). A Playwright call already under way can't be stopped,
    // so ops check this between their steps, and one still queued when it
    // expires never starts.
    let expired = false
    const alive = () => !expired && e.live
    const run = e.chain.then(() => (alive() ? fn(page, e, alive) : undefined))
    e.chain = run.catch(() => undefined)
    try {
      await withDeadline(run, ms, what).catch((err) => {
        expired = true
        throw err
      })
      const title = await withDeadline(page.title(), inputMs, 'title').catch(() => e.state.title)
      if (pages.get(id) === e) setState(id, e, { status: 'ready', url: page.url(), title })
      return e.state
    } catch (err) {
      return { ...e.state, status: 'error', error: message(err) }
    }
  }

  return {
    /** Open (or replace) the page behind surface `id` at `size` projector px. Never throws; the result is also published. */
    async open(id: string, url: string, size: { w: number; h: number }): Promise<WebState> {
      if (!allowsUrl(url, policy)) return { url, title: '', status: 'error', error: 'host not allowed' }
      if (shut) return { url, title: '', status: 'error', error: 'host shut down' }
      // Registered before the first await (review #46): from here a stream
      // request or a close for `id` finds this entry.
      const old = pages.get(id)
      const e: Entry = {
        live: true,
        context: null,
        page: null,
        cdp: null,
        size: { w: Math.max(200, Math.min(4000, Math.round(size.w))), h: Math.max(150, Math.min(4000, Math.round(size.h))) },
        state: { url, title: '', status: 'loading' },
        frame: null,
        viewers: new Set(old?.viewers ?? []),
        chain: Promise.resolve(),
        blocked: false,
      }
      // Viewers of a replaced page stay connected and get the new page's frames.
      old?.viewers.clear()
      pages.set(id, e)
      if (old) void dispose(old)
      opts.onState?.(id, e.state)
      try {
        // One deadline for all of it, browser start included: the HTTP
        // route that awaits this is bounded by openMs, not by each step's
        // own budget added up (review #46).
        const title = await withDeadline(build(id, e, url), openMs, 'open')
        setState(id, e, { status: 'ready', url: e.page?.url() ?? url, title })
      } catch (err) {
        if (err instanceof Cancelled || pages.get(id) !== e) return e.state
        // Timed out or failed: the entry stays, in error, so the surface says
        // so; whatever the build made is freed, and its late steps see
        // live=false and free what they make after this.
        setState(id, e, { status: 'error', error: e.blocked ? 'host not allowed' : message(err) })
        e.live = false
        const ctx = e.context
        e.context = null
        e.page = null
        if (ctx) void withDeadline(ctx.close(), inputMs, 'close').catch(() => undefined)
      }
      return e.state
    },

    close,
    click: (id: string, x: number, y: number) => op(id, 'click', inputMs, async (page) => {
      // A click that navigates: listen BEFORE clicking, or the state is read
      // while the old document is still current (waitForLoadState returns
      // at once for the page already loaded). Most clicks don't navigate, so
      // the wait for one is short.
      // Well inside the op's own deadline: ops are queued, and a wait
      // outliving its op held up every input behind it (a short budget's
      // click kept the next type queued past its deadline, so it never
      // ran); and a wait as long as the deadline made every click that
      // didn't navigate report a timeout.
      const navigated = page.waitForEvent('framenavigated', { timeout: Math.min(600, inputMs / 2) }).catch(() => undefined)
      await page.mouse.click(x, y)
      await navigated
      await page.waitForLoadState('domcontentloaded', { timeout: inputMs }).catch(() => undefined)
    }),
    scroll: (id: string, dy: number) => op(id, 'scroll', inputMs, async (page, e, alive) => {
      // The wheel scrolls whatever is under the pointer: aim at the middle.
      await page.mouse.move(e.size.w / 2, e.size.h / 2)
      if (alive()) await page.mouse.wheel(0, dy)
    }),
    // A character at a time, so an expired type stops where it is instead
    // of typing the rest of its text later (at most 500 characters).
    type: (id: string, text: string) => op(id, 'type', inputMs, async (page, _e, alive) => {
      for (const ch of text) {
        if (!alive()) return
        await page.keyboard.type(ch)
      }
    }),
    key: (id: string, key: (typeof WEB_KEYS)[number]) => op(id, 'key', inputMs, (page) => page.keyboard.press(key)),
    back: (id: string) => op(id, 'back', inputMs, (page) => page.goBack({ waitUntil: 'domcontentloaded', timeout: inputMs })),
    forward: (id: string) => op(id, 'forward', inputMs, (page) => page.goForward({ waitUntil: 'domcontentloaded', timeout: inputMs })),
    async navigate(id: string, url: string): Promise<WebState | null> {
      const e = pages.get(id)
      if (!e) return null
      if (!allowsUrl(url, policy)) return { ...e.state, status: 'error', error: 'host not allowed' }
      return op(id, 'navigate', openMs, (page) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: openMs }))
    },

    /**
     * MJPEG of the page behind `id`, for an <img>. Works from the moment the
     * open starts: a viewer that connects while the browser is starting
     * gets the frames once they come. Returns false for an unknown id.
     */
    stream(id: string, res: ExpressResponse): boolean {
      const e = pages.get(id)
      if (!e) return false
      res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      // The opening boundary: every frame then closes its own part (sendFrame).
      res.write(`--${BOUNDARY}\r\n`)
      e.viewers.add(res)
      // Twice: Chrome draws a part only once the next one starts (see
      // broadcast), so a viewer joining a still page needs the copy to see it.
      if (e.frame) {
        sendFrame(res, e.frame)
        sendFrame(res, e.frame)
      }
      // The viewer set can be handed to a replacing entry; drop it from
      // whichever entry holds it now.
      res.on('close', () => pages.get(id)?.viewers.delete(res))
      return true
    },
    state: (id: string): WebState | null => pages.get(id)?.state ?? null,
    /** Ids with an open (or opening) page, so the surface set can close the ones it no longer has. */
    ids: (): string[] => [...pages.keys()],
    /** The latest frame (tests, diagnostics). */
    frame: (id: string): Buffer | null => pages.get(id)?.frame ?? null,
    /** The page itself, for tests and diagnostics only; the product goes through the methods above. */
    inspect: (id: string): Page | null => pages.get(id)?.page ?? null,
    browser: () => browser,
    async shutdown() {
      shut = true
      for (const id of [...pages.keys()]) await close(id)
      if (browser) await browser.close().catch(() => undefined)
      browser = null
    },
  }
}

export type WebHost = ReturnType<typeof createWebHost>
