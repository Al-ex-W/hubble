// Named devServerKeys, not vite.config.test: vitest excludes **/vite.config.* by default.
import http from 'node:http'
import https from 'node:https'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ViteDevServer } from 'vite'

/**
 * The dev server must never hand out a private key (Codex review of #95,
 * finding 1: `GET /@fs/<repo>/.hubble/tls/ca.key` returned the CA's key over
 * http and https). Starts the REAL vite.config.ts on a free loopback port and
 * asks for the files the way an attacker on the LAN would.
 *
 * Label: schema-derived (Vite's own /@fs/ URL scheme). Oracle: the HTTP
 * status and body Node's own clients receive, never the config's lists.
 * The probe files are throwaway text written by this test, never real keys.
 */
const repo = resolve(__dirname, '../..')
const tlsDir = mkdtempSync(join(tmpdir(), 'hubble-vite-tls-'))
// Probes inside the repo (gitignored dirs; removed in afterAll).
const probeId = `vite-deny-${process.pid}-${Date.now()}`
const hubbleProbe = join(repo, '.hubble', probeId)
const tempProbe = join(repo, 'temp', probeId)
let server: ViteDevServer
let port = 0
let ca = ''

const get = (path: string, tls = false) =>
  new Promise<{ status: number; body: string }>((done, fail) => {
    const mod = tls ? https : http
    mod
      .get({ host: '127.0.0.1', port, path, agent: false, ...(tls ? { ca, servername: 'localhost' } : {}) }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => done({ status: res.statusCode ?? 0, body }))
      })
      .on('error', fail)
  })

beforeAll(async () => {
  mkdirSync(hubbleProbe, { recursive: true })
  mkdirSync(tempProbe, { recursive: true })
  // The exact layout that leaked: <repo>/.hubble/tls/ca.key, as text.
  mkdirSync(join(hubbleProbe, 'tls'), { recursive: true })
  writeFileSync(join(hubbleProbe, 'tls', 'ca.key'), 'PROBE-NOT-A-KEY')
  writeFileSync(join(tempProbe, 'leaf.key'), 'PROBE-NOT-A-KEY')
  writeFileSync(join(tempProbe, 'plain.txt'), 'PROBE-PLAIN')
  process.env.HUBBLE_TLS_DIR = tlsDir
  const { createServer } = await import('vite')
  server = await createServer({
    configFile: resolve(__dirname, 'vite.config.ts'),
    root: __dirname,
    logLevel: 'silent',
    // Port 0 and loopback: a test must not take :5173 or listen on the LAN.
    server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  await server.listen()
  port = (server.httpServer!.address() as AddressInfo).port
  ca = readFileSync(join(tlsDir, 'ca.crt'), 'utf8')
}, 60_000)

afterAll(async () => {
  await server?.close()
  delete process.env.HUBBLE_TLS_DIR
  rmSync(hubbleProbe, { recursive: true, force: true })
  rmSync(tempProbe, { recursive: true, force: true })
  rmSync(tlsDir, { recursive: true, force: true })
})

describe('the dev server and private keys', () => {
  it('serves an ordinary repo file through /@fs (the control: the probes are reachable at all)', async () => {
    // Without this control, every 403 below could just mean "wrong URL".
    const r = await get(`/@fs${join(tempProbe, 'plain.txt')}`)
    expect(r.status).toBe(200)
    expect(r.body).toContain('PROBE-PLAIN')
  })

  it('refuses <repo>/.hubble/**/ca.key over http and https', async () => {
    // Break caught: finding 1 itself. Remove `**/.hubble/**` AND `*.key`
    // from FS_DENY (or drop fs.deny, which falls back to Vite's default
    // list that has no *.key) and this returns 200 with the key's text.
    for (const tls of [false, true]) {
      const r = await get(`/@fs${join(hubbleProbe, 'tls', 'ca.key')}`, tls)
      expect(r.status, `tls=${tls}`).toBe(403)
      expect(r.body).not.toContain('PROBE-NOT-A-KEY')
    }
  })

  it('refuses any *.key file in the repo, outside .hubble too', async () => {
    // Break caught: a deny list covering only `.hubble/` (a key copied
    // anywhere else in the repo would be served).
    const r = await get(`/@fs${join(tempProbe, 'leaf.key')}`)
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('PROBE-NOT-A-KEY')
  })

  it('keeps the real CA key outside anything Vite serves, and still serves the CA certificate', async () => {
    // Break caught: the key directory moved back into the repo (or the
    // allow-list widened to $HOME). The real key must be unreachable, while
    // /hubble-ca.crt (public by design) still installs on the iPad.
    const key = readFileSync(join(tlsDir, 'ca.key'), 'utf8')
    const r = await get(`/@fs${join(tlsDir, 'ca.key')}`)
    expect(r.status).toBe(403)
    expect(r.body).not.toContain(key.split('\n')[1]!)
    const crt = await get('/hubble-ca.crt')
    expect(crt.status).toBe(200)
    expect(crt.body).toBe(ca)
    expect(crt.body).not.toContain('PRIVATE KEY')
  })
})
