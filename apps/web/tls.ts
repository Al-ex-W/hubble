import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls'
import type { Plugin } from 'vite'

/**
 * HTTPS on :5173, WITHOUT taking plain HTTP away (#91).
 *
 * Why at all: the iPad page (/ipad-camera) needs getUserMedia, and iOS Safari
 * only grants the camera in a secure context: https, or localhost. The iPad
 * reaches the laptop at http://<LAN IP>:5173, which is neither.
 *
 * Why not just `server.https` in Vite: that makes :5173 https-only, and the
 * projector Pi's kiosk opens http://<laptop>:5173/table. It would stop
 * loading the moment we switched (and its Chromium wouldn't trust our cert
 * anyway). A second port for https breaks the one-port rule (owner, 7 Oct:
 * "we only have a 5173 and not the other port situation").
 *
 * So one listener speaks both: every new TCP connection's first byte says
 * which. A TLS handshake always starts with a record of type 22 (0x16,
 * "handshake"); an HTTP request starts with a method name in ASCII (G, P,
 * H, O, D…), never 0x16. A TLS connection is wrapped in a server-side
 * TLSSocket and handed to the SAME http.Server, so Vite's middlewares, its
 * proxy (/api, /worksheet) and its HMR websocket all work identically over
 * both. This is the httpolyglot trick, written out here because it is 20
 * lines and a dependency for it would be another thing to audit.
 *
 * Why our own CA and not a self-signed leaf: iOS Safari REJECTS an untrusted
 * self-signed certificate outright, without the "visit anyway" button other
 * browsers show (Kurento docs, "Self-Signed Certificates"). The route Apple
 * documents is a root CA installed as a profile, then given full trust in
 * Settings → General → About → Certificate Trust Settings (HT204477). So: one
 * CA, made once and kept for its CA_DAYS (the iPad trusts it once), and a leaf re-made at
 * every start for the laptop's CURRENT addresses: the laptop changed IP on
 * 7 Oct (.18 → .39), and a leaf for the old IP would fail on the iPad with
 * a name mismatch while still looking "installed".
 */

/** The page the iPad opens to install our CA (over plain http: a CA certificate is public). */
export const CA_PATH = '/hubble-ca.crt'

/**
 * Hand every TLS connection on `server` to its own request handling, and
 * every plain one through untouched. Must run before `listen` gets traffic;
 * http.Server registers its parser as a 'connection' listener at
 * construction, and that listener is what both kinds end up in.
 */
export function serveTlsToo(server: Server, context: SecureContext): void {
  const handlers = server.listeners('connection') as ((socket: unknown) => void)[]
  server.removeAllListeners('connection')
  server.on('connection', (socket: import('node:net').Socket) => {
    // 'data' rather than read(1): the first chunk is whatever arrived, and
    // it goes straight back (unshift) so neither parser misses a byte.
    socket.once('data', (first: Buffer) => {
      socket.pause()
      socket.unshift(first)
      const target = first[0] === 0x16 ? new TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'] }) : socket
      for (const h of handlers) h.call(server, target)
      // The parser attached its own 'data' listener; resume the raw flow.
      // For a TLSSocket the raw socket is driven by the TLS layer itself.
      if (target === socket) socket.resume()
    })
    // A client that connects and never speaks (a port scan) must not hang an error.
    socket.on('error', () => socket.destroy())
  })
}

/** Every address someone on the LAN might type for this laptop. */
export function lanNames(): { ips: string[]; dns: string[] } {
  const ips = new Set(['127.0.0.1'])
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) ips.add(a.address)
  const host = hostname()
  // Only `localhost` and the mDNS name: those are the names the CA's name
  // constraints permit (see CA_CONSTRAINTS). A bare hostname isn't
  // resolvable from the iPad anyway; the README has it type the IP.
  return { ips: [...ips], dns: ['localhost', host.endsWith('.local') ? host : `${host}.local`] }
}

