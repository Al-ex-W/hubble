// Puts MediaPipe's hand-tracking assets where the web app serves them
// (apps/web/public/mediapipe/), so the hand tracker works without internet:
// the room's wifi may not reach the CDNs (#28). Run once per laptop, before
// the demo: `npm run hands:assets`. The files are gitignored (~8 MB model).
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'apps/web/public/mediapipe')
const wasm = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

mkdirSync(out, { recursive: true })
cpSync(wasm, join(out, 'wasm'), { recursive: true })
console.log(`copied the wasm runtime to ${join(out, 'wasm')}`)
const model = join(out, 'hand_landmarker.task')
if (existsSync(model)) console.log('model already there')
else {
  const res = await fetch(MODEL)
  if (!res.ok) throw new Error(`model download failed: ${res.status}`)
  writeFileSync(model, Buffer.from(await res.arrayBuffer()))
  console.log(`downloaded the hand model to ${model}`)
}
