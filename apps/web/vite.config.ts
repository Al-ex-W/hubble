import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { WORKSHEET_PATH, worksheetProxy } from './worksheetProxy.ts'
import { defaultTlsDir, httpsToo } from './tls.ts'

const repoRoot = resolve(__dirname, '../..')

/**
 * What Vite must never serve, even inside fs.allow (the repo root).
 *
 * Why explicit: setting `fs.deny` REPLACES Vite's default list, and that
 * default (`.env`, `.env.*`, `*.{crt,pem}`, `.git`) never covered `*.key`.
 * That gap is how `/@fs/<repo>/.hubble/tls/ca.key` served the CA's private
 * key to the LAN (Codex review of #95, finding 1). So: the defaults again,
 * plus every key-ish extension, plus `.hubble/` whole (calibration, on-site
 * recordings, and formerly the keys: nothing a browser needs, and the
 * runtime's own state). The keys themselves now live outside the repo
 * (tls.ts defaultTlsDir); this list is the second layer. Pinned by
 * devServerKeys.test.ts, which starts this config and asks for the files.
 */
export const FS_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,csr,srl}', '**/.git/**', '**/.hubble/**']

// The dev server proxies /api to the Express backend so the browser only ever
// talks to one origin. That keeps the API keys (the LLM, Jev, ElevenLabs) on the
// server: the client code never sees a credential.
//
// `--mode studio` (npm run dev:studio / build:studio) is the owner's Liquid
// Studio entry: it serves studio.html at /studio, /studio/projector and /lab, so UI
// work needs neither the room, the brain nor the bench.
export default defineConfig(({ mode }) => ({
  plugins: [react(), httpsToo(defaultTlsDir(), [repoRoot]), ...(mode === 'studio' ? [{
    name: 'studio-entry',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use((request, _response, next) => {
        const path = request.url?.split('?')[0]
        // /lab shares the studio entry (studioMain.tsx picks the page by path).
        if (path === '/studio' || path === '/studio/projector' || path === '/lab' || path === '/tv') request.url = '/studio.html'
        next()
      })
    },
  }] : [])],
  ...(mode === 'studio' ? {
    optimizeDeps: { entries: ['studio.html'], include: ['js-aruco2', 'js-aruco2/src/dictionaries/aruco_4x4_1000.js'] },
    build: { rollupOptions: { input: resolve(__dirname, 'studio.html') } },
  } : { optimizeDeps: { include: ['js-aruco2', 'js-aruco2/src/dictionaries/aruco_4x4_1000.js'] } }),
  server: {
    port: 5173,
    // The room's Pis load our pages over the room network, so listen on every
    // interface, not only localhost (spec: bind 0.0.0.0, use the laptop's IP).
    host: '0.0.0.0',
    // Notebook fixtures live at the repo root, outside the Vite root
    // (apps/web), so the dev server must be allowed to read them.
    fs: {
      allow: [repoRoot],
      deny: FS_DENY,
    },
    proxy: {
      '/api': {
        target: process.env.HUBBLE_API_URL ?? 'http://localhost:8787',
        changeOrigin: true,
      },
      // The bench's view of the room emulator (development only). The port
      // follows EMULATOR_PORT, the emulator's own variable, so an isolated
      // rehearsal stack (another agent's, on spare ports) proxies to ITS
      // emulator instead of whichever one sits on the default 8790.
      '/emulator': {
        target: `http://localhost:${process.env.EMULATOR_PORT ?? 8790}`,
        changeOrigin: true,
      },
      // The iPad worksheet, read-only (worksheetProxy.ts says why). The port
      // is the worksheet server's, which only the laptop can reach.
      [WORKSHEET_PATH]: worksheetProxy(Number(process.env.WORKSHEET_PORT ?? 8793)),
    },
  },
}))
