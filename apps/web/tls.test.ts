import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSecureContext } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultTlsDir, ensureCertificate, httpsToo, isInside, serveTlsToo } from './tls.ts'

/**
 * The one-port HTTP + HTTPS listener (label: schema-derived, the two
 * protocols' own first bytes). Oracle: Node's own http/https clients and
 * openssl's own reading of the certificate, never tls.ts's helpers.
 */
const dir = mkdtempSync(join(tmpdir(), 'hubble-tls-'))
const cert = ensureCertificate(dir, { ips: ['127.0.0.1', '192.168.42.39'], dns: ['localhost'] })
let server: http.Server
let port = 0

const get = (mod: typeof http | typeof https, opts: https.RequestOptions) =>
  new Promise<string>((resolve) => {
    mod
      .get({ host: '127.0.0.1', port, path: '/', agent: false, ...opts }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve(body))
      })
      .on('error', (e) => resolve(`error: ${e.message}`))
  })

beforeAll(async () => {
  server = http.createServer((req, res) => res.end((req.socket as { encrypted?: boolean }).encrypted ? 'tls' : 'plain'))
  serveTlsToo(server, createSecureContext({ key: cert!.key, cert: cert!.cert }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
afterAll(() => server.close())

describe('https and http on one port', () => {
  it('answers a plain request AND a TLS one on the same listener', async () => {
    // Break caught: the projector Pi's kiosk opens http://…:5173/table. If
    // the listener went TLS-only (Vite's server.https), the projector page
    // would stop loading the moment the iPad got its camera. And if the TLS
    // branch is removed, the iPad can't reach a secure context at all.
    expect(await get(http, {})).toBe('plain')
    expect(await get(https, { ca: cert!.ca })).toBe('tls')
    // Several in a row: the first-byte peek must not lose a byte for either parser.
    for (let i = 0; i < 3; i++) expect(await get(https, { ca: cert!.ca })).toBe('tls')
    expect(await get(http, {})).toBe('plain')
  })

  it('serves a leaf the CA signed, for the LAN IP, the way iOS requires', () => {
    // Break caught: a leaf missing the laptop's current IP (it changed on
    // 7 Oct), or without serverAuth, is refused by iOS Safari even with
    // our CA trusted; that failure only shows on the iPad.
    const text = execFileSync('openssl', ['x509', '-in', join(dir, 'leaf.crt'), '-noout', '-text'], { encoding: 'utf8' })
    expect(text).toContain('IP Address:192.168.42.39')
    expect(text).toContain('TLS Web Server Authentication')
    expect(text).toMatch(/Public-Key: \(2048 bit\)/)
    expect(text).toContain('sha256WithRSAEncryption')
    const verify = execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'leaf.crt')], { encoding: 'utf8' })
    expect(verify.trim()).toMatch(/: OK$/)
    // Validity ≤ 825 days (iOS 13+): dates parsed by openssl, not by us.
    const dates = execFileSync('openssl', ['x509', '-in', join(dir, 'leaf.crt'), '-noout', '-startdate', '-enddate'], { encoding: 'utf8' })
    const [start, end] = dates.trim().split('\n').map((l) => Date.parse(l.split('=')[1]!))
    expect((end! - start!) / 86400000).toBeLessThanOrEqual(825)
  })

  it('keeps the CA across restarts, so the iPad trusts it once', () => {
    // Break caught: a CA re-made at every start silently untrusts the iPad
    // after each `npm run dev`; the page would just fail to load on site.
    const again = ensureCertificate(dir, { ips: ['127.0.0.1'], dns: ['localhost'] })
    expect(again!.ca).toBe(cert!.ca)
    expect(again!.cert).not.toBe(cert!.cert)
  })
})

describe('the CA is worth little if its key leaks (review of #95, finding 1)', () => {
  const ossl = (args: string[]) => execFileSync('openssl', args, { encoding: 'utf8' })
  const caText = () => ossl(['x509', '-in', join(dir, 'ca.crt'), '-noout', '-text'])

  it('lives 30 days at most, not 10 years', () => {
    // Break caught: the old `-days 3650`. A leaked root the iPad trusts
    // fully would stay useful to an attacker for a decade. Dates parsed by
    // openssl, not by us.
    const dates = ossl(['x509', '-in', join(dir, 'ca.crt'), '-noout', '-startdate', '-enddate'])
    const [start, end] = dates.trim().split('\n').map((l) => Date.parse(l.split('=')[1]!))
    expect((end! - start!) / 86400000).toBeLessThanOrEqual(31)
  })

  it('cannot sign a sub-CA, nor a leaf for a public name', () => {
    // Break caught: pathlen or nameConstraints dropped from the CA. Then the
    // key can mint a certificate for any site (here 8.8.8.8 and apple.com),
    // and the iPad, trusting our root, would accept it. openssl's own
    // verify is the oracle: we sign with the CA key directly, bypassing
    // ensureCertificate's own name filter.
    expect(caText()).toMatch(/CA:TRUE, pathlen:0/)
    expect(caText()).toContain('X509v3 Name Constraints: critical')
    const evil = join(dir, 'evil')
    writeFileSync(`${evil}.ext`, 'subjectAltName=IP:8.8.8.8,DNS:apple.com\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n')
    ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${evil}.key`, '-out', `${evil}.csr`, '-subj', '/CN=apple.com'])
    ossl(['x509', '-req', '-in', `${evil}.csr`, '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', `${evil}.crt`, '-days', '1', '-sha256', '-extfile', `${evil}.ext`])
    expect(() => ossl(['verify', '-CAfile', join(dir, 'ca.crt'), `${evil}.crt`])).toThrow(/name constraint|permitted subtree/i)
    // And the real leaf (private IP + localhost) still verifies under the constraints.
    expect(ossl(['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'leaf.crt')]).trim()).toMatch(/: OK$/)
  })

  it('leaves a public IP out of the leaf rather than breaking the whole chain', () => {
    // Break caught: the leaf listing a name outside the constraints. iOS
    // then rejects the entire chain, private IPs included.
    const d2 = mkdtempSync(join(tmpdir(), 'hubble-tls-'))
    ensureCertificate(d2, { ips: ['127.0.0.1', '8.8.8.8'], dns: ['localhost', 'example.com'] })
    const text = execFileSync('openssl', ['x509', '-in', join(d2, 'leaf.crt'), '-noout', '-text'], { encoding: 'utf8' })
    expect(text).not.toContain('8.8.8.8')
    expect(text).not.toContain('example.com')
    expect(execFileSync('openssl', ['verify', '-CAfile', join(d2, 'ca.crt'), join(d2, 'leaf.crt')], { encoding: 'utf8' }).trim()).toMatch(/: OK$/)
  })

  it('keeps its keys outside the repo by default, and refuses a key dir Vite could serve', () => {
    // Break caught: the default moved back to <repo>/.hubble/tls (the leak),
    // or httpsToo's own guard removed so a misconfigured dir is used anyway.
    const repo = resolve(__dirname, '../..')
    expect(isInside(defaultTlsDir({}, 'darwin', '/Users/x'), '/Users/x/Library')).toBe(true)
    expect(isInside(defaultTlsDir({}, process.platform), repo)).toBe(false)
    expect(defaultTlsDir({ HUBBLE_TLS_DIR: '/tmp/k' })).toBe('/tmp/k')
    // Oracle: the filesystem. A guard that let it through would have
    // generated a CA (and its key) in this repo directory.
    const inRepo = join(repo, 'temp', `tls-guard-${process.pid}-${Date.now()}`)
    const plugin = httpsToo(inRepo, [repo])
    const fake = { config: { root: join(repo, 'apps/web'), server: { fs: { allow: [repo] }, port: 0 } }, httpServer: null, middlewares: { use: () => undefined } }
    ;(plugin.configureServer as (s: unknown) => void)(fake)
    expect(existsSync(join(inRepo, 'ca.key'))).toBe(false)
    rmSync(inRepo, { recursive: true, force: true })
  })
})