/**
 * Where the CA and leaf keys live: OUTSIDE the repo, in the user's own
 * per-app config directory.
 *
 * Why (Codex review of #95, finding 1, reproduced): they used to live in
 * `<repo>/.hubble/tls/`, and Vite's `server.fs.allow` is the repo root (the
 * notebook fixtures live there), while Vite's default `fs.deny` only covers
 * `.env*`, `*.{crt,pem}` and `.git`. So `GET /@fs/<repo>/.hubble/tls/ca.key`
 * handed the CA's PRIVATE key to anyone on the venue Wi-Fi, over http and
 * https alike. With that key anyone can mint a certificate for any name the
 * iPad would then trust. A directory no Vite root or allow-list can reach
 * is the structural fix; the explicit deny list in vite.config.ts is the
 * second layer, in case someone points this back into the repo.
 *
 * `HUBBLE_TLS_DIR` overrides it (tests use a temp dir). The shapes are each
 * OS's own convention for per-user app state, not a dotfile in $HOME, so
 * it's obvious what owns it when someone goes looking.
 */
export function defaultTlsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.HUBBLE_TLS_DIR) return env.HUBBLE_TLS_DIR
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Hubble', 'tls')
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Hubble', 'tls')
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'hubble', 'tls')
}

/** Is `dir` the same as, or inside, `root`? Plain path arithmetic. */
export function isInside(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const run = (args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] })

// How long the CA lives, and how close to its end it is re-made. Ruling
// (review of #95): 30 days, not the 10 years it had. The CA is a root the
// iPad trusts fully, so its key is the most valuable file we have; a short
// life bounds what a leaked key (as happened, finding 1) is worth. The cost
// is re-trusting it on the iPad about once a month, which a demo week never
// reaches. Re-made 2 days before the end so a start on the last day doesn't
// hand out a chain that dies mid-demo.
export const CA_DAYS = 30
const CA_RENEW_SECONDS = 2 * 86400
// The leaf can't usefully outlive its CA, and it is re-made at every start.
const LEAF_DAYS = 30

/**
 * What the CA may sign for (RFC 5280 name constraints): loopback, the
 * private IPv4 ranges a LAN hands out, `localhost`, and mDNS `*.local`
 * names. With these, even a leaked CA key can't mint a certificate the iPad
 * would accept for a real site (a bank, apple.com): the iPad itself refuses
 * any chain whose leaf names fall outside them. `pathlen:0` likewise stops
 * the key from minting a sub-CA.
 *
 * Not yet verified on the iPad itself (no hardware window when this was
 * written): Apple's TLS stack honours name constraints, but the first
 * on-site install should confirm the page still loads (plan: Verification).
 */
const CA_CONSTRAINTS = [
  'permitted;IP:127.0.0.0/255.0.0.0',
  'permitted;IP:10.0.0.0/255.0.0.0',
  'permitted;IP:172.16.0.0/255.240.0.0',
  'permitted;IP:192.168.0.0/255.255.0.0',
  'permitted;DNS:localhost',
  'permitted;DNS:local',
]

/** Whether a leaf name falls inside CA_CONSTRAINTS (so the chain verifies). */
export function permittedName(name: { ip?: string; dns?: string }): boolean {
  if (name.dns !== undefined) return name.dns === 'localhost' || name.dns.endsWith('.local')
  const o = (name.ip ?? '').split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return o[0] === 127 || o[0] === 10 || (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) || (o[0] === 192 && o[1] === 168)
}

/** True when the CA at `ca` is missing, unreadable, or ends within CA_RENEW_SECONDS. */
function caNeedsRenewal(ca: string, caKey: string): boolean {
  if (!existsSync(ca) || !existsSync(caKey)) return true
  try {
    // -checkend exits non-zero when the certificate expires within that many seconds.
    run(['x509', '-in', ca, '-noout', '-checkend', String(CA_RENEW_SECONDS)])
    return false
  } catch {
    return true
  }
}

