import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** Same-service snapshots, not independently aligned captures. This records the
 * evidence needed to study delays without ever inventing a common sensor clock.
 * A take still needs an independently annotated video to establish contact truth.
 * No room endpoint is written; no producer or projector is started by recording. */
const [path, duration = '15', base = 'http://127.0.0.1:8787'] = process.argv.slice(2)
const seconds = Number(duration)
if (!path || !Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('Usage: npm run spatial:record -- take.jsonl [seconds 1–60] [server URL]')
const fd = openSync(path, 'wx')
let manifest: number
try {
  manifest = openSync(`${path}.manifest.json`, 'wx')
} catch (e) {
  closeSync(fd)
  throw e
}
const hash = createHash('sha256')
let samples = 0
const start = performance.now()
try {
  while (performance.now() - start < seconds * 1000) {
    const r = await fetch(new URL('/api/spatial', base), { signal: AbortSignal.timeout(2000) })
    if (!r.ok) throw new Error(`Spatial service HTTP ${r.status}`)
    const row = JSON.stringify({ receivedAtEpochMs: Date.now(), state: await r.json() }) + '\n'
    writeSync(fd, row)
    hash.update(row)
    samples++
    await new Promise((r) => setTimeout(r, 100))
  }
} finally {
  closeSync(fd)
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        provenance: 'recording',
        schema: 'SpatialFrame/v2',
        samples,
        sha256: hash.digest('hex'),
        annotation: 'Unannotated; paired evidence is NOT independently verified contact truth',
        clock: 'Server monotonic receipts, browser capture progress and Pi epoch remain distinct',
      },
      null,
      2,
    ) + '\n',
  )
  closeSync(manifest)
}
console.log(JSON.stringify({ samples, path }))