/**
 * The CA (kept CA_DAYS, re-made near its end) and a fresh leaf for `names`.
 * Returns null when openssl isn't there: then :5173 stays plain http, and
 * the iPad page says it needs https instead of failing silently.
 *
 * Leaf parameters are iOS 13's TLS rules for a trusted server certificate:
 * RSA ≥ 2048, SHA-256, the names in subjectAltName (iOS ignores the CN),
 * extendedKeyUsage serverAuth, and a validity of at most 825 days.
 */
export function ensureCertificate(dir: string, names = lanNames()): { key: string; cert: string; ca: string } | null {
  try {
    // 0700: the keys are this user's alone, whatever the umask.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const ca = join(dir, 'ca.crt')
    const caKey = join(dir, 'ca.key')
    if (caNeedsRenewal(ca, caKey)) {
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', String(CA_DAYS), '-sha256', '-subj', '/CN=Hubble local CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', `nameConstraints=critical,${CA_CONSTRAINTS.join(',')}`])
      chmodSync(caKey, 0o600)
    }
    const key = join(dir, 'leaf.key')
    const csr = join(dir, 'leaf.csr')
    const cert = join(dir, 'leaf.crt')
    const ext = join(dir, 'leaf.ext')
    // A name outside the constraints would make the iPad reject the WHOLE
    // chain, not just that name, so it is left out (a laptop on a public
    // IP gets https on its private ones only).
    const ips = names.ips.filter((ip) => permittedName({ ip }))
    const dns = names.dns.filter((d) => permittedName({ dns: d }))
    const dropped = [...names.ips.filter((i) => !ips.includes(i)), ...names.dns.filter((d) => !dns.includes(d))]
    if (dropped.length) console.warn(`[tls] not in the certificate (outside the CA's name constraints): ${dropped.join(', ')}`)
    const san = [...ips.map((i) => `IP:${i}`), ...dns.map((d) => `DNS:${d}`)].join(',')
    writeFileSync(ext, `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n`)
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=hubble'])
    chmodSync(key, 0o600)
    run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', String(LEAF_DAYS), '-sha256', '-extfile', ext])
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8'), ca: readFileSync(ca, 'utf8') }
  } catch (e) {
    console.warn(`[tls] no https on :5173 (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); the iPad camera page needs it`)
    return null
  }
}

/**
 * The Vite side: both protocols on the dev server's own listener, and the CA
 * download. `servable` is every directory Vite may serve files from (its
 * root and fs.allow): a key directory inside one is refused outright, so
 * the leak of finding 1 can't come back by someone pointing `dir` at the
 * repo again.
 */
export function httpsToo(dir: string, servable: string[] = []): Plugin {
  return {
    name: 'hubble-https-too',
    configureServer(server) {
      const exposed = [...servable, server.config.root, ...server.config.server.fs.allow].find((root) => isInside(dir, root))
      if (exposed) {
        console.warn(`[tls] refusing https: the key directory ${dir} is inside ${exposed}, which Vite can serve. Use the default (${defaultTlsDir()}) or HUBBLE_TLS_DIR outside the repo.`)
        return
      }
      const tls = ensureCertificate(dir)
      if (!tls || !server.httpServer) return
      serveTlsToo(server.httpServer as unknown as Server, createSecureContext({ key: tls.key, cert: tls.cert }))
      const names = lanNames()
      console.log(`[tls] https on the same port: https://${names.ips.find((i) => i !== '127.0.0.1') ?? 'localhost'}:${server.config.server.port ?? 5173}/ipad-camera (CA: ${CA_PATH}, keys in ${dir})`)
      server.middlewares.use(CA_PATH, (_req, res) => {
        // This content type is what makes iOS Safari offer "install profile".
        res.setHeader('Content-Type', 'application/x-x509-ca-cert')
        res.setHeader('Content-Disposition', 'attachment; filename="hubble-ca.crt"')
        res.end(tls.ca)
      })
    },
  }
}
